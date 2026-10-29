"""
白名单匹配与护栏的离线断言。不碰屏幕、不发消息。

这一层错了会回错人，所以必须用真机 OCR 里出现过的错字当用例。
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import guard

FAIL = []
TMP_STATE = os.path.join(tempfile.gettempdir(), "wechat-bot-test-state.json")


def check(name, got, want):
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {name}: {got!r}" +
          ("" if ok else f"（期望 {want!r}）"))
    if not ok:
        FAIL.append(name)


def main():
    if os.path.exists(TMP_STATE):
        os.remove(TMP_STATE)

    print("normalize：Windows OCR 会在汉字之间插空格，必须去掉")
    check("去空格", guard.normalize("文 件 传 输 助 手"), "文件传输助手")
    check("去标点", guard.normalize("嗯嗯，在的！"), "嗯嗯在的")
    check("去全角引号", guard.normalize("『七七』"), "七七")
    check("空串", guard.normalize(""), "")

    print("\nmatch_whitelist：真机 OCR 错字用例")
    wl = ["七七"]
    check("完全一致", guard.match_whitelist("七七", wl), "七七")
    check("OCR 插空格", guard.match_whitelist("七 七", wl), "七七")

    wl2 = ["文件传输助手"]
    check("真机错字 '文亻牛传输助手'",
          guard.match_whitelist("文亻牛传输助手", wl2), "文件传输助手")
    check("真机错字 '文 件 传 ． “'",
          guard.match_whitelist("文 件 传 ． “", wl2), "文件传输助手")

    print("\n不该命中的（宁可不回，也不能回错人）")
    check("完全无关的名字",
          guard.match_whitelist("苏宁", ["七七"]), None)
    check("空 OCR 结果", guard.match_whitelist("", ["七七"]), None)
    check("空白名单", guard.match_whitelist("七七", []), None)
    check("单字噪声", guard.match_whitelist("站", ["七七"]), None)

    print("\n闭集判别：白名单多个相似名字时要领先第二名")
    check("两个都在白名单，命中自己",
          guard.match_whitelist("七七", ["七七", "八八"]), "七七")
    check("两个名字分数完全相同 -> 无法区分就不回",
          guard.match_whitelist("小", ["小明", "小月"]), None)
    check("分数有差距 -> 仍然命中",
          guard.match_whitelist("小明", ["小明", "小朋"]), "小明")

    print("\n短名字（单字母）走完全一致，模糊匹配会认错人")
    check("大小写折叠：读成小写 g", guard.match_whitelist("g", ["G"]), "G")
    check("完全一致", guard.match_whitelist("G", ["G"]), "G")
    check("带空格", guard.match_whitelist(" G ", ["G"]), "G")
    check("'GG' 不能当成 'G'", guard.match_whitelist("GG", ["G"]), None)
    check("'G7' 不能当成 'G'", guard.match_whitelist("G7", ["G"]), None)
    check("中文名不能命中单字母白名单",
          guard.match_whitelist("王", ["G"]), None)
    check("'七七' 不能命中 'G'", guard.match_whitelist("七七", ["G"]), None)
    check("长短混排时短名字仍走完全一致",
          guard.match_whitelist("GG", ["G", "文件传输助手"]), None)
    check("长短混排时长名字仍能模糊命中",
          guard.match_whitelist("文亻牛传输助手", ["G", "文件传输助手"]),
          "文件传输助手")

    print("\nsame_name：防点错人的闸门")
    check("完全一致", guard.same_name("G", "G"), True)
    check("大小写折叠", guard.same_name("g", "G"), True)
    check("短名字必须完全一致：'GG' != 'G'", guard.same_name("GG", "G"), False)
    check("短名字：'王' != 'G'", guard.same_name("王", "G"), False)
    check("长名字允许 OCR 错字",
          guard.same_name("文亻牛传输助手", "文件传输助手"), True)
    check("长名字判不同人",
          guard.same_name("李婷", "周有康"), False)
    check("空值一律不认", guard.same_name("", "G"), False)

    print("\n护栏：限流 / 连发上限 / 去重")
    cfg = dict(guard.DEFAULTS)
    cfg["perChatIntervalSeconds"] = 20
    cfg["maxConsecutive"] = 3
    cfg["dedupeWindowSeconds"] = 60
    g = guard.Guard(cfg, TMP_STATE)
    g.state = {"chats": {}, "sentThisHour": []}

    ok, why = g.check("七七")
    check("首次放行", ok, True)

    g.record("七七", "在的")
    ok, why = g.check("七七")
    check("刚发过 -> 同会话间隔拦下", ok, False)
    print(f"       原因 {why}")

    check("同句去重命中", g.duplicate("七七", "在的"), True)
    check("不同句不误判", g.duplicate("七七", "好的"), False)

    c = g._chat("七七")
    c["lastSentAt"] = time.time() - 999
    ok, _ = g.check("七七")
    check("间隔过后放行", ok, True)

    c["consecutive"] = 3
    ok, why = g.check("七七")
    check("连发 3 条 -> 拦下", ok, False)
    print(f"       原因 {why}")

    c["consecutive"] = 0
    g.state["sentThisHour"] = [time.time()] * 25
    ok, why = g.check("七七")
    check("每小时上限 -> 拦下", ok, False)
    print(f"       原因 {why}")

    print("\n已处理指纹：未读角标在对方点开前一直在，不能每轮重发")
    g2 = guard.Guard(cfg, TMP_STATE)
    g2.state = {"chats": {}, "sentThisHour": []}
    check("没回过 -> False", g2.already_handled("七七", "在吗"), False)
    g2.mark_handled("七七", "在吗")
    check("回过 -> True", g2.already_handled("七七", "在吗"), True)
    check("OCR 噪声不影响指纹", g2.already_handled("七七", "在 吗"), True)
    check("新消息 -> False", g2.already_handled("七七", "你吃了吗"), False)

    print()
    if FAIL:
        print(f"{len(FAIL)} 项未通过: {FAIL}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
