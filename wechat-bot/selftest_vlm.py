"""
端到端自测（不需要未读消息）：拿会话列表第一行的真实位置当假角标，走
「视觉模型认人 -> 点击 -> 视觉模型校验标题 -> 视觉模型读消息」。

不输入、不按回车、不发消息。跑完会把前台还给原来的窗口。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/selftest_vlm.py [假角标 l t r b]
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import guard
import layout
import llm
import send
import vision
import vlm

# 另一 agent 的实机日志里第 1 行真实角标位置就是这一串
DEFAULT_BADGE = (134, 108, 151, 125)


def main():
    cfg = guard.load_config()
    lcfg = llm.load_llm_config()
    badge = (tuple(int(v) for v in sys.argv[1:5]) if len(sys.argv) >= 5
             else DEFAULT_BADGE)
    print(f"感知模型 {vlm.VL_MODEL}")

    snap = vision.capture()
    if snap is None:
        print("抓不到微信主窗口")
        return 1
    print(f"窗口 {snap.rect[2]}x{snap.rect[3]} 缩放 {snap.scale}% 分界列 {snap.boundary}")

    px = layout.detect_badges(snap.img, snap.scale, boundary_px=snap.boundary)
    print(f"真实未读角标：{len(px)} 个 {px}")

    print(f"\n[1] 认人：假角标 {badge}（第 1 行）")
    name, err = vlm.read_session_name(snap.img, badge, snap.regions["session"], lcfg)
    print(f"    会话名 = {name!r}" + (f"  失败：{err}" if not name else ""))
    if not name:
        return 1

    print(f"\n[2] 白名单判定（当前白名单 {cfg['whitelist']}）")
    chat = guard.match_whitelist(name, cfg["whitelist"],
                                 cfg["whitelistThreshold"], cfg["whitelistLead"])
    print(f"    匹配结果 = {chat!r}")
    for w in cfg["whitelist"]:
        print(f"      score({name!r}, {w!r}) = {guard.score(name, w):.3f}")

    print(f"\n[3] 点击并一次读回「标题 + 消息」")
    prev_fg = send.remember_foreground()
    send.open_chat(snap, badge)
    snap2 = vision.capture()
    if snap2 is None:
        print("    点开后抓图失败")
        send.restore_foreground(prev_fg)
        return 1
    info, cerr = vlm.read_chat_pane(snap2.img, snap2, lcfg)
    if info:
        title = info["title"]
        print(f"    聊天标题 = {title!r}  类型 = "
              f"{'群聊' if info['group'] else '私聊'}")
        print(f"    与列表名 {name!r} 同一人？ {guard.same_name(title, name)}")
        print(f"    消息 {len(info['msgs'])} 条：")
        for side, c in info["msgs"]:
            print(f"      [{'对方' if side == '左' else '我'}] {c}")
    else:
        print(f"    读聊天栏失败：{cerr}")

    print(f"\n[4] 输入框回读（当前应当是空的）")
    box, berr = vlm.read_input_box(snap2.img, send.input_region(snap2), lcfg)
    print(f"    读到 = {box!r}" + (f"  失败：{berr}" if box is None else ""))

    send.restore_foreground(prev_fg)
    print("\n已还原前台，未输入、未发送")
    return 0


if __name__ == "__main__":
    sys.exit(main())
