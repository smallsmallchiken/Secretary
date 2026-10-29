"""
主动发消息：隔一阵子主动找人说句话（不是回复，是自己想聊）。

频率和时间是这一层的全部重点，默认给得很保守：

  时间  activeHours [9, 22]    —— 只在这个时间段发，半夜绝不打扰
  条数  maxPerDay 2            —— 一天最多 2 条，多聊也怪
  间隔  minGapMinutes 180      —— 两条之间至少 3 小时
  冷却  perChatCooldownDays 3  —— 同一个人 3 天内最多被主动找一次

还有几条「别像发传单」的硬护栏：
  - 对方有未读就跳过：人家还没看你上一条，别再压一条
  - 最后一条是我发的、对方没回 -> 不追（连追 2 次没回就直接躺平）
  - 只在「最近 72 小时有一来一回」的私聊里挑人（targets 为空时），
    绝不主动找几年没说过话的联系人
  - STOP 文件存在时不动
  - 群聊一律不主动发（群里突然冒一句最招人烦）

状态落盘 proactive-state.json，进程重启不清零配额。
"""

import json
import os
import random
import time

import guard
import llm

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "proactive-state.json")

DEFAULTS = {
    "enabled": True,
    "activeHours": [9, 22],
    "maxPerDay": 2,
    "minGapMinutes": 180,
    "perChatCooldownDays": 3,
    "idleHours": 3,        # 跟这个人至少 3 小时没说话才主动找（刚聊完就别硬找）
    "targets": [],         # 会话显示名列表；空 = 自动从最近有来有回的私聊里挑
    "allowGroups": False,
    "startupDelayMinutes": 30,  # 刚启动别急着找人，先等一会儿
}

PROACTIVE_PROMPT = """现在是 {clock}。你要主动给对方发一条微信——不是回复他，是你自己想起他了，想找他说句话。

要求（这几条比人设优先）：
- 接着上次聊过的具体事说，或者分享一句自己刚遇到的破事/见闻，或者问一件具体的事
- 一句话，最多两句。像随手打出来的，不像开场白
- 禁止搭讪模板：「在吗」「最近怎么样」「好久不见」「忙吗」「在干嘛呢」「有空吗」
- 禁止问候式开场、禁止自我介绍、禁止解释你为什么发这条
- 不要用感叹号堆情绪，不要用 emoji 撑场面（最多一个）

合格的例子：
「上次你说的那个事后来咋样了」
「刚路过那家店 想起来你还欠我一顿」
「我手机又卡死了 你那破电脑还活着吗」
「今天这天 出门两分钟就废了」
不合格（太像客服/推动销）：
「嗨，最近过得怎么样呀？有什么新鲜事想跟我分享吗？」
「在吗？想找你聊聊天～」"""


def _now_clock():
    return time.strftime("%H:%M")


