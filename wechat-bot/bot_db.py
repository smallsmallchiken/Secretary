"""
微信自动回复（数据库版）。

读消息用 wechatauto-replica 的 WeChatDB 直接读本地加密数据库，而不是截图识别：
  - 未读数 unread 直接来自数据库，不用品牌红像素检测
  - 消息原文精确，不会有 OCR 错字
  - sender_username 直接区分「我」和「对方」，不用按气泡左右猜
发送用同一个库的 WeChatGUI（它会把微信的 UIA 树热激活，UIA 优先、OCR 兜底）。

人设是**这一套独立**的：和 QQ 机器人的傲娇萝莉（src/core/qq/bot.js）、
桌宠本体的性格（src/core/persona.js）都是分开的配置，互不影响。

用法（必须用 py312，wechatauto-replica 依赖的 winsdk 没有 3.13 的 wheel）：
  wechat-bot/py312/python.exe wechat-bot/bot_db.py status
  wechat-bot/py312/python.exe wechat-bot/bot_db.py once
  wechat-bot/py312/python.exe wechat-bot/bot_db.py watch --live
"""

import argparse
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import guard
import llm
import proactive

CONFIG = os.path.join(HERE, "bot-db-config.json")

PERSONA_DEFAULT = (
    "温柔、耐心、说话轻软。像认识很久的人在慢慢讲话：句子短而稳，"
    "不用网络热词，不咋咋呼呼，不催人。对方着急的时候先安抚一句再说事。")

# ---------------------------------------------------------------- 去 AI 味
# 参考 QQ 那套（src/core/qq/bot.js）的实践：规则越少越听话，few-shot 示范比
# 抽象要求管用得多，温度拉高。这里把「像人」拆成三块：怎么说话、不许说什么、
# 照着这些例子说。
STYLE_RULES = """怎么说话（这条比人设更优先）：
- 像手机上手打的一条消息，不是写给人看的文案。对方看不到标点都无所谓。
- 长短参差：有时就两三个字（「行」「就这」「真的假的」「笑死」「啊」），
  有时一两句。别每条都工整、都一个长度。
- 可以口头语、可以停顿、可以不完整，甚至有点语病。真人打字不完美。
- 要有情绪：嫌麻烦、好奇、敷衍、吐槽、急着走，都行。永远温和平稳最像 AI。

下面这些一律不许出现，出现了就重写：
- 客服腔：「您好」「请问有什么可以帮您」「感谢您的信任」
- AI 腔：「作为 AI」「我理解你的感受」「希望能帮到你」「有什么我可以做的」
- 关怀模板：「辛苦了」「多喝热水」「早点休息」「别太勉强」「要照顾好自己」
- 升华总结：「愿你」「加油哦」「相信你可以的」「一切都会好起来的」
- 甜腻语气词堆砌（「呀～」「哦～」「啦～」），一条里最多一个语气词
- 排比、对仗、「不仅…而且…」这类书面结构
- 每条都反问一句，或每条都顺手关心一下

照着这些例子找感觉（✗ 是 AI 腔，禁止）：
「在吗」→ ✓「说」/「咋」 ✗「我在的，请问有什么事吗」
「今天加班到十点」→ ✓「你们老板有病吧」/「十点？我还在躺」 ✗「辛苦啦，要注意休息哦」
「这电影好看吗」→ ✓「一般 别去」/「看一半睡了」 ✗「非常精彩，值得一看！」
「你是不是机器人」→ ✓「你才是」/「机器人能这么跟你说话？」 ✗「哈哈，我是真人哦」
「周末有空吗」→ ✓「干啥」/「看情况 咋了」 ✗「有的呢，周末我都有空，你想去哪里玩呀？」
「我感冒了」→ ✓「活该 谁让你吹空调」/「吃药没」 ✗「哎呀要好好照顾自己，多喝热水哦」
「谢谢啊」→ ✓「客气啥」/「嗯」 ✗「不客气，很高兴能帮到你！」

注意：温柔是态度，不是话术。人设温柔也可以说「吃药没」，但别说「多喝热水哦」。"""

