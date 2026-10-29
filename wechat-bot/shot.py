"""
抓微信 4.x 主窗口截图 + 程序化质量判据。

背景：本模型看不了图片，所以不能靠肉眼确认截图是否有效。
这里用「颜色分布」当判据：
  - 全黑 / 单一颜色 / 标准差极低  -> PrintWindow 对这个 Qt 窗口没抓到内容
  - 颜色数和标准差正常            -> 抓到了真实界面

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/shot.py [输出文件名]
"""

import ctypes
import os
import sys
import time
from ctypes import wintypes

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

PW_RENDERFULLCONTENT = 0x00000002
SW_RESTORE = 9
SW_SHOW = 5
SW_SHOWNOACTIVATE = 4
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]

# 主窗口的类名是 Qt51514QWindowIcon；带 Tool/SaveBits/TrayIcon 的都是辅助窗口
MAIN_CLASS = "Qt51514QWindowIcon"


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


def exe_path(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return ""
    finally:
        kernel32.CloseHandle(h)


def enum_wechat_windows():
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        exe = os.path.basename(exe_path(pid.value) or "")
        if exe.lower() not in ("weixin.exe", "wechat.exe"):
            return True
        cls = ctypes.create_unicode_buffer(512)
        user32.GetClassNameW(hwnd, cls, 512)
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, 512)
        r = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        found.append(
            {
                "hwnd": hwnd,
                "pid": pid.value,
                "cls": cls.value,
                "title": title.value,
                "rect": (r.left, r.top, r.right - r.left, r.bottom - r.top),
                "visible": bool(user32.IsWindowVisible(hwnd)),
            }
        )
        return True

    user32.EnumWindows(cb, 0)
    return found


def find_main_window(wins):
    """主窗口 = 类名恰好是 Qt51514QWindowIcon 的那个；标题是「微信」的优先。"""
    cands = [w for w in wins if w["cls"] == MAIN_CLASS]
    if not cands:
        return None
    for w in cands:
        if w["title"] == "微信":
            return w
    return cands[0]


def ensure_visible(win):
    """最小化/移出屏幕时恢复。返回恢复后的 rect。

    **刻意不把窗口拉到前台**（用 SW_SHOWNOACTIVATE 而不是 SetForegroundWindow）。
    原因：微信在前台且当前打开的会话正好有未读时，一聚焦那条未读立刻被标记
    成已读、角标消失，机器人就永远看不到它。PrintWindow 抓被遮挡的窗口没问题，
    所以恢复可见就够，不需要激活。

    真正需要前台的是**点击**（见 send.focus_wechat），那一步单独做。
    """
    l, t, w, h = win["rect"]
    hwnd = win["hwnd"]
    iconic = bool(user32.IsIconic(hwnd))
    # 微信把最小化的窗口扔到 (-25600,-25600)，不是 -32000 那套哨兵值
    offscreen = l <= -20000 or t <= -20000
    if w <= 0 or h <= 0 or iconic or offscreen:
        print(f"  窗口最小化/离屏 rect=({l},{t},{w}x{h}) iconic={iconic}，执行恢复")
        user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
        user32.ShowWindow(hwnd, SW_RESTORE)
        time.sleep(1.8)
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def grab_printwindow(hwnd, w, h):
    hdc_win = user32.GetWindowDC(hwnd)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_win)
    bmp = gdi32.CreateCompatibleBitmap(hdc_win, w, h)
    gdi32.SelectObject(hdc_mem, bmp)

    ok = user32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)

    bmi = BITMAPINFOHEADER()
    bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.biWidth = w
    bmi.biHeight = -h
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0

    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(hdc_mem, bmp, 0, h, buf, ctypes.byref(bmi), 0)

    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(hwnd, hdc_win)
    return ok, img


def grab_screen(rect):
    """直接从屏幕抓（需要窗口在最前面）。"""
    l, t, w, h = rect
    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    bmp = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    gdi32.SelectObject(hdc_mem, bmp)
    gdi32.BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, l, t, 0x00CC0020)  # SRCCOPY

    bmi = BITMAPINFOHEADER()
    bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.biWidth = w
    bmi.biHeight = -h
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(hdc_mem, bmp, 0, h, buf, ctypes.byref(bmi), 0)
    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(0, hdc_screen)
    return img


def stats(img):
    """盲判据：颜色数 + 各通道标准差。全黑图 -> colors=1, stddev=0。"""
    small = img.resize((160, 120))
    colors = len(small.getcolors(maxcolors=160 * 120) or [])
    st = ImageStat.Stat(small)
    stddev = [round(s, 1) for s in st.stddev]
    mean = [round(m, 1) for m in st.mean]
    return {"colors": colors, "stddev": stddev, "mean": mean}


def main():
    out_name = sys.argv[1] if len(sys.argv) > 1 else "wechat.png"
    out_path = os.path.join(HERE, out_name)

    wins = enum_wechat_windows()
    print(f"=== 微信进程顶层窗口 {len(wins)} 个 ===")
    for w in wins:
        l, t, ww, hh = w["rect"]
        if ww > 0 or w["cls"] == MAIN_CLASS:
            print(
                f"  hwnd={w['hwnd']} title={w['title']!r} cls={w['cls']!r} "
                f"rect=({l},{t},{ww}x{hh}) visible={w['visible']}"
            )

    win = find_main_window(wins)
    if not win:
        print("没找到主窗口（class=Qt51514QWindowIcon）")
        return 1

    print(f"\n主窗口 hwnd={win['hwnd']} title={win['title']!r}")
    rect = ensure_visible(win)
    l, t, w, h = rect
    print(f"恢复后 rect=({l},{t},{w}x{h})")
    if w <= 0 or h <= 0:
        print("窗口尺寸仍然无效，放弃")
        return 1

    ok, img = grab_printwindow(win["hwnd"], w, h)
    s = stats(img)
    print(f"\n[PrintWindow] 返回={ok} 尺寸={w}x{h} 颜色数={s['colors']} "
          f"均值={s['mean']} 标准差={s['stddev']}")
    p1 = os.path.join(HERE, "pw-" + out_name)
    img.save(p1)
    print(f"  已存 {p1}")

    # PrintWindow 抓 Qt 窗口常常是黑的，用屏幕抓一份对照
    img2 = grab_screen(rect)
    s2 = stats(img2)
    print(f"[屏幕 BitBlt] 尺寸={w}x{h} 颜色数={s2['colors']} "
          f"均值={s2['mean']} 标准差={s2['stddev']}")
    p2 = os.path.join(HERE, "sc-" + out_name)
    img2.save(p2)
    print(f"  已存 {p2}")

    print()
    if s["colors"] <= 2 or max(s["stddev"]) < 3:
        print("判断：PrintWindow 抓出来是空白/纯色 —— 对 Qt 窗口不可用")
    else:
        print("判断：PrintWindow 抓到了真实内容")
    if s2["colors"] <= 2 or max(s2["stddev"]) < 3:
        print("判断：屏幕抓图也是空白 —— 窗口可能被遮挡或没真正显示")
    else:
        print("判断：屏幕抓图抓到了真实内容")

    return 0


if __name__ == "__main__":
    sys.exit(main())
