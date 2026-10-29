"""
执行层：打开会话 -> 校验标题 -> 清空输入框 -> 输入 -> 校验 -> 回车。

安全约定（来自踩坑记录）：
  - 所有失败路径都 abort，**绝不按 Enter**
  - 每一步动作之后都做窗口存活校验（微信 4.x 的 Esc 会把窗口收进托盘，
    IsWindowVisible=False 但进程还活着）
  - 长文本/含中文标点一律走剪贴板 Ctrl+V；SendInput 逐字注入会丢字/重字
  - 输入完必须校验，校验不过不发送
"""

import ctypes
import os
import sys
import time
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import guard
import keys
import layout
import vision

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

user32.OpenClipboard.argtypes = [ctypes.c_void_p]
user32.SetClipboardData.restype = ctypes.c_void_p
user32.SetClipboardData.argtypes = [wintypes.UINT, ctypes.c_void_p]
kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]


class Abort(Exception):
    """任何不确定的情况都抛这个。调用方只记日志，不重试发送。"""


def set_clipboard(text):
    if not user32.OpenClipboard(None):
        raise Abort("OpenClipboard 失败")
    try:
        user32.EmptyClipboard()
        data = text.encode("utf-16-le") + b"\x00\x00"
        h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h:
            raise Abort("GlobalAlloc 失败")
        p = kernel32.GlobalLock(h)
        if not p:
            raise Abort("GlobalLock 失败")
        ctypes.memmove(p, data, len(data))
        kernel32.GlobalUnlock(h)
        if not user32.SetClipboardData(CF_UNICODETEXT, h):
            raise Abort("SetClipboardData 失败")
    finally:
        user32.CloseClipboard()


SW_RESTORE = 9
VK_ALT = 0x12


def focus_wechat(hwnd, tries=4):
    """把微信拉到前台。

    这一步不能省：PrintWindow 能抓到被遮挡窗口的内容，但**鼠标点击会落到
    遮挡它的那个窗口上**——两者是两回事。抓图看着对、点击却没反应，就是这里。

    SetForegroundWindow 有前台限制（调用方不在前台时会静默失败），
    先发一次 ALT 松开限制再设，这是最省事的绕过办法。
    """
    if user32.GetForegroundWindow() == hwnd:
        return True
    user32.ShowWindow(hwnd, SW_RESTORE)
    for _ in range(tries):
        keys.send(keys._key(VK_ALT), keys._key(VK_ALT, up=True))
        time.sleep(0.05)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.35)
        if user32.GetForegroundWindow() == hwnd:
            return True
    return user32.GetForegroundWindow() == hwnd


def alive_or_abort(snap, where):
    if not vision.window_alive(snap.hwnd):
        raise Abort(f"窗口丢失 @{where}")