# 格式硬约束：QQ 那套踩过的坑——模型爱输出 Markdown，微信里看到的就是一串星号。
FORMAT_RULES = """输出格式（硬性要求）：
- 只输出纯文本，禁止 **加粗**、*斜体*、`代码`、# 标题、> 引用、表格
- 禁止 - * + 1. 这类列表符号，要列举就写成一句话用「、」隔开
- 一般一到两句话，不要小作文
- 只输出要发的那句话本身，不要解释、不要引号、不要前缀、不要括号里的动作"""

GROUP_RULES = """你现在在一个微信群里。看群聊记录时注意：
- 每行开头方括号里的只是说话人名字，唯一作用是分清谁在说，别拿它称呼人、
  别根据它猜性别年龄身份、也别评论这些名字
- 群友之间互相对聊、没你什么事的时候，别插嘴，直接输出 [SKIP]
- 只有被 @、被点名、别人在接你的话、或明确在问你意见时才开口
- 群里开口就随便说一句，别像总结发言，别一口气接好几个人，也别当复读机
- 如果有人骂你、让你闭嘴、明说不欢迎你说话，直接输出 [SKIP]，一句都别争
- 同一个话题你已经说过了就别重复表态，别人没接你的话就说明没人想聊这个"""

SKIP_TOKEN = "[SKIP]"

# 对方明确要语音时也回语音（QQ 那边同一套触发词）
VOICE_TRIGGER = re.compile(r"发(条|个)?语音|语音回|用语音|语音说|说句话听听|语音呢")


def load_config():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG):
        with open(CONFIG, encoding="utf-8") as f:
            cfg.update(json.load(f))
    return cfg


DEFAULTS = {
    "dbDir": "",
    "account": "",
    "replyToAll": True,
    "groupMode": "smart",
    "whitelist": [],
    "blacklist": [],
    "persona": "",
    "historyLimit": 8,
    "groupMemoryLimit": 40,
    "voiceReply": False,
    "voiceAlways": False,
    "ttsModel": "FunAudioLLM/CosyVoice2-0.5B",
    "ttsVoice": "FunAudioLLM/CosyVoice2-0.5B:alex",
    "asrModel": "FunAudioLLM/SenseVoiceSmall",
    "voiceSendMode": "file",
    "pollSeconds": 0.5,
    "perChatIntervalSeconds": 0.5,
    "maxConsecutive": 50,
    "maxPerHour": 300,
    "dedupeWindowSeconds": 30,
    "sendVerify": False,
}


def log(*parts):
    line = f"{time.strftime('%H:%M:%S')} " + " ".join(str(p) for p in parts)
    print(line, flush=True)


def build_system_prompt(cfg, is_group):
    persona = cfg.get("persona") or PERSONA_DEFAULT
    parts = [
        "你是「我」本人在微信上聊天。对方不知道背后是谁，每条都要像本人随手打的。",
        f"我的人设：{persona}",
        STYLE_RULES,
        FORMAT_RULES,
    ]
    if is_group and cfg.get("groupMode", "smart") == "smart":
        parts.append(GROUP_RULES)
    return "\n\n".join(parts)


# 非文本消息的 content 是协议 XML（图片是一大坨 <img aeskey=...>），
# 直接喂给模型会让它对着 base64 说话。按 type 换成人类可读的占位。
NON_TEXT_PLACEHOLDER = {
    "图片": "[图片]", "语音": "[语音]", "视频": "[视频]", "文件": "[文件]",
    "表情": "[表情]", "链接": "[链接]", "位置": "[位置]", "名片": "[名片]",
    "引用": "[引用]", "系统": "[系统消息]",
}

# 群消息的 content 会带一层「发送者wxid:\n」前缀（微信的存储格式），要剥掉
_GROUP_PREFIX = re.compile(r"^wxid_[A-Za-z0-9_]+:\s*\n")


def clean_content(m):
    """把一条消息的 content 变成能喂给模型的文本。"""
    ctype = (m.get("type") or "").strip()
    content = (m.get("content") or "").strip()
    if ctype and ctype != "文本":
        return NON_TEXT_PLACEHOLDER.get(ctype, f"[{ctype}]")
    if content.startswith("<?xml") or content.startswith("<msg"):
        return "[非文本消息]"
    content = _GROUP_PREFIX.sub("", content).strip()
    return content


