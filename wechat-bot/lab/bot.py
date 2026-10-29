"""
主循环：检测未读 -> 认人 -> 打开会话 -> 校验标题 -> 读消息 -> 生成 -> 校验 -> 发送。

感知分两层，各用各的长处：
  - **有没有未读**：只信像素（layout.detect_badges 的品牌红 ±5 + 连通域面积）。
    实测多模态模型会凭空说某行「有红色未读圆点」，而那一行连一个红像素都没有，
    所以这个判断绝不能交给模型。
  - **读文字**（会话名 / 聊天标题 / 消息 / 输入框回读）：交给多模态模型。
    实测 Windows OCR 在微信上不可靠：标题区读不出任何字、会话列表把「消息预览」
    当成「会话名」（把 G 那条会话的预览『你是谁』当成名字，而它真名就是一个字母 G）、
    输入框回读把文字读得支离破碎。用 OCR 当闸门会让所有回复被误杀，于是有人
    干脆把白名单/标题校验/输入校验三个闸全关了 —— 那等于对任何人发没校验过的内容。

默认 dry-run：走到输入校验通过，不按回车。要真发必须显式 --live。

用法：
  python bot.py once [--live]
  python bot.py watch [--live]
  python bot.py stop|resume|status
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import guard
import llm
import send
import vision
import vlm

PANIC_VK = 0x53  # S
PANIC_MODS = (0x11, 0x12, 0x10)  # Ctrl+Alt+Shift


def panic_pressed():
    """热键急停：Ctrl+Alt+Shift+S。"""
    import ctypes
    u = ctypes.WinDLL("user32")
    if not all(u.GetAsyncKeyState(v) & 0x8000 for v in PANIC_MODS):
        return False
    return bool(u.GetAsyncKeyState(PANIC_VK) & 0x8000)


def format_history(msgs):
    """把 [('左'|'右', 内容)] 拼成给模型看的历史。

    只认气泡左右：微信里靠左是对方、靠右是我自己。模型对昵称的标注不稳定
    （同一条消息一会标「我」一会标「你」），靠昵称判断会把自己的话当来信。
    """
    return "\n".join(("对方: " if side == "左" else "我: ") + c for side, c in msgs)


def make_read_input(lcfg):
    def read_input(snap):
        return vlm.read_input_box(snap.img, send.input_region(snap), lcfg)
    return read_input


def handle_badge(cfg, lcfg, g, snap, badge, live, log):
    row_center = (badge[1] + badge[3]) // 2

    name, err = vlm.read_session_name(snap.img, badge, snap.regions["session"], lcfg)
    if not name:
        log(f"  角标 {badge}（行 y≈{row_center}）读不出会话名 -> 跳过（不猜）：{err}")
        guard.log_event(event="name-unreadable", badge=list(badge), err=err)
        return False
    log(f"  角标 {badge}（行 y≈{row_center}）-> 会话名 {name!r}")

    for bad in cfg["blacklist"]:
        if guard.score(name, bad) >= cfg["whitelistThreshold"]:
            log(f"  会话 {name!r} 命中黑名单 {bad!r} -> 不回")
            guard.log_event(event="blacklist-hit", name=name, pattern=bad)
            return False

    if cfg.get("replyToAll"):
        chat = name
        log(f"  [回复所有私聊] 不校验白名单，目标 {chat!r}")
    else:
        chat = guard.match_whitelist(name, cfg["whitelist"],
                                     cfg["whitelistThreshold"],
                                     cfg["whitelistLead"])
        if chat is None:
            log(f"  会话 {name!r} 不在白名单 {cfg['whitelist']} -> 只记日志，不回")
            guard.log_event(event="whitelist-miss", name=name)
            return False

    ok, why = g.check(chat)
    if not ok:
        log(f"  {chat} 被护栏拦下：{why} -> 不回")
        guard.log_event(event="guard-block", chat=chat, reason=why)
        return False

    prev_fg = send.remember_foreground()

    # 点之前再抓一次：读会话名要一两秒，这期间列表可能重排，角标位置就换了人。
    # 但**角标消失不等于重排** —— 微信在前台、且当前打开的会话正好有未读时，
    # 一聚焦那条未读就被标记成已读、角标消失。所以这里只用来「优先用新位置」，
    # 绝不因为角标不见就放弃；点错人的兜底是下面的标题校验。
    fresh = vision.capture()
    if fresh is None:
        raise send.Abort("点击前抓图失败")
    near = [b for b in fresh.badges()
            if abs((b[1] + b[3]) // 2 - row_center) <= 20]
    if near:
        send.open_chat(fresh, near[0])
    else:
        log("  角标已消失（多半是聚焦后被标为已读）-> 仍按原位点击，标题校验兜底")
        guard.log_event(event="badge-gone", chat=chat, row=row_center)
        send.open_chat(fresh, badge)
    snap2 = vision.capture()
    if snap2 is None:
        raise send.Abort("点开会话后抓图失败")

    info, cerr = vlm.read_chat_pane(snap2.img, snap2, lcfg)
    if not info:
        send.restore_foreground(prev_fg)
        log(f"  读不到聊天标题 -> 中止（无法确认点开的是谁）：{cerr}")
        guard.log_event(event="title-unreadable", chat=chat, err=cerr)
        return False
    title, msgs = info["title"], info["msgs"]

    # 防点错人：拿「列表里读到的名字」和「点开后标题栏的名字」对。这一步和
    # 白名单无关，全量模式同样必须过 —— 列表在读取期间重排过就会在这里露馅。
    if not guard.same_name(title, name):
        send.restore_foreground(prev_fg)
        log(f"  标题校验失败：点开的是 {title!r}，但列表里那一行是 {name!r}"
            f" -> 中止，不发送")
        guard.log_event(event="title-mismatch", chat=chat, name=name, title=title)
        return False
    log(f"  标题校验通过：{title!r} == 列表名 {name!r}")

    if info["group"] and cfg.get("skipGroups", True):
        send.restore_foreground(prev_fg)
        log(f"  {title!r} 是群聊 -> 跳过（只回私聊）")
        guard.log_event(event="group-skip", chat=chat, title=title)
        # 必须记账：不记账未读角标一直在，每轮轮询都会重判一遍。
        # 历史上这里漏了，10 分钟刷出 900+ 条 group-skip 日志。
        last = next((c for side, c in reversed(msgs or []) if side == "左"), None)
        if last:
            g.mark_handled(chat, last)
        return False

    if not msgs:
        send.restore_foreground(prev_fg)
        log(f"  消息区读不到内容 -> 中止（不猜）：{cerr}")
        guard.log_event(event="no-messages", chat=chat, err=cerr)
        return False
    parsed = msgs
    incoming = next((c for side, c in reversed(parsed) if side == "左"), None)
    if not incoming:
        send.restore_foreground(prev_fg)
        log("  最后几条消息里没有对方发的 -> 跳过（可能是我自己发的）")
        guard.log_event(event="no-incoming", chat=chat, msgs=format_history(msgs)[:200])
        return False

    if g.already_handled(chat, incoming):
        send.restore_foreground(prev_fg)
        log(f"  这条消息已经回过 -> 跳过（{incoming!r}）")
        return False

    reply, gerr = llm.generate(incoming, format_history(msgs), cfg=None)
    if not reply:
        send.restore_foreground(prev_fg)
        log(f"  生成失败：{gerr} -> 不回")
        guard.log_event(event="gen-failed", chat=chat, err=gerr)
        return False
    if g.duplicate(chat, reply):
        log("  回复与最近说过的话重复 -> 换一种说法重生成")
        reply2, _ = llm.generate(
            incoming, format_history(msgs) + f"\n（不要再说「{reply}」这种话）")
        if reply2:
            reply = reply2
    log(f"  对方：{incoming!r}")
    log(f"  回复：{reply!r}")

    try:
        send.send_reply(chat, reply, make_read_input(lcfg),
                        dry_run=not live, log=log)
    except send.Abort as exc:
        send.restore_foreground(prev_fg)
        log(f"  发送中止：{exc}")
        guard.log_event(event="send-abort", chat=chat, reason=str(exc))
        return False

    if live:
        g.record(chat, reply)
        g.mark_handled(chat, incoming)
        guard.log_event(event="sent", chat=chat, incoming=incoming, reply=reply)
        log("  已发送")
        # 发完必须让微信失焦，否则同一人再发来的消息会被立刻标为已读，
        # 不产生未读角标，机器人就再也检测不到
        if send.restore_foreground(prev_fg):
            log("  已把前台还给原窗口，让新消息能重新产生角标")
        else:
            log("  还原前台失败，退化为最小化微信")
            send.minimize_wechat(snap)
    else:
        send.restore_foreground(prev_fg)
        log("  [dry-run] 未按回车，未记入已处理")
    return True


def round_once(cfg, lcfg, g, live, log=print):
    if guard.stop_requested():
        log("STOP 文件存在 -> 急停")
        return 0
    if panic_pressed():
        guard.request_stop("热键急停 Ctrl+Alt+Shift+S")
        log("热键急停 -> 写 STOP 退出")
        return 0

    snap = vision.capture()
    if snap is None:
        log("抓不到微信主窗口（可能被关掉或最小化到托盘）")
        return 0

    badges = snap.badges()
    if not badges:
        log("没有未读角标")
        return 0
    log(f"发现 {len(badges)} 个未读角标，缩放 {snap.scale}% 分界列 {snap.boundary}")

    n = 0
    for bd in badges:
        try:
            if handle_badge(cfg, lcfg, g, snap, bd, live, log):
                n += 1
        except send.Abort as exc:
            log(f"  中止：{exc}")
            guard.log_event(event="abort", badge=list(bd), reason=str(exc))
        except Exception as exc:
            log(f"  异常：{type(exc).__name__}: {exc}")
            guard.log_event(event="error", badge=list(bd),
                            err=f"{type(exc).__name__}: {exc}")
        snap = vision.capture() or snap
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["once", "watch", "stop", "resume", "status"])
    ap.add_argument("--live", action="store_true", help="真的按回车发送")
    args = ap.parse_args()

    cfg = guard.load_config()
    g = guard.Guard(cfg)
    lcfg = llm.load_llm_config()

    if args.cmd == "stop":
        guard.request_stop("手动")
        print("已写 STOP，机器人停了")
        return 0
    if args.cmd == "resume":
        guard.clear_stop()
        print("已清 STOP")
        return 0
    if args.cmd == "status":
        print(f"STOP 文件：{'存在（已停）' if guard.stop_requested() else '不存在'}")
        print(f"白名单：{cfg['whitelist']}"
              + ("   [回复所有私聊：不校验白名单]" if cfg.get("replyToAll") else ""))
        print(f"群聊：{'跳过' if cfg.get('skipGroups', True) else '也回'}")
        print(f"轮询间隔：{cfg['pollSeconds']}s  同会话最小间隔："
              f"{cfg['perChatIntervalSeconds']}s  每小时上限：{cfg['maxPerHour']}")
        print(f"感知：未读=像素判据，文字={vlm.VL_MODEL}")
        for chat, st in (g.state.get("chats") or {}).items():
            print(f"  {chat}: 已发 {st.get('consecutive', 0)} 连发，"
                  f"最近处理消息={st.get('lastHandledMsg', '')!r}")
        return 0

    live = args.live
    print("!! LIVE 模式：会真的发消息 !!" if live
          else "dry-run 模式：走到输入校验，不按回车")
    print(f"感知模型 {vlm.VL_MODEL}；未读判定走像素")

    if args.cmd == "once":
        round_once(cfg, lcfg, g, live)
        return 0

    interval = cfg["pollSeconds"]
    print(f"开始轮询，每 {interval}s 一次。Ctrl+C 退出。")
    while True:
        try:
            round_once(cfg, lcfg, g, live)
        except KeyboardInterrupt:
            print("\n退出")
            return 0
        except Exception as exc:
            print(f"轮询异常（继续）：{type(exc).__name__}: {exc}")
        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(main())
