"""
消息处理主流程的离线断言：不连微信、不碰屏幕、不发消息。

重点盯「不记账 -> 每 0.5s 重试一遍」这类坑：
历史上旧版把同一批群消息重试了 900 多次，日志刷爆；DB 版在
生成失败/发送失败/永久跳过这几条分支上也有同样风险。
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import guard

# 隔离掉真实护栏状态文件，避免污染线上 bot-state.json
state_path = os.path.join(tempfile.gettempdir(), "wechat-bot-test-db-state.json")
if os.path.exists(state_path):
    os.remove(state_path)
guard.STATE = state_path

import bot_db  # noqa: E402

FAIL = []
EVENTS = []

# bot_db 里写事件用的是模块级 guard.log_event，桩不住 FakeGuard，只能直接换掉，
# 否则测试会往线上 bot-log.jsonl 里灌假事件。
guard.log_event = lambda **kw: EVENTS.append(kw)


def check(name, got, want):
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {name}: {got!r}" +
          ("" if ok else f"（期望 {want!r}）"))
    if not ok:
        FAIL.append(name)


class FakeDB:
    def __init__(self, msgs):
        # msgs 按「新 -> 旧」给，和真实 get_messages 一致
        self.msgs = msgs
        self.reads = 0

    def get_messages(self, username, limit=None):
        self.reads += 1
        return self.msgs[:limit] if limit else list(self.msgs)

    def get_nickname(self, username):
        return {"123@chatroom": "测试群", "alice": "小A"}.get(username, "")

    def get_group_members(self, chatroom):
        return [{"username": "wxid_a", "nick_name": "阿花"}]


class FakeGuard:
    def __init__(self, cfg):
        self.cfg = cfg
        self.handled = {}
        self.marked = 0

    def already_handled(self, chat, msg):
        return self.handled.get(chat) == guard.normalize(msg)

    def mark_handled(self, chat, msg):
        self.handled[chat] = guard.normalize(msg)
        self.marked += 1

    def check(self, chat):
        return True, ""

    def record(self, chat, text):
        pass



def make_bot(cfg, msgs):
    b = bot_db.DbBot.__new__(bot_db.DbBot)
    b.cfg = cfg
    b.db = FakeDB(msgs)
    b.me = "me"
    b.my_names = {"我"}
    b._gui = None
    b._last_skip = {}
    b._last_unread = None
    b._member_cache = {}
    b._fails = {}
    b._perm_skip = {}
    b._last_incoming_was_voice = False
    return b


def base_cfg(**kw):
    cfg = {
        "whitelist": [], "blacklist": [], "replyToAll": True,
        "groupMode": "all", "groupMemoryLimit": 30, "historyLimit": 20,
        "voiceReply": False, "voiceAlways": False,
    }
    cfg.update(kw)
    return cfg


def group_msgs(text="今天吃啥"):
    return [{"sender_username": "wxid_a", "content": text, "type": "文本"}]


def private_msgs(text="在吗"):
    return [{"sender_username": "alice", "content": text, "type": "文本"}]


def main():
    EVENTS.clear()
    print("== 群聊模式 skip：跳过也要记账 ==")
    cfg = base_cfg(groupMode="skip")
    b = make_bot(cfg, group_msgs())
    g = FakeGuard(cfg)
    s = {"username": "123@chatroom", "unread": 1}
    check("第一次 skip 返回 False", b.handle_session(s, g, True), False)
    check("skip 已记账", g.marked, 1)
    check("第二次直接命中已处理（不再重复）",
          b.handle_session(s, g, True), False)
    check("没有重复记账", g.marked, 1)
    check("skip 事件只记一次",
          len([e for e in EVENTS if e.get("event") == "group-skip"]), 1)
    before = b.db.reads
    b.handle_session(s, g, True)
    check("未读数不变时不再读库", b.db.reads, before)
    s2 = dict(s, unread=2)
    b.handle_session(s2, g, True)
    check("未读数变了才重新读库", b.db.reads > before, True)

    EVENTS.clear()
    print("== 黑名单 / 白名单外：同样只判一次 ==")
    cfg = base_cfg(blacklist=["测试群"])
    b = make_bot(cfg, group_msgs())
    g = FakeGuard(cfg)
    s = {"username": "123@chatroom", "unread": 1}
    b.handle_session(s, g, True)
    b.handle_session(s, g, True)
    check("黑名单记账一次", g.marked, 1)

    cfg = base_cfg(replyToAll=False, whitelist=["别人"])
    b = make_bot(cfg, private_msgs())
    g = FakeGuard(cfg)
    s = {"username": "alice", "unread": 1}
    b.handle_session(s, g, True)
    b.handle_session(s, g, True)
    check("白名单外记账一次", g.marked, 1)
    check("白名单外事件只记一次",
          len([e for e in EVENTS if e.get("event") == "whitelist-miss"]), 1)

    EVENTS.clear()
    print("== 生成失败：重试一次后放弃 ==")
    cfg = base_cfg()
    b = make_bot(cfg, private_msgs("在吗"))
    g = FakeGuard(cfg)
    b.generate = lambda *a, **k: (None, "模型超时")
    s = {"username": "alice", "unread": 1}
    check("第一次失败返回 False", b.handle_session(s, g, True), False)
    check("第一次不记账", g.marked, 0)
    check("第二次失败仍返回 False", b.handle_session(s, g, True), False)
    check("达到上限后记账", g.marked, 1)
    check("放弃事件记为 give-up",
          any(e.get("event") == "give-up" for e in EVENTS), True)

    EVENTS.clear()
    print("== 发送失败：同样封顶 ==")
    cfg = base_cfg()
    b = make_bot(cfg, private_msgs("在吗"))
    g = FakeGuard(cfg)
    b.generate = lambda *a, **k: ("好的", "")
    b.send_reply = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("发送未成功"))
    s = {"username": "alice", "unread": 1}
    b.handle_session(s, g, True)
    b.handle_session(s, g, True)
    check("发送失败两次后记账", g.marked, 1)
    check("记了 send-error",
          len([e for e in EVENTS if e.get("event") == "send-error"]), 2)

    EVENTS.clear()
    print("== dry-run 不记账（方便反复演练） ==")
    cfg = base_cfg()
    b = make_bot(cfg, private_msgs("在吗"))
    g = FakeGuard(cfg)
    b.generate = lambda *a, **k: ("在的", "")
    s = {"username": "alice", "unread": 1}
    check("dry-run 返回 True", b.handle_session(s, g, False), True)
    check("dry-run 不记账", g.marked, 0)

    print()
    print("== 群聊语境：别人互相聊不插嘴，点我才回 ==")
    rows_of = lambda *items: [(m, n, c, "文本") for m, n, c in items]
    cfg = base_cfg(groupMode="smart")
    b = make_bot(cfg, group_msgs("两点"))
    # 单字昵称只在 @ 时才认（否则几乎所有话都判成在叫我），这里补一个两字昵称
    b.my_names = {"我", "小六"}
    cases = [
        ("别人互相聊",
         rows_of((False, "A", "几点睡"), (False, "B", "两点"), (False, "A", "太晚了吧")),
         "太晚了吧", False),
        ("@我", rows_of((False, "A", "@我 你觉得呢")), "@我 你觉得呢", True),
        ("点我名字", rows_of((False, "A", "小六 这事办完没")), "小六 这事办完没", True),
        ("单字昵称不误判", rows_of((False, "A", "我昨天睡得早")), "我昨天睡得早", False),        ("接着我的话",
         rows_of((True, "我", "行 我去看看"), (False, "A", "看了吗")), "看了吗", True),
        ("@所有人", rows_of((False, "A", "@所有人 明天九点开会")),
         "@所有人 明天九点开会", False),
        ("我话太多没人点",
         rows_of((True, "我", "a"), (False, "A", "嗯"), (True, "我", "b"),
                 (False, "B", "哦"), (True, "我", "c"), (False, "A", "哈")), "哈", False),
        ("话太多但被@",
         rows_of((True, "我", "a"), (False, "A", "嗯"), (True, "我", "b"),
                 (False, "B", "哦"), (True, "我", "c"), (False, "A", "@我 说话啊")),
         "@我 说话啊", True),
    ]
    for label, rows, inc, want in cases:
        got, _why = b.group_addressed(rows, inc)
        check(f"语境·{label}", got, want)

    EVENTS.clear()
    cfg = base_cfg(groupMode="smart")
    # 新 -> 旧：A 问 B 几点睡的，最后一句是 B 的回答，跟我无关
    b = make_bot(cfg, [
        {"sender_username": "wxid_a", "content": "两点", "type": "文本"},
        {"sender_username": "wxid_a", "content": "你昨天几点睡的", "type": "文本"},
    ])
    g = FakeGuard(cfg)
    b.generate = lambda *a, **k: ("不该生成", "")
    s = {"username": "123@chatroom", "unread": 1}
    check("smart 模式：群友对聊不生成", b.handle_session(s, g, True), False)
    check("记了 group-idle 事件",
          any(e.get("event") == "group-idle" for e in EVENTS), True)

    EVENTS.clear()
    b = make_bot(cfg, [{"sender_username": "wxid_a", "content": "@我 你觉得呢",
                        "type": "文本"}])
    g = FakeGuard(cfg)
    called = {"n": 0}

    def _gen(*a, **k):
        called["n"] += 1
        return "还行吧", ""
    b.generate = _gen
    # 一定要打桩：不桩的话会走真实 WeChatGUI，把测试话术发进真会话
    b.send_reply = lambda *a, **k: None
    check("被 @ 了就生成并发送", b.handle_session(s, g, True), True)
    check("确实调了生成", called["n"], 1)

    print()
    print("== 分段发送：长拆短、短不拆 ==")
    scfg = {"segmentReply": True, "segmentMinChars": 26, "segmentMaxParts": 3,
            "typingCps": 7, "typingMaxSeconds": 5}
    check("两三个字不拆", bot_db.split_reply("行", scfg), ["行"])
    check("不到阈值不拆", bot_db.split_reply("嗯我知道了我马上就去弄", scfg),
          ["嗯我知道了我马上就去弄"])
    check("空串不产生消息", bot_db.split_reply("   ", scfg), [])
    long1 = "我今天下午去了一趟医院。医生说要观察两天。你别担心。"
    got = bot_db.split_reply(long1, scfg)
    check("三条长句拆成三条", len(got), 3)
    check("拆开不丢字", "".join(got), long1)
    check("关掉开关就不拆", bot_db.split_reply(long1, {"segmentReply": False}),
          [long1])
    two_lines = "第一条内容写得够长了吧哈哈哈\n第二条也写得够长了吧哈哈哈"
    check("有换行就按换行拆", len(bot_db.split_reply(two_lines, scfg)), 2)
    four = ("一句够长的话在这里。二句够长的话在这里。"
            "三句够长的话在这里。四句够长的话在这里。")
    check("超过段数上限就合并尾部", len(bot_db.split_reply(four, scfg)), 3)
    d = bot_db.typing_delay("这是十个字的一句话呀", scfg)
    check("打字停顿落在合理区间", 0.2 <= d <= 5.0, True)

    print()
    print("== 群聊上下文缓冲：没接的话攒着，下次开口带上 ==")
    b = make_bot(base_cfg(), group_msgs())
    b._ctx_buf = {}
    b._buffer("测试群", "A", "周末去爬山")
    b._buffer("测试群", "A", "周末去爬山")   # 同一条不该攒两遍
    b._buffer("测试群", "B", "我不去")
    check("缓冲去重", len(b._ctx_buf["测试群"]), 2)
    ctx = b._take_context("测试群")
    check("取出时带上说话人", "[B] 我不去" in ctx, True)
    check("取出即清空", b._ctx_buf.get("测试群"), None)
    b._ctx_buf = {}
    for i in range(20):
        b._buffer("测试群", "A", f"话{i}")
    check("缓冲有上限（默认 12）", len(b._ctx_buf["测试群"]), 12)
    check("超出时丢最旧的", b._ctx_buf["测试群"][0][1], "话8")

    print()
    print("== 群聊概率闸：调低后不是条条都接 ==")
    cfg = base_cfg(groupMode="smart", groupAddressProbability={
        "at": 1.0, "named": 1.0, "following": 0.0})
    # 新 -> 旧：我刚说了话，对方接了一句
    b = make_bot(cfg, [
        {"sender_username": "wxid_a", "content": "看了吗", "type": "文本"},
        {"sender_username": "me", "content": "行 我去看看", "type": "文本"},
    ])
    g = FakeGuard(cfg)
    called = {"n": 0}

    def _gen_no(*a, **k):
        called["n"] += 1
        return "不该生成", ""
    b.generate = _gen_no
    s = {"username": "123@chatroom", "unread": 1}
    check("following=0 时接着我的话也不接",
          b.handle_session(s, g, True), False)
    check("没生成也没发送", called["n"], 0)
    check("记了 group-prob-miss",
          any(e.get("event") == "group-prob-miss" for e in EVENTS), True)
    check("没接的话进了缓冲", len(b._ctx_buf.get("测试群") or []), 1)

    EVENTS.clear()
    cfg = base_cfg(groupMode="smart")   # 默认全 1.0 -> 不降频
    b = make_bot(cfg, [
        {"sender_username": "wxid_a", "content": "看了吗", "type": "文本"},
        {"sender_username": "me", "content": "行 我去看看", "type": "文本"},
    ])
    g = FakeGuard(cfg)
    b.generate = lambda *a, **k: ("看了", "")
    b.send_reply = lambda *a, **k: None
    check("默认概率下照常回", b.handle_session(s, g, True), True)

    print()
    print("== 缓冲的群消息真的进了 prompt ==")
    b = make_bot(base_cfg(groupMode="smart"), [
        {"sender_username": "wxid_a", "content": "@我 你觉得呢", "type": "文本"},
    ])
    g = FakeGuard(cfg)
    b._ctx_buf = {"测试群": [("A", "周末去爬山"), ("B", "我不去")]}
    seen = {}

    def _gen_cap(*a, **k):
        seen["pending"] = a[6] if len(a) > 6 else k.get("pending", "")
        return "还行吧", ""
    b.generate = _gen_cap
    b.send_reply = lambda *a, **k: None
    b.handle_session({"username": "123@chatroom", "unread": 1}, g, True)
    check("pending 带上了攒的群消息",
          "周末去爬山" in (seen.get("pending") or ""), True)
    check("缓冲用完就清空", b._ctx_buf.get("测试群"), None)

    print()
    print("== 发送：长回复分多条落地 ==")

    class FakeGUI:
        def __init__(self):
            self.sent = []

        def send_msg(self, text, who=None, verify=False):
            self.sent.append(text)
            return {"status": "成功"}

    cfg = base_cfg(segmentReply=True, segmentMinChars=10, segmentMaxParts=3,
                   typingCps=1000, voiceReply=False, voiceAlways=False,
                   sendVerify=False)
    b = make_bot(cfg, private_msgs())
    fake = FakeGUI()
    b._gui = fake
    b._last_incoming_was_voice = False
    b.send_reply("小A", "我今天去医院了。医生说要观察。", "", "")
    check("长回复真的分两条发", len(fake.sent), 2)
    check("第二条是后半句", "医生说要观察" in fake.sent[1], True)

    print()
    print("== 表情 / 表情包标记 ==")
    check("剥掉 [[表情]] 标记", bot_db.split_media_tokens("行吧 [[表情]]"),
          ("行吧", True, False))
    check("只发表情时正文为空", bot_db.split_media_tokens("[[表情]]"),
          ("", True, False))
    check("表情包标记", bot_db.split_media_tokens("给你看 [[表情包]]")[2], True)
    check("没有标记不动正文", bot_db.split_media_tokens("就这"),
          ("就这", False, False))
    check("输入侧的 [表情] 占位符不被误认成标记",
          bot_db.split_media_tokens("对方发了[表情]")[1], False)

    # 真操作微信的调用一律打桩：测试里绝不能碰真实客户端
    media_calls = []
    _orig = (bot_db.media_send.send_emoji, bot_db.media_send.send_voice,
             bot_db.media_send.send_image, bot_db.media_send.pick_sticker)
    bot_db.media_send.send_emoji = (
        lambda gui, hwnd, who, **k: media_calls.append("emoji") or True)
    bot_db.media_send.send_voice = (
        lambda gui, text, cfg, **k: media_calls.append("voice") or True)
    bot_db.media_send.send_image = (
        lambda gui, path, who, **k: media_calls.append("sticker") or True)
    bot_db.media_send.pick_sticker = lambda cfg, **k: "/tmp/fake.gif"
    try:
        def _run(cfg, reply, incoming_type=""):
            media_calls.clear()
            bb = make_bot(cfg, private_msgs())
            bb._gui = FakeGUI()
            bb._last_incoming_type = incoming_type
            bb._last_incoming_was_voice = False
            bb.send_reply("小A", reply, "", "")
            return list(media_calls)

        check("开了 emojiReply 且模型要表情 -> 发",
              _run(base_cfg(emojiReply=True, emojiProbability=0), "行 [[表情]]"),
              ["emoji"])
        check("没开 emojiReply -> 标记也不发",
              _run(base_cfg(), "行 [[表情]]"), [])
        check("没标记也没概率 -> 什么都不发",
              _run(base_cfg(emojiReply=True, emojiProbability=0), "行"), [])
        check("对方发表情 -> 镜像回一个",
              _run(base_cfg(emojiReply=True, emojiProbability=0,
                            emojiOnEmoji=1.0), "嗯", incoming_type="表情"),
              ["emoji"])
        check("表情包优先于内置表情",
              _run(base_cfg(emojiReply=True, stickerReply=True,
                            emojiProbability=0), "给你看 [[表情包]]"),
              ["sticker"])
        check("voiceSendMode=voice 走语音条",
              _run(base_cfg(voiceAlways=True, voiceSendMode="voice",
                            emojiReply=False), "听见没"), ["voice"])
    finally:
        (bot_db.media_send.send_emoji, bot_db.media_send.send_voice,
         bot_db.media_send.send_image, bot_db.media_send.pick_sticker) = _orig

    print()
    print("== 主动发消息：时间窗与频率 ==")
    import time as _time
    import proactive
    tmp = os.path.join(tempfile.gettempdir(), "wx-proactive-test.json")
    if os.path.exists(tmp):
        os.remove(tmp)
    proactive.STATE = tmp
    b = make_bot(base_cfg(), private_msgs())
    p = proactive.Proactive(b, {"proactive": {
        "activeHours": [9, 22], "maxPerDay": 2, "minGapMinutes": 180,
        "startupDelayMinutes": 30, "perChatCooldownDays": 3,
    }})
    ok, why = p.due()
    check("刚启动不发", ok, False)
    p.state["bootAt"] = _time.time() - 3600          # 假装启动了一小时
    p.state["lastAt"] = 0
    check("启动够久 + 没配额限制 -> 可发", p.due()[0], True)
    p.state["count"] = 2
    p.state["day"] = p._today()
    check("今日配额用完 -> 不发", p.due(), (False, "今日配额用完"))
    p.state["count"] = 0
    p.state["lastAt"] = _time.time() - 60            # 一分钟前刚发过
    check("间隔不足 -> 不发", p.due(), (False, "距上条不足"))
    p.state["lastAt"] = 0
    p.state["unanswered"] = 2
    check("连发两条没人回 -> 躺平", p.due(), (False, "连发两条没人回，先躺平"))
    p.state["unanswered"] = 0
    p.cfg["activeHours"] = [0, 0]                    # 空窗
    check("不在时间段 -> 不发", p.due(), (False, "不在时间段"))
    p.cfg["activeHours"] = [0, 24]
    p.state["chats"] = {"小A": _time.time()}
    check("同一人冷却期内不重复找",
          p._ok_to_ping({"name": "小A", "last_time": 0}), False)

    print()
    if FAIL:
        print(f"{len(FAIL)} 项未通过: {FAIL}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