class DbBot:
    # 主动发消息（main() 里注入）。放类属性是为了照顾 test_db_flow 那种
    # 用 __new__ 人工构造实例的离线测试。
    proactive = None

    def __init__(self, cfg):
        self.cfg = cfg
        from wechatauto import WeChatDB
        self.db = WeChatDB(db_dir=cfg["dbDir"], account=cfg["account"])
        me = self.db.get_self_info() or {}
        self.me = me.get("username") or getattr(self.db, "wxid", "")
        self.my_names = {n for n in (me.get("nick_name"), me.get("remark"),
                                     self.me) if n}
        self._gui = None
        self._last_skip = {}
        self._last_unread = None
        self._member_cache = {}
        # 失败重试计数：(chat, fp) -> 次数。护栏类失败会自动重试，但必须封顶，
        # 否则每 0.5s 轮询一次就重来一遍（历史上刷出过 900 多条重复 skip 日志）。
        self._fails = {}
        # 永久跳过的会话：name -> 当时的未读数。未读数没变就直接跳过，
        # 连数据库都不用读（群聊模式下未读角标可能挂很久）。
        self._perm_skip = {}
        # 主动发消息（main() 里注入，便于 status/once 时不启动它）
        self.proactive = None
        log(f"账号 {me.get('nick_name')!r} ({self.me})")
        log(f"数据库 {self.db.db_dir} / {self.db.account}")
        log(f"群聊模式 {cfg.get('groupMode')}")

    @property
    def gui(self):
        if self._gui is None:
            from wechatauto import WeChatGUI
            self._gui = WeChatGUI()
        return self._gui

    def display_name(self, username):
        try:
            n = self.db.get_nickname(username)
            if n:
                return n
        except Exception:
            pass
        return username

    def member_name(self, chatroom, wxid):
        """群成员的显示名。拿不到就退回 wxid 后 6 位。"""
        cache = self._member_cache.setdefault(chatroom, {})
        if wxid in cache:
            return cache[wxid]
        name = None
        try:
            for m in self.db.get_group_members(chatroom) or []:
                if not isinstance(m, dict):
                    continue
                u = m.get("username") or m.get("wxid") or ""
                if u:
                    cache[u] = m.get("remark") or m.get("nick_name") or u
            name = cache.get(wxid)
        except Exception:
            pass
        if not name:
            try:
                name = self.db.get_nickname(wxid)
            except Exception:
                name = None
        name = name or (wxid[-6:] if wxid else "群友")
        cache[wxid] = name
        return name

    def is_group(self, username):
        return (username or "").endswith("@chatroom")

    def incoming_from(self, username, is_group, limit=None):
        """返回 (对方最新一条消息, 历史文本, 说话人, 最新这条是不是语音, 正序行)。

        注意 get_messages() 返回的是**新 -> 旧**（local_id 递减）。之前我按
        「旧 -> 新」取最后一条，结果永远拿到最老的那条消息 —— 表现就是
        「明明有新消息，机器人却一直在跳过一条老消息」。
        """
        limit = limit or (self.cfg["groupMemoryLimit"] if is_group
                          else self.cfg["historyLimit"])
        msgs = self.db.get_messages(username, limit=limit)
        rows = []
        for m in msgs:
            sender = m.get("sender_username") or ""
            content = clean_content(m)
            if not content:
                continue
            mine = sender == self.me or sender in self.my_names
            if mine:
                label = "我"
            elif is_group:
                label = self.member_name(username, sender)
            else:
                label = "对方"
            rows.append((mine, label, content, (m.get("type") or "").strip()))
        rows.reverse()  # 翻成时间正序
        incoming, who, last_type = None, None, ""
        for mine, label, content, ctype in reversed(rows):
            if not mine:
                incoming, who, last_type = content, label, ctype
                break
        if is_group:
            history = "\n".join(f"[{label}] {c}" for _, label, c, _ in rows)
        else:
            history = "\n".join(("我: " if mine else "对方: ") + c
                                for mine, _, c, _ in rows)
        return incoming, history, who, last_type == "语音", rows

    # ------------------------------------------------------------ 群聊语境
    def group_addressed(self, rows, incoming):
        """群里最后这条是不是在跟我说 —— 返回 (是否冲我来了, 依据)。

        用户原话：「别人对话的时候不要回消息，该你回的时候再去回」。所以这里
        先用**确定性信号**判断，判不动才交给模型，模型仍有 [SKIP] 的否决权：
          1. @我 / 消息里点了我的名字      -> 是
          2. 紧接在我上一句之后（在接我的话）-> 是
          3. @所有人 但没点我名字           -> 否（那是通知，不是叫我）
          4. 最近 6 条里我已经说了 2 条以上  -> 否（别自嗨，会被踢）
        """
        # 「@昵称」是精确匹配，单字昵称也安全；而「昵称出现在句子里」只用
        # 两个字以上的名字，否则一个字的昵称会把几乎所有话都判成在叫我。
        at_names = [n for n in self.my_names if n]
        plain_names = [n for n in self.my_names if n and len(n) >= 2]
        text = incoming or ""

        at_all = "@所有人" in text or "@all" in text.lower()
        for n in at_names:
            if f"@{n}" in text:
                return True, f"@{n}"
        # 昵称直接出现在话里（"XX 你觉得呢"）—— 强信号，优先于下面的自嗨限制
        for n in plain_names:
            if n in text:
                return True, "点了名字"
        if at_all:
            return False, "@所有人"

        # 别自嗨：最近 6 条里我已经说了 2 条以上，就算有人好像接了我的话，
        # 也别再追一句——群聊里机器人抢话最容易被踢。强信号（@我/点名字）已经在
        # 前面 return 掉了，不会走到这。
        mine_recent = sum(1 for r in rows[-6:] if r[0])
        if mine_recent >= 2:
            return False, "我最近说得太多了"

        # 上一句是我发的 -> 这条大概率在接我的话（rows 已翻成时间正序）
        if len(rows) >= 2 and rows[-2][0]:
            return True, "接着我的话"

        return False, "群友互相在聊"

    def _note_fail(self, g, chat, fp, limit, why):
        """同一指纹失败计数，超过 limit 次就标记已处理。

        没有封顶的话，生成失败/发送失败都会让这条消息在下一轮 0.5s 后重来一遍，
        既刷日志又重复调模型、甚至重复发消息。返回 True 表示已经放弃这条。
        """
        key = (chat, fp)
        n = self._fails.get(key, 0) + 1
        self._fails[key] = n
        if n < limit:
            return False
        self._fails.pop(key, None)
        log(f"  {chat!r} 连续失败 {n} 次（{why}）-> 放弃这条，不再重试")
        guard.log_event(event="give-up", chat=chat, reason=why, attempts=n)
        try:
            g.mark_handled(chat, fp)
        except Exception:
            pass
        return True

    def handle_session(self, s, g, live):
        username = s.get("username") or ""
        if not username or username == self.me:
            return False
        if int(s.get("unread") or 0) <= 0:
            return False
        is_group = self.is_group(username)
        name = self.display_name(username)
        chat = name
        unread_n = int(s.get("unread") or 0)
        if self._perm_skip.get(name) == unread_n:
            return False  # 上次已判定永久跳过，未读数没变就不用再读库

        incoming, history, who, was_voice, rows = self.incoming_from(username, is_group)
        self._last_incoming_was_voice = was_voice
        if not incoming:
            # 读不到内容时没有可用指纹，只能靠计数封顶，不然每 0.5s 刷一条日志
            self._note_fail(g, chat, "<no-incoming>", 3, "读不到对方消息")
            return False

        # 对方回话了：如果之前主动找过他，把「没人理」计数清零
        if self.proactive is not None and name in (self.proactive.state.get("chats") or {}):
            self.proactive.note_reply(name)

        # 群聊的「已回过」指纹要带说话人，否则群里别人说同一句话会被当成回过
        fp = f"{who}:{incoming}" if is_group else incoming

        # 永久性跳过也必须记账：不记账的话未读角标一直在，每轮轮询都会重判一遍，
        # 日志会被刷爆（历史上旧版就这么刷出 900+ 条 group-skip）。
        def _skip_permanent(why, event=None, **extra):
            self._perm_skip[name] = unread_n
            if g.already_handled(chat, fp):
                return False
            log(f"  {name!r} {why} -> 不回")
            if event:
                guard.log_event(event=event, chat=chat, **extra)
            g.mark_handled(chat, fp)
            return False

        if is_group and self.cfg.get("groupMode", "smart") == "skip":
            return _skip_permanent("是群聊（groupMode=skip）", "group-skip")
        for bad in self.cfg["blacklist"]:
            if guard.score(name, bad) >= 0.55:
                return _skip_permanent("命中黑名单", "blacklist-hit")
        if not self.cfg.get("replyToAll", True):
            hit = guard.match_whitelist(name, self.cfg["whitelist"])
            if hit is None:
                return _skip_permanent("不在白名单", "whitelist-miss", name=name)
            chat = hit

        # 群聊语境门禁：别人互相聊的时候不掺和，只在冲我来的才开口。
        # 这一步是确定性的（不花 token、不会误判），判不动才交给模型。
        addressed, why = True, "私聊"
        if is_group and self.cfg.get("groupMode", "smart") == "smart":
            addressed, why = self.group_addressed(rows, incoming)
            if not addressed:
                return _skip_permanent(f"群里{why} -> 不插嘴", "group-idle",
                                       reason=why, last=incoming[:40])

        if g.already_handled(chat, fp):
            key = (chat, fp)
            if self._last_skip.get(key) != fp:
                self._last_skip[key] = fp
                log(f"  {name!r} 这条已回过 -> 跳过（{fp!r}）")
            return False
        ok, why = g.check(chat)
        if not ok:
            log(f"  {name!r} 被护栏拦下：{why}")
            guard.log_event(event="guard-block", chat=chat, reason=why)
            return False

        reply, err = self.generate(chat, name, incoming, history, is_group, addressed)
        if reply == SKIP_TOKEN:
            log(f"  [{name}] 模型判断群里没它的事 -> 不插嘴")
            guard.log_event(event="group-skip-model", chat=chat, incoming=incoming)
            g.mark_handled(chat, fp)
            return False
        if not reply:
            log(f"  生成失败：{err}")
            guard.log_event(event="gen-failed", chat=chat, err=err)
            self._note_fail(g, chat, fp, 2, f"生成失败:{err}")
            return False
        log(f"  [{name}]{' ' + who if is_group and who else ''} 对方：{incoming!r}")
        log(f"  [{name}] 回复：{reply!r}")

        if not live:
            log("  [dry-run] 未发送")
            return True
        try:
            self.send_reply(name, reply, username, incoming)
        except Exception as exc:
            log(f"  发送异常：{type(exc).__name__}: {exc}")
            guard.log_event(event="send-error", chat=chat,
                            err=f"{type(exc).__name__}: {exc}")
            # 重试一次；还是失败就记账，避免每 0.5s 重发同一句（可能造成刷屏）
            self._note_fail(g, chat, fp, 2, f"发送失败:{type(exc).__name__}")
            return False
        g.record(chat, reply)
        g.mark_handled(chat, fp)
        self._perm_skip.pop(name, None)
        self._fails.pop((chat, fp), None)
        guard.log_event(event="sent", chat=chat, group=is_group,
                        incoming=incoming, reply=reply)
        log("  已发送")
        return True

    def generate(self, chat, name, incoming, history, is_group, addressed=True):
        """生成回复。

        smart 模式下群聊的「该不该插嘴」已经在 handle_session 里用确定性信号
        判过一轮，走到这里说明要么冲我来了，要么是私聊。模型手里仍留着
        [SKIP] 作为最后否决权（比如被 @ 了但那条是广告）。

        all 模式（用户要的「群里每条都回」）不能塞 [SKIP] 指令 —— 塞了模型
        就会自作主张地沉默，表现成「群里还是不回」。
        """
        system = build_system_prompt(self.cfg, is_group)
        smart = is_group and self.cfg.get("groupMode", "smart") == "smart"
        temp = float(self.cfg.get("temperature", 1.0))
        if is_group:
            if smart:
                tail = ("这条是冲你来的（点了你/接着你的话）。随口接一句，别正式、"
                        f"别总结、别说满，接不了就只输出 {SKIP_TOKEN}。")
            else:
                tail = "随便接一句，别像总结发言。"
            prompt = (f"群里最近的聊天记录：\n{history}\n\n"
                      f"最后一条是刚刚发出来的。{tail}")
            return llm.generate(prompt, system=system, cfg=None, temperature=temp)
        # 私聊：把最近几条一起给模型，才接得上刚才在聊什么
        return llm.generate(incoming, history=history, system=system,
                            cfg=None, temperature=temp)

    def send_reply(self, name, reply, username, incoming=""):
        cfg = self.cfg
        want_voice = (
            cfg.get("voiceAlways")
            or (cfg.get("voiceReply") and self._last_incoming_was_voice)
            or bool(VOICE_TRIGGER.search(incoming or ""))
            or bool(VOICE_TRIGGER.search(reply or ""))
        )
        if want_voice:
            try:
                path = tts_to_file(reply, cfg)
                if path:
                    # PC 微信只能把音频当文件发（聊天气泡那个语音条只能实时录麦克风）
                    r = self.gui.send_file(path, who=name)
                    if _send_ok(r) or _send_uncertain(r):
                        log(f"  已发语音（{os.path.basename(path)}）")
                        return
                    log(f"  语音发送失败，退回文字：{r}")
            except Exception as exc:
                log(f"  语音失败退回文字：{type(exc).__name__}: {exc}")
        r = self.gui.send_msg(reply, who=name, verify=cfg.get("sendVerify", False))
        if not _send_ok(r):
            # 「已尝试发送但结果未确认」实测是**误报**：回车已经按下、消息在群里了，
            # 只是输入框清空的判定超时。当成失败会让下一轮把同一句话再发一遍，
            # 所以这里按已发送处理，只在日志里留痕。
            if _send_uncertain(r):
                log(f"  发送未确认（多半已发出，按已发处理，避免重复）：{reply}")
                guard.log_event(event="send-uncertain", chat=name, reply=reply)
                return
            raise RuntimeError(f"发送未成功：{r}")

    def round(self, g, live):
        if guard.stop_requested():
            log("STOP 文件存在 -> 急停")
            return 0
        sessions = self.db.get_sessions(limit=50)
        unread = [s for s in sessions if int(s.get("unread") or 0) > 0]
        if not unread:
            self._last_unread = None
            return 0
        if self._last_unread != len(unread):
            self._last_unread = len(unread)
            log(f"发现 {len(unread)} 个未读会话")
        n = 0
        for s in unread:
            try:
                if self.handle_session(s, g, live):
                    n += 1
            except Exception as exc:
                log(f"  异常：{type(exc).__name__}: {exc}")
                guard.log_event(event="error", err=f"{type(exc).__name__}: {exc}")
        return n