class Proactive:
    def __init__(self, bot, cfg):
        self.bot = bot
        merged = dict(DEFAULTS)
        merged.update(cfg.get("proactive") or {})
        self.cfg = merged
        self.state = self._load()
        # 每次启动都重新计时：刚开机/刚重启不要在几秒内就去敲人
        self.state["bootAt"] = time.time()

    # ---------------------------------------------------------------- 状态
    def _load(self):
        try:
            with open(STATE, encoding="utf-8") as f:
                s = json.load(f)
        except Exception:
            s = {}
        s.setdefault("day", "")
        s.setdefault("count", 0)
        s.setdefault("lastAt", 0)
        s.setdefault("chats", {})       # name -> 最后主动发的时间
        s.setdefault("unanswered", 0)   # 连续主动发了没人回的次数
        return s

    def _save(self):
        try:
            tmp = STATE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.state, f, ensure_ascii=False, indent=1)
            os.replace(tmp, STATE)
        except Exception:
            pass

    def _today(self):
        return time.strftime("%Y-%m-%d")

    def _count_today(self):
        if self.state.get("day") != self._today():
            self.state["day"] = self._today()
            self.state["count"] = 0
        return int(self.state.get("count") or 0)

    # ---------------------------------------------------------------- 判断
    def _in_hours(self):
        try:
            start, end = self.cfg["activeHours"]
            start, end = int(start), int(end)
        except Exception:
            return True
        h = time.localtime().tm_hour
        if start <= end:
            return start <= h < end
        return h >= start or h < end

    def due(self):
        """现在该不该考虑发一条。全部是本地判断，不花 token。"""
        if not self.cfg.get("enabled"):
            return False, "未开启"
        if guard.stop_requested():
            return False, "STOP"
        if not self._in_hours():
            return False, "不在时间段"
        now = time.time()
        gap = now - float(self.state.get("lastAt") or 0)
        if gap < self.cfg["minGapMinutes"] * 60:
            return False, "距上条不足"
        if self._count_today() >= int(self.cfg["maxPerDay"]):
            return False, "今日配额用完"
        if int(self.state.get("unanswered") or 0) >= 2:
            return False, "连发两条没人回，先躺平"
        boot = float(self.state.get("bootAt") or 0)
        if boot and now - boot < float(self.cfg.get("startupDelayMinutes", 30)) * 60:
            return False, "刚启动，先等等"
        return True, ""

    # ---------------------------------------------------------------- 选人
    # 公众号/系统号：给它们发消息没有任何意义，而且一眼假
    BOT_NAMES = ("微信团队", "服务通知", "订阅号", "腾讯新闻", "微信支付", "文件传输助手",
                 "折叠的群聊", "公众号", "微信运动", "微信安全中心")
    BOT_USERS = {"filehelper", "weixin", "fmessage", "medianote", "floatbottle",
                 "newsapp", "notifymessage", "qqmail", "qqsafe"}

    def _is_human(self, username, name):
        u = (username or "").lower()
        if u in self.BOT_USERS or u.startswith("gh_"):
            return False
        if u.endswith("@chatroom") and not self.cfg.get("allowGroups"):
            return False
        n = name or ""
        if any(b in n for b in self.BOT_NAMES):
            return False
        return True

    def _recent_sessions(self):
        """最近有来有回的**真人**私聊。

        判据三条，缺一不可：
          1. 72 小时内有消息（太久没聊的突然找人很怪）
          2. 最后一条是对方发的（我上一条还没人回 -> 别追）
          3. 最近 10 条里我自己也说过话（真的聊过，不是单向推送的公众号）
        另外排掉公众号/系统号，还有未读的会话（先让回复流程处理）。
        """
        out = []
        try:
            sessions = self.bot.db.get_sessions(limit=40) or []
        except Exception:
            return out
        cutoff = time.time() - 72 * 3600
        for s in sessions:
            u = s.get("username") or ""
            if not u or u == self.bot.me:
                continue
            name = self.bot.display_name(u)
            if not self._is_human(u, name):
                continue
            if int(s.get("unread") or 0) > 0:
                continue  # 有未读先让回复流程处理
            if (s.get("last_time") or 0) < cutoff:
                continue
            try:
                msgs = self.bot.db.get_messages(u, limit=10) or []
            except Exception:
                continue
            if not msgs:
                continue
            sender0 = msgs[0].get("sender_username") or ""
            if sender0 == self.bot.me or sender0 in self.bot.my_names:
                continue  # 最后一条是我发的，对方还没回
            talked = any((m.get("sender_username") or "") == self.bot.me
                         or (m.get("sender_username") or "") in self.bot.my_names
                         for m in msgs)
            if not talked:
                continue  # 只有对方在推，我从没回过
            out.append({"username": u, "name": name,
                        "last_time": s.get("last_time") or 0})
        return out

    def _resolve_targets(self):
        """targets 写了名字就用名字，没写就自动挑。"""
        named = [t for t in (self.cfg.get("targets") or []) if t]
        if not named:
            return self._recent_sessions()
        out = []
        for t in named:
            try:
                hits = self.bot.db.search_contact(t) or []
            except Exception:
                hits = []
            if not hits:
                guard.log_event(event="proactive-target-missing", target=t)
                continue
            best = hits[0]
            out.append({"username": best.get("username") or "",
                        "name": best.get("remark") or best.get("nick_name") or t,
                        "last_time": 0})
        return [x for x in out if x["username"]]

    def _ok_to_ping(self, c):
        cfg = self.cfg
        last = float(self.state["chats"].get(c["name"]) or 0)
        if time.time() - last < cfg["perChatCooldownDays"] * 86400:
            return False
        for bad in self.bot.cfg.get("blacklist") or []:
            if guard.score(c["name"], bad) >= 0.55:
                return False
        # 刚聊完别硬找：至少 idleHours 小时没说话
        if c.get("last_time"):
            if time.time() - float(c["last_time"]) < cfg["idleHours"] * 3600:
                return False
        return True

    def _pick(self):
        cands = [c for c in self._resolve_targets() if self._ok_to_ping(c)]
        if not cands:
            return None
        random.shuffle(cands)
        return cands[0]

    # ---------------------------------------------------------------- 生成
    def _history(self, c):
        try:
            msgs = self.bot.db.get_messages(c["username"], limit=10) or []
        except Exception:
            return ""
        import bot_db
        rows = []
        for m in msgs:
            content = bot_db.clean_content(m)
            if not content:
                continue
            sender = m.get("sender_username") or ""
            mine = sender == self.bot.me or sender in self.bot.my_names
            rows.append(("我" if mine else "对方", content))
        rows.reverse()
        return "\n".join(f"{who}: {c}" for who, c in rows)

    def _generate(self, c):
        import bot_db
        system = bot_db.build_system_prompt(self.bot.cfg, is_group=False)
        history = self._history(c)
        prompt = PROACTIVE_PROMPT.format(clock=_now_clock())
        if history:
            prompt += f"\n\n跟「{c['name']}」最近的聊天记录（旧 -> 新）：\n{history}"
        text, err = llm.generate(prompt, system=system, cfg=None, temperature=1.0)
        if not text or text.strip() == bot_db.SKIP_TOKEN:
            return None, err or "模型选择不发"
        return text, ""

    # ---------------------------------------------------------------- 触发
    def maybe_fire(self, live=True):
        ok, why = self.due()
        if not ok:
            return False
        c = self._pick()
        if not c:
            return False
        text, err = self._generate(c)
        if not text:
            guard.log_event(event="proactive-gen-failed", chat=c["name"], err=err)
            return False
        if not live:
            print(f"  [dry-run] 主动发给 {c['name']!r}：{text!r}", flush=True)
            return False
        try:
            r = self.bot.gui.send_msg(text, who=c["name"],
                                      verify=self.bot.cfg.get("sendVerify", False))
        except Exception as exc:
            guard.log_event(event="proactive-send-error", chat=c["name"],
                            err=f"{type(exc).__name__}: {exc}")
            return False
        print(f"  [主动] -> {c['name']!r}：{text!r}  ({r})", flush=True)
        guard.log_event(event="proactive-sent", chat=c["name"], reply=text)
        self.state["lastAt"] = time.time()
        self.state["count"] = self._count_today() + 1
        self.state["day"] = self._today()
        self.state["chats"][c["name"]] = time.time()
        self.state["unanswered"] = int(self.state.get("unanswered") or 0) + 1
        self._save()
        return True

    def note_reply(self, chat):
        """对方回话了 -> 清零「没人理」计数（说明主动发这条不算尬）。"""
        if int(self.state.get("unanswered") or 0):
            self.state["unanswered"] = 0
            self._save()
