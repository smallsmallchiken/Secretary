"""
复现「点击后聊天区读不出东西」：抓图 -> 存图 -> 聚焦点击 -> 再抓图 -> 存图
-> 打印两个区域的 OCR 行数 -> 让视觉模型描述整窗。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/probe_click.py [l t r b]
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import llm
import send
import vision
import vlm

DEFAULT_BADGE = (134, 108, 151, 125)  # 第 1 行（会话名 G）


def main():
    badge = (tuple(int(v) for v in sys.argv[1:5]) if len(sys.argv) >= 5
             else DEFAULT_BADGE)
    lcfg = llm.load_llm_config()

    snap = vision.capture()
    if snap is None:
        print("抓不到微信窗口")
        return 1
    print(f"窗口 {snap.rect[2]}x{snap.rect[3]} @({snap.rect[0]},{snap.rect[1]}) "
          f"缩放 {snap.scale}% 分界列 {snap.boundary}")
    print(f"message 区 {snap.regions['message']}   title 区 {snap.regions['title']}")
    b = snap.badges()
    print(f"当前未读角标 {len(b)} 个: {b}")
    snap.img.save("wechat-bot/_pre.png")
    print("点击前整窗已存 wechat-bot/_pre.png")

    prev = send.remember_foreground()
    print(f"\n聚焦微信并点击角标 {badge}（点击点 {__import__('layout').click_point_for_badge(badge, snap.scale)}）")
    send.open_chat(snap, badge)
    time.sleep(1.2)

    s2 = vision.capture()
    if s2 is None:
        print("点击后抓图失败")
        send.restore_foreground(prev)
        return 1
    s2.img.save("wechat-bot/_post.png")
    print("点击后整窗已存 wechat-bot/_post.png")
    print(f"点击后窗口 {s2.rect[2]}x{s2.rect[3]} 分界列 {s2.boundary}")

    n_title = len(s2.ocr_rows(s2.regions["title"]))
    n_msg = len(s2.ocr_rows(s2.regions["message"]))
    print(f"\n标题区 OCR 行数 = {n_title}   消息区 OCR 行数 = {n_msg}")
    print("（消息区 0 行 = 右侧聊天区是空的，说明点击没打开会话）")

    mx1, _, mx2, my2 = s2.regions["message"]
    left = max(0, mx1 - int(90 * s2.k))
    top = max(0, int(20 * s2.k))
    bottom = min(s2.rect[3], my2 + int(60 * s2.k))
    crop_box = (left, top, mx2, bottom)
    crop = s2.img.crop(crop_box)
    print(f"\n聊天栏裁剪 {crop_box} 尺寸 {crop.size}")

    out, err = vlm._ask(lcfg,
                        "这是微信的右侧聊天栏。第一行回答当前会话名（格式「会话名：x」），"
                        "然后每行一条消息「左: 内容」或「右: 内容」。"
                        "如果这一栏是空的或者没有会话打开，就只回答「空的」。",
                        crop, max_tokens=400)
    print("模型对裁剪的回答:", (out or f"失败 {err}")[:300])

    out2, err2 = vlm._ask(lcfg,
                          "这是微信电脑版整窗截图。右侧聊天区顶部显示的会话名是什么？"
                          "右侧聊天区里有几条消息、内容是什么？会话列表第 1 行是哪个会话？"
                          "看不清就说看不清。",
                          s2.img, max_tokens=400)
    print("\n模型对整窗的回答:", (out2 or f"失败 {err2}")[:500])

    send.restore_foreground(prev)
    print("\n已还原前台")
    return 0


if __name__ == "__main__":
    sys.exit(main())