def _send_ok(r):
    """判定发送结果。「数据库未确认」实测是超时误报，消息其实发出去了。"""
    if isinstance(r, dict):
        status = r.get("status")
        if status in (None, "成功", "success", "ok"):
            return True
        return "数据库未确认" in str(r.get("message", ""))
    return True


def _send_uncertain(r):
    """「已尝试发送但结果未确认」——回车按过了，消息多半已进聊天，只是没回读到清空。"""
    return isinstance(r, dict) and "已尝试发送但结果未确认" in str(r.get("message", ""))


# ---------------------------------------------------------------- 语音

def _siliconflow_cfg():
    c = llm.load_llm_config()
    return c.get("baseUrl", "").rstrip("/"), c.get("apiKey", "")


def tts_to_file(text, cfg):
    """文字转语音，落盘 mp3。参考 QQ 的实现（同一个 SiliconFlow 接口）。"""
    import urllib.request
    base, key = _siliconflow_cfg()
    if not base or not key:
        raise RuntimeError("没有 API Key，无法合成语音")
    out_dir = os.path.join(HERE, "tts")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"voice-{time.strftime('%H%M%S')}.mp3")
    body = json.dumps({
        "model": cfg.get("ttsModel"),
        "input": text,
        "voice": cfg.get("ttsVoice"),
        "response_format": "mp3",
    }).encode("utf-8")
    req = urllib.request.Request(
        base + "/audio/speech", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    if not data:
        raise RuntimeError("TTS 返回空")
    with open(path, "wb") as f:
        f.write(data)
    return path


def asr_transcribe(path, cfg):
    """语音转文字（SiliconFlow ASR）。"""
    import urllib.request
    import uuid
    base, key = _siliconflow_cfg()
    if not base or not key:
        raise RuntimeError("没有 API Key，无法转写语音")
    boundary = "----wxbot" + uuid.uuid4().hex
    with open(path, "rb") as f:
        audio = f.read()
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                 f'name="model"\r\n\r\n{cfg.get("asrModel")}\r\n'.encode())
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                 f'name="file"; filename="v.mp3"\r\n'
                 f"Content-Type: audio/mpeg\r\n\r\n".encode())
    parts.append(audio)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        base + "/audio/transcriptions", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                 "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=60) as resp:
        d = json.loads(resp.read().decode("utf-8"))
    return (d.get("text") or "").strip()


