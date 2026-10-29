"""
视觉感知层的离线断言。不联网、不碰屏幕。

这里锁的是「模型输出怎么解析」和「什么情况必须拒绝」。解析错了会
把机器人自己的话当成来信（回自己一句），所以拒绝路径比接受路径更要紧。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vlm

FAIL = []


def check(name, got, want):
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {name}: {got!r}" +
          ("" if ok else f"（期望 {want!r}）"))
    if not ok:
        FAIL.append(name)


def usable(text):
    """调用方接受的判据：标题可用 且 至少有一条消息。"""
    t, m, _ = vlm.parse_chat_pane(text)
    return bool(t) and bool(m) and not vlm._bad_name(t)


def main():
    print("解析：结构化提示词的输出")
    t, m, g = vlm.parse_chat_pane(
        "标题: G\n类型: 私聊\n消息:\n左: 你是谁\n右: 哈？我这边没看明白，你再发一遍")
    check("标题", t, "G")
    check("类型", g, False)
    check("消息数", len(m), 2)
    check("第一条是对方", m[0], ("左", "你是谁"))
    check("第二条是我", m[1], ("右", "哈？我这边没看明白，你再发一遍"))

    print("\n解析：简单提示词的输出")
    t, m, g = vlm.parse_chat_pane(
        "会话名：文件传输助手\n类型：私聊\n\n最后3条消息：\n- 左: 你好\n- 右: 在的")
    check("标题", t, "文件传输助手")
    check("消息", m, [("左", "你好"), ("右", "在的")])

    print("\n群聊判型：模型说了就用，没说就看标题里的人数后缀")
    check("模型明说群聊", vlm.parse_chat_pane("标题: 摸鱼集团\n类型: 群聊\n左: a")[2], True)
    check("模型明说私聊", vlm.parse_chat_pane("标题: G\n类型: 私聊\n左: a")[2], False)
    check("模型没说，标题带人数 -> 群聊",
          vlm.parse_chat_pane("标题: 摸鱼集团(5)\n左: a")[2], True)
    check("模型没说，标题带半角括号人数 -> 群聊",
          vlm.parse_chat_pane("标题: 摸鱼集团(12)\n左: a")[2], True)
    check("模型没说，标题没人数 -> 私聊",
          vlm.parse_chat_pane("标题: 王小明\n左: a")[2], False)

    print("\n解析：模型不按格式时不能瞎猜")
    check("无左右标注 -> 拒绝（否则会把自己的话当来信）",
          usable("G\nG: 你是谁\n你: 哈？我这边没看明白"), False)
    check("标题空 -> 拒绝",
          usable("标题: \n消息:\n左: 看不清"), False)
    check("只有标题没消息 -> 拒绝", usable("标题: G"), False)
    check("全看不清 -> 拒绝", usable("标题: 看不清\n消息:\n左: 看不清"), False)
    check("六条「看不清」不算消息 -> 拒绝",
          usable("标题: xxx\n左: 看不清\n左: 看不清\n左: 看不清\n"
                 "左: 看不清\n左: 看不清\n左: 看不清"), False)
    check("真实消息夹着看不清 -> 只留真实的",
          vlm.parse_chat_pane("标题: G\n左: 看不清\n右: 在的\n左: 看不清")[1],
          [("右", "在的")])

    print("\n解析：正常输出要能接受")
    check("结构化", usable("标题: G\n消息:\n左: 你是谁"), True)
    check("简单式", usable("会话名：G\n左: 你是谁"), True)
    check("首行裸标题退化", usable("G\n左: 你是谁"), True)

    print("\n左右判定：微信里靠左=对方、靠右=我")
    t, m, _ = vlm.parse_chat_pane("标题: G\n左: a\n右: b\n对方: c\n我: d")
    check("四种前缀都认", m, [("左", "a"), ("右", "b"), ("左", "c"), ("右", "d")])

    print()
    if FAIL:
        print(f"{len(FAIL)} 项未通过: {FAIL}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
