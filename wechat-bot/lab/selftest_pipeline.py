"""
端到端自测：不用未读角标，直接点会话列表里的某一行，走完
「点击 -> 标题校验 -> 清空输入框 -> 输入 -> 回读校验」，**不按回车**。

这是唯一能在没有未读消息时验证执行层的办法。默认拿「文件传输助手」
当靶子（发给自己最安全）。测完会把输入框清干净。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/selftest_pipeline.py [会话名]
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # 主链路模块在上一级

import guard
import keys
import send
import vision

TEST_TEXT = "这是一条自测消息，不会真的发出去"


def find_row(blocks, name):
    best = None
    for b in blocks:
        s = guard.score(b["text"], name)
        if best is None or s > best[0]:
            best = (s, b)
    return best


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "文件传输助手"

    snap = vision.capture()
    if snap is None:
        print("抓不到微信主窗口")
        return 1
    print(f"窗口 {snap.rect[2]}x{snap.rect[3]} 缩放 {snap.scale}% "
          f"分界列 {snap.boundary}")

    blocks = snap.session_blocks()
    print(f"会话列表读到 {len(blocks)} 行：")
    for b in blocks[:8]:
        print(f"  y={b['y']:>4} {b['text']!r}")

    s, block = find_row(blocks, target)
    print(f"\n找 {target!r} -> {block['text']!r} score={s:.2f}")
    if s < 0.55:
        print("分数太低，找不到目标会话 -> 中止（不猜）")
        return 1

    x = block["x"] + (block["x2"] - block["x"]) // 2
    y = block["y"] + (block["y2"] - block["y"]) // 2
    if not send.focus_wechat(snap.hwnd):
        print("微信拉不到前台 -> 点击会落到别的窗口上，中止")
        return 1
    print(f"点击行内点 ({x},{y}) -> 屏幕 {snap.to_screen(x, y)}")
    keys.click(*snap.to_screen(x, y))

    import time
    time.sleep(1.2)

    snap2 = vision.capture()
    if snap2 is None:
        print("点开后抓图失败")
        return 1

    ok, detail = send.verify_title(snap2, target)
    print(f"标题校验 {'通过' if ok else '失败'}：{detail}")
    if not ok:
        print("标题不符 -> 中止（这一步防的就是点错人）")
        return 1

    lines = snap2.message_lines()
    print(f"消息区读到 {len(lines)} 行，最后 3 行：")
    for ln in lines[-3:]:
        print(f"  y={ln['y']:>4} {ln['text']!r}")

    print(f"\n输入框点击点 {send.input_click_point(snap2)}")
    print(f"输入框校验区 {send.input_region(snap2)}")
    send.clear_input(snap2)

    print(f"\n输入测试文本：{TEST_TEXT!r}")
    ok, metrics, actual = send.type_and_verify(TEST_TEXT)
    print(f"回读校验 {'通过' if ok else '失败'}：{metrics}")
    print(f"  实际读到：{actual!r}")

    print("\n清空输入框，不按回车")
    snap3 = vision.capture()
    if snap3 is not None:
        send.clear_input(snap3)
        left = send.input_region(snap3)
        after = "".join(l["text"] for l in snap3.ocr_rows(left))
        print(f"  清空后回读：{after!r}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