def ensure_output():
    """无控制台启动（pythonw.exe / WMI）时 sys.stdout 和 sys.stderr 都是 None，
    print() 会直接抛 AttributeError，日志和 traceback 全丢。

    这里把输出接回 live.log。这样值守进程就不需要 cmd 的 `>> live.log` 重定向，
    —— 少了 cmd 这一层，也就没有那个会被 Ctrl+C 连坐的控制台了。
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        f = open(os.path.join(HERE, "live.log"), "a", encoding="utf-8", buffering=1)
    except Exception:
        return
    if sys.stdout is None:
        sys.stdout = f
    if sys.stderr is None:
        sys.stderr = f


def main():
    ensure_output()
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["once", "watch", "status", "stop", "resume",
                                    "sessions", "tts", "asr"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--live", action="store_true")
    args = ap.parse_args()

    cfg = load_config()
    g = guard.Guard(cfg, state_path=os.path.join(HERE, "bot-db-state.json"))

    if args.cmd == "stop":
        guard.request_stop("手动")
        print("已写 STOP")
        return 0
    if args.cmd == "resume":
        guard.clear_stop()
        print("已清 STOP")
        return 0

    if args.cmd == "tts":
        if not args.args:
            print("用法：bot_db.py tts 要说的话")
            return 1
        p = tts_to_file(" ".join(args.args), cfg)
        print("已生成:", p, os.path.getsize(p), "字节")
        return 0
    if args.cmd == "asr":
        if not args.args:
            print("用法：bot_db.py asr 音频文件路径")
            return 1
        print("转写:", asr_transcribe(args.args[0], cfg))
        return 0

    if args.cmd == "sessions":
        from wechatauto import WeChatDB
        db = WeChatDB(db_dir=cfg["dbDir"], account=cfg["account"])
        for s in db.get_sessions(limit=50):
            u = s.get("username") or ""
            try:
                nm = db.get_nickname(u) or u
            except Exception:
                nm = u
            tag = "[群]" if u.endswith("@chatroom") else "    "
            print(f"  {tag} unread={s.get('unread')} {str(nm)[:20]:22s} "
                  f"{u[:30]:32s} {str(s.get('summary'))[:32]!r}")
        return 0

    bot = DbBot(cfg)
    if args.cmd == "status":
        print(f"回复所有私聊：{cfg.get('replyToAll')}")
        print(f"群聊模式：{cfg.get('groupMode')}"
              + ("（每条都回）" if cfg.get("groupMode") == "all"
                 else "（只在被 @ / 点名 / 接你的话时才开口）"))
        print(f"人设：{(cfg.get('persona') or PERSONA_DEFAULT)[:40]}…")
        print(f"语音：voiceReply={cfg.get('voiceReply')} "
              f"voiceAlways={cfg.get('voiceAlways')} "
              f"发送方式={cfg.get('voiceSendMode')}")
        p = proactive.Proactive(bot, cfg)
        print(f"主动发消息：{'开' if p.cfg.get('enabled') else '关'} "
              f"{p.cfg['activeHours'][0]}–{p.cfg['activeHours'][1]}点 "
              f"每天≤{p.cfg['maxPerDay']}条 间隔≥{p.cfg['minGapMinutes']}分 "
              f"同一人{p.cfg['perChatCooldownDays']}天冷却 "
              f"今日已发{p._count_today()}")
        ok, why = p.due()
        print(f"  现在能发？{'是' if ok else '否（' + why + '）'}")
        print(f"轮询间隔：{cfg['pollSeconds']}s")
        print(f"STOP：{'存在' if guard.stop_requested() else '不存在'}")
        return 0

    if args.cmd == "once":
        bot.round(g, args.live)
        return 0

    log(f"开始轮询（数据库版），每 {cfg['pollSeconds']}s 一次"
        + ("，LIVE 会真发" if args.live else "，dry-run"))
    bot.proactive = proactive.Proactive(bot, cfg)
    while True:
        try:
            bot.round(g, args.live)
            bot.proactive.maybe_fire(args.live)
        except KeyboardInterrupt:
            print("\n退出")
            return 0
        except Exception as exc:
            log(f"轮询异常（继续）：{type(exc).__name__}: {exc}")
        time.sleep(cfg["pollSeconds"])


if __name__ == "__main__":
    sys.exit(main())
