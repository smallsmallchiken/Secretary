"""
把微信窗口截图降采样成「文本色块图」。

背景：本模型看不了图片，但又必须看清界面布局。
把图像按格子取主色，再映射成字符打印出来，就能用纯文本"看"到结构：
哪一栏是会话列表、哪里是对话区、输入框在哪、有没有未读红角标。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/ascii.py [列数]
"""

import ctypes
import os
import sys
import time
from ctypes import wintypes

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

PW_RENDERFULLCONTENT = 0x00000002
SW_RESTORE = 9
SW_SHOW = 5
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
MAIN_CLASS = "Qt51514QWindowIcon"

user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]


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


def find_main_window():
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
        if cls.value != MAIN_CLASS:
            return True
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, 512)
        found.append({"hwnd": hwnd, "title": title.value})
        return True

    user32.EnumWindows(cb, 0)
    for w in found:
        if w["title"] == "微信":
            return w
    return found[0] if found else None


def ensure_visible(hwnd):
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    l, t, w, h = r.left, r.top, r.right - r.left, r.bottom - r.top
    if w <= 0 or h <= 0 or user32.IsIconic(hwnd) or l <= -20000 or t <= -20000:
        user32.ShowWindow(hwnd, SW_RESTORE)
        user32.ShowWindow(hwnd, SW_SHOW)
        user32.SetForegroundWindow(hwnd)
        time.sleep(1.8)
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def grab(hwnd, w, h):
    hdc_win = user32.GetWindowDC(hwnd)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_win)
    bmp = gdi32.CreateCompatibleBitmap(hdc_win, w, h)
    gdi32.SelectObject(hdc_mem, bmp)
    user32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)

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
    return img


def classify(r, g, b):
    """把颜色归成几类，映射成字符。"""
    mx, mn = max(r, g, b), min(r, g, b)
    sat = mx - mn
    # 绿色（微信品牌绿 / 发送气泡）
    if g > 120 and g - r > 40 and g - b > 30:
        return "G"
    # 红色（未读角标）
    if r > 170 and r - g > 60 and r - b > 60:
        return "R"
    # 蓝色
    if b > 140 and b - r > 30 and b - g > 20:
        return "B"
    # 亮背景
    if mx > 235:
        return "."
    if mx > 215:
        return " "
    # 深色（文字 / 深色气泡）
    if mx < 90:
        return "#"
    if mx < 170:
        return "-"
    return "+"


def render(img, cols):
    w, h = img.size
    # 字符宽高比约 1:2，行数按比例算，避免图被拉长
    rows = max(1, int(cols * (h / w) * 0.5))
    cw, ch = w / cols, h / rows
    small = img.resize((cols, rows), Image.BOX)
    px = small.load()

    lines = []
    for ry in range(rows):
        line = []
        for rx in range(cols):
            line.append(classify(*px[rx, ry]))
        lines.append("".join(line))

    # 标尺：每 10 列标一个数字，方便我数坐标
    ruler = "".join(str((i // 10) % 10) if i % 10 == 0 else " " for i in range(cols))
    return lines, ruler, (w, h, cols, rows, cw, ch)


def main():
    cols = int(sys.argv[1]) if len(sys.argv) > 1 else 110

    win = find_main_window()
    if not win:
        print("没找到微信主窗口")
        return 1
    hwnd = win["hwnd"]
    l, t, w, h = ensure_visible(hwnd)
    print(f"主窗口 hwnd={hwnd} 屏幕位置=({l},{t}) 尺寸={w}x{h}")
    if w <= 0 or h <= 0:
        print("窗口尺寸无效")
        return 1

    img = grab(hwnd, w, h)
    img.save(os.path.join(HERE, "ascii-src.png"))

    lines, ruler, geom = render(img, cols)
    w, h, cols, rows, cw, ch = geom

    print(f"降采样 {cols} 列 x {rows} 行，每格 {cw:.1f}x{ch:.1f} 像素")
    print("图例: '.'=亮底 ' '=浅底 '#'=深色(文字/深气泡) '-'=中灰 '+'=其他 G=绿 R=红 B=蓝")
    print()
    print("     " + ruler)
    for i, line in enumerate(lines):
        y_px = int(i * ch)
        print(f"{y_px:>4} {line}")
    print("     " + ruler)
    print()
    print("列标尺: 每 10 列一个数字；左侧数字是像素 y 坐标")
    return 0


if __name__ == "__main__":
    sys.exit(main())