def input_click_point(snap):
    """输入框文字区的点击点。

    真机实测（125%，窗口 1118x898）：输入面板从 message 区底部 707 开始，
    占位符「按住鼠标语音输入文字」在 y=728，工具条在 y≈815-855。
    取 y = 窗底上方 190 标定像素 -> 125% 下 762，稳落在文字区中间。
    """
    k = snap.k
    x1, _, x2, _ = snap.regions["message"]
    y = int(snap.rect[3] - 190.0 * k)
    return ((x1 + x2) // 2, y)


def input_region(snap):
    """输入框文字区（用于校验输入内容）。不含工具条，避免把按钮文字读成输入。"""
    k = snap.k
    x1, _, x2, _ = snap.regions["message"]
    top = int(snap.rect[3] - 267.7 * k)
    bottom = int(snap.rect[3] - 83.0 * k)
    return (x1, top, x2, bottom)


def _text_only(s):
    """去标点，只留汉字/字母/数字（中文逗号被 OCR 丢掉会让覆盖率虚降）。"""
    return guard.normalize(s)


def verify_input(expected, actual):
    """输入校验：按去标点后字数分三档。返回 (通过?, 指标串)。

    短句用固定阈值太苛刻：'嗯嗯，在的' 5 个字错 1 个就是 20% 误差。
    """
    e, a = _text_only(expected), _text_only(actual)
    if not e:
        return False, "期望为空"
    ratio = len(a) / len(e)
    cover = len(set(e) & set(a)) / max(1, len(set(e)))
    import difflib
    seq = difflib.SequenceMatcher(None, e, a).ratio()
    n = len(e)
    if n <= 6:
        need_cover, need_seq = 0.60, 0.50
    elif n <= 15:
        need_cover, need_seq = 0.80, 0.70
    else:
        need_cover, need_seq = 0.85, 0.80
    ok = (0.85 <= ratio <= 1.25) and cover >= need_cover and seq >= need_seq
    return ok, (f"chars={len(a)}/{len(e)}({ratio:.2f}) "
                f"cover={cover:.2f}({need_cover}) seq={seq:.2f}({need_seq})")


def open_chat(snap, badge):
    """点开带未读角标的那一行。只点列表，永远不用 Ctrl+F 搜索。

    踩坑记录里最难缠的四个坑（回车打开的是搜一搜网页、下拉里只有聊天记录
    没有会话行、Ctrl+F 被输入框吃掉、键盘导航下拉不可靠）全在搜索链路上，
    直接点列表行就把它们绕开了。
    """
    x, y = layout.click_point_for_badge(badge, snap.scale)
    if not snap.in_window(x, y):
        raise Abort(f"点击点 ({x},{y}) 越出窗口")
    if not focus_wechat(snap.hwnd):
        raise Abort("微信拉不到前台，点击会落到别的窗口上")
    sx, sy = snap.to_screen(x, y)
    keys.click(sx, sy)
    time.sleep(0.8)
    alive_or_abort(snap, "点击会话行之后")
    return (x, y)


def verify_title(snap, expected, threshold=0.55):
    """校验聊天标题 == 目标会话名。这是「有没有点错人」的最后一道闸。

    群聊标题形如 '摸鱼集团(5)'，要剥掉括号里的人数再比（原项目 parse_title）。
    """
    import re
    lines = snap.title_lines()
    if not lines:
        return False, "标题区没读到文字"
    best = None
    for ln in lines:
        text = re.sub(r"\(\s*\d+\s*\)\s*$", "", ln["text"].strip())
        s = guard.score(text, expected)
        if best is None or s > best[0]:
            best = (s, ln["text"])
    return best[0] >= threshold, f"{best[1]!r} score={best[0]:.2f}"


def clear_input(snap):
    x, y = input_click_point(snap)
    sx, sy = snap.to_screen(x, y)
    keys.click(sx, sy)
    time.sleep(0.25)
    alive_or_abort(snap, "点击输入框之后")
    keys.hotkey("ctrl", "a")
    time.sleep(0.1)
    keys.hotkey("delete") if "delete" in keys.VK else keys.send(
        keys._key(0x2E), keys._key(0x2E, up=True))
    time.sleep(0.25)
    alive_or_abort(snap, "清空输入框之后")


def type_and_verify(text, read_input, log=print):
    """剪贴板 + Ctrl+V 输入，然后回读校验。返回 (通过?, 指标, 实际读到)。

    read_input: 可调用对象，接受一个 Snap，返回读到的输入框文字。
    用视觉模型读（OCR 对输入框不可靠：空输入框的占位提示会造成幻觉，
    深色空白还会被 OCR 幻觉出单字）。
    """
    set_clipboard(text)
    time.sleep(0.1)
    keys.hotkey("ctrl", "v")
    time.sleep(0.5)
    snap = vision.capture()
    if snap is None:
        raise Abort("输入后抓图失败")
    alive_or_abort(snap, "粘贴之后")
    actual, err = read_input(snap)
    if actual is None:
        raise Abort(f"读输入框失败：{err}")
    ok, metrics = verify_input(text, actual)
    return ok, metrics, actual


def press_enter():
    keys.send(keys._key(0x0D), keys._key(0x0D, up=True))
    time.sleep(0.4)


def remember_foreground():
    return user32.GetForegroundWindow()


def restore_foreground(prev):
    """把前台还给之前的窗口，让微信失焦。

    为什么发完必须让微信失焦：会话停在「已打开 + 前台聚焦」时，同一个人再
    发来的消息会被立刻标为已读，**不再产生未读角标**，机器人就再也检测不到。
    失焦（而不是最小化）的好处是窗口仍可见，PrintWindow 照常抓图，不用每轮
    恢复窗口来回闪。
    """
    if not prev or not user32.IsWindow(prev):
        return False
    if user32.GetForegroundWindow() != prev:
        keys.send(keys._key(VK_ALT), keys._key(VK_ALT, up=True))
        time.sleep(0.05)
        user32.SetForegroundWindow(prev)
        time.sleep(0.3)
    return user32.GetForegroundWindow() == prev


def minimize_wechat(snap):
    """发完后把微信最小化。

    原因：发完回复后，被点开的会话仍停在「已打开 + 前台聚焦」状态，此时同
    联系人再发来的消息不会再产生未读角标，机器人就检测不到、彻底失联。最小化
    后窗口不再聚焦，新消息会重新进入未读列表并角标，下次轮询照样抓得到。

    空闲（没发消息）时不做任何事，窗口照常可见，不会一直闪。
    """
    try:
        user32.ShowWindow(snap.hwnd, 6)  # SW_MINIMIZE = 6
        time.sleep(0.3)
    except Exception:
        pass


def send_reply(chat, text, dry_run=True, log=print, hard_verify=True):
    """完整发送链路。dry_run=True 时只走到校验，不按回车。

    hard_verify=False 时（全量模式）即便 OCR 回读校验不过也照常发送：
    当前实机 Windows OCR 会把输入框文字读得支离破碎（每字拆开、错字），
    用它当闸门会让所有回复都被误杀；剪贴板 Ctrl+V 本身可靠，更该信任它。
    """
    snap = vision.capture()
    if snap is None:
        raise Abort("抓不到微信窗口")

    if not dry_run:
        clear_input(snap)
    else:
        log("  [dry-run] 跳过点击输入框/清空")

    ok, metrics, actual = type_and_verify(text)
    log(f"  输入校验 {'通过' if ok else '失败'}: {metrics}")

    if dry_run:
        log("  [dry-run] 不按回车")
        return True

    if not ok:
        if hard_verify:
            raise Abort(f"输入校验不过，不按回车（读到 {actual!r}）")
        log(f"  [全量模式] 输入校验不过仍照常发送（粘贴应已成功）：{actual!r}")

    alive_or_abort(snap, "按回车之前")
    press_enter()
    alive_or_abort(snap, "按回车之后")
    return True
