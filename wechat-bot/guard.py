"""
护栏层：白名单、限流、去重、急停、发送日志。纯判断 + 落盘，绝不注入。

设计原则来自踩坑记录：任何一步不确定就 abort，宁可漏回一条，也不回错人。
所以这里每个 check 的默认结果都是「不放行」。
"""

import difflib
import json
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "bot-state.json")
STOP = os.path.join(HERE, "STOP")
LOG = os.path.join(HERE, "bot-log.jsonl")


def normalize(s):
    """只留汉字/字母/数字，去掉所有空白与标点，字母统一小写。

    Windows OCR 会在汉字之间插空格（'文件传输助手' 读成 '文 件 传 ． “'），
    不过这一关白名单永远匹配不上。
    字母折叠大小写：白名单里是单字母（如 'G'）时，模型/OCR 读成 'g' 会
    因为大小写差异直接判不匹配 —— 这类误判最冤。
    """
    if not s:
        return ""
    out = []
    for ch in s:
        if ch.isspace() or not ch.isalnum():
            continue
        out.append(ch.lower())
    return "".join(out)


def score(a, b):
    """闭集判别打分：difflib 55% + 字符集重叠 30% + 长度相似 15%。"""
    a, b = normalize(a), normalize(b)
    if not a or not b:
        return 0.0
    r = difflib.SequenceMatcher(None, a, b).ratio()
    sa, sb = set(a), set(b)
    overlap = len(sa & sb) / max(1, len(sa | sb))
    length = 1 - abs(len(a) - len(b)) / max(len(a), len(b))
    return 0.55 * r + 0.30 * overlap + 0.15 * length


def match_whitelist(name, whitelist, threshold=0.55, lead=0.12):
    """闭集判别：OCR/模型读到的名字 vs 白名单，返回命中的白名单原名，否则 None。

    白名单只有几个已知名字，判断「是哪一个」远比自由匹配容易。
    必须过阈值且领先第二名，否则宁可返回 None —— 漏回一条比回错人便宜。

    短名字（去标点后 ≤2 字）走完全一致：'G' 与 'GG'/'G7' 的相似度都能过
    阈值，模糊匹配会把别人当成 'G'。长名字才用打分。
    """
    if not name or not whitelist:
        return None
    n = normalize(name)
    for w in whitelist:
        wn = normalize(w)
        if len(wn) <= 2 and wn == n:
            return w
    scored = sorted(((score(name, w), w) for w in whitelist
                     if len(normalize(w)) > 2), key=lambda t: -t[0])
    if not scored:
        return None
    best, best_name = scored[0]
    if best < threshold:
        return None
    if len(scored) > 1 and best - scored[1][0] < lead:
        return None
    return best_name


def same_name(a, b, threshold=0.55):
    """判断两个名字是不是同一个会话（防点错人的闸门用）。

    短名字（≤2 字）必须完全一致：'G' 与 'GG' 的相似度能过阈值，
    模糊比对会把点错的会话当成目标。
    """
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return False
    if min(len(na), len(nb)) <= 2:
        return na == nb
    return score(a, b) >= threshold


DEFAULTS = {
    "whitelist": [],
    "blacklist": [],
    "whitelistThreshold": 0.55,
    "whitelistLead": 0.12,
    "pollSeconds": 3,
    "perChatIntervalSeconds": 20,
    "maxConsecutive": 3,
    "dedupeWindowSeconds": 60,
    "maxPerHour": 20,
    "dryRun": True,
    # 回复所有私聊（不看白名单）。群聊默认仍然跳过：群里的未读角标一样会亮，
    # 全回等于替用户在群里发言，比回错人更显眼。
    "replyToAll": False,
    "skipGroups": True,
}


def load_config(path=None):
    path = path or os.path.join(HERE, "bot-config.json")
    cfg = dict(DEFAULTS)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            cfg.update(json.load(f))
    return cfg


def stop_requested():
    """急停：STOP 文件存在即停。删掉才恢复。"""
    return os.path.exists(STOP)


def request_stop(reason):
    with open(STOP, "w", encoding="utf-8") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {reason}\n")


def clear_stop():
    if os.path.exists(STOP):
        os.remove(STOP)


def log_event(**fields):
    fields["ts"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(fields, ensure_ascii=False) + "\n")


class Guard:
    """每个会话的限流/去重状态，落盘到 bot-state.json。"""

    def __init__(self, cfg, state_path=None):
        self.cfg = cfg
        self.state_path = state_path or STATE
        self.state = {"chats": {}, "sentThisHour": []}
        if os.path.exists(self.state_path):
            try:
                with open(self.state_path, encoding="utf-8") as f:
                    self.state.update(json.load(f))
            except Exception:
                pass

    def save(self):
        tmp = self.state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.state_path)

    def _chat(self, chat):
        return self.state["chats"].setdefault(
            chat, {"lastSentAt": 0, "consecutive": 0, "recentTexts": []})

    def check(self, chat):
        """发送前闸门。返回 (放行?, 原因)。"""
        if stop_requested():
            return False, "stop-file"
        now = time.time()
        c = self._chat(chat)
        gap = now - c.get("lastSentAt", 0)
        need = self.cfg["perChatIntervalSeconds"]
        if gap < need:
            return False, f"per-chat-interval({gap:.0f}s<{need}s)"
        if c.get("consecutive", 0) >= self.cfg["maxConsecutive"]:
            return False, f"max-consecutive({c['consecutive']})"
        recent = [t for t in self.state.get("sentThisHour", [])
                  if now - t < 3600]
        self.state["sentThisHour"] = recent
        if len(recent) >= self.cfg["maxPerHour"]:
            return False, f"hourly-cap({len(recent)})"
        return True, ""

    def duplicate(self, chat, text):
        """同句去重。命中返回 True —— 调用方应当换种说法重新生成，而不是丢弃。"""
        c = self._chat(chat)
        cutoff = time.time() - self.cfg["dedupeWindowSeconds"]
        c["recentTexts"] = [t for t in c.get("recentTexts", [])
                            if t.get("at", 0) > cutoff]
        key = normalize(text)
        return any(normalize(t.get("text", "")) == key for t in c["recentTexts"])

    def record(self, chat, text):
        c = self._chat(chat)
        now = time.time()
        c["lastSentAt"] = now
        c["consecutive"] = c.get("consecutive", 0) + 1
        c["recentTexts"].append({"text": text, "at": now})
        c["recentTexts"] = c["recentTexts"][-20:]
        self.state.setdefault("sentThisHour", []).append(now)
        self.save()

    def reset_consecutive(self, chat):
        c = self._chat(chat)
        c["consecutive"] = 0
        self.save()

    def already_handled(self, chat, msg):
        """这条消息是不是已经回过了。

        没有这一层的话，未读角标在对方点开之前会一直在，每轮轮询都会
        重新回一遍同一句话。指纹 = 会话 + 最后一条消息文本。
        """
        c = self._chat(chat)
        return c.get("lastHandledMsg") == normalize(msg)

    def mark_handled(self, chat, msg):
        c = self._chat(chat)
        c["lastHandledMsg"] = normalize(msg)
        self.save()
