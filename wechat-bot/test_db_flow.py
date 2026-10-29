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
