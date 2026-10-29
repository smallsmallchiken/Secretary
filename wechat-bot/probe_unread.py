"""
探测会话列表里的「未读」标记。

微信未读角标是红色圆形（约 #FA5151），静音会话是小红点。
这个脚本扫描会话列表区域找红色像素簇——如果能稳定找到，
「有新消息」这个触发条件就成立，整条自动回复链路才有意义。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/probe_unread.py
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

# 会话列表区域（相对窗口左上角），来自 OCR 布局分析
SESSION_LIST = (90, 90, 380, 640)

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


def is_unread_red(r, g, b):
    """微信未读角标的红：偏亮、红远大于绿蓝。"""
    return r > 190 and g < 150 and b < 150 and (r - g) > 60 and (r - b) > 60


def find_red_blobs(img, region):
    x0, y0, x1, y1 = region
    x1 = min(x1, img.width)
    y1 = min(y1, img.height)
    px = img.load()

    hits = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = px[x, y]
            if is_unread_red(r, g, b):
                hits.append((x, y))

    # 简单聚类：按 y 分桶（同一行的红点归到一个簇）
    if not hits:
        return []

    hits.sort(key=lambda p: (p[1], p[0]))
    blobs = []
    cur = [hits[0]]
    for p in hits[1:]:
        if p[1] - cur[-1][1] <= 3 and p[0] - cur[-1][0] <= 25:
            cur.append(p)
        else:
            blobs.append(cur)
            cur = [p]
    blobs.append(cur)

    out = []
    for blob in blobs:
        if len(blob) < 12:  # 太小的当噪点
            continue
        xs = [p[0] for p in blob]
        ys = [p[1] for p in blob]
        out.append(
            {
                "x": min(xs), "y": min(ys),
                "x2": max(xs), "y2": max(ys),
                "n": len(blob),
            }
        )
    return out


def main():
    win = find_main_window()
    if not win:
        print("没找到微信主窗口")
        return 1
    hwnd = win["hwnd"]
    l, t, w, h = ensure_visible(hwnd)
    print(f"主窗口 hwnd={hwnd} rect=({l},{t},{w}x{h})")

    img = grab(hwnd, w, h)
    img.save(os.path.join(HERE, "unread-src.png"))

    # 先看会话列表区域的颜色分布，确认红角标颜色确实存在
    x0, y0, x1, y1 = SESSION_LIST
    x1, y1 = min(x1, w), min(y1, h)
    region = img.crop((x0, y0, x1, y1))
    colors = region.getcolors(maxcolors=region.width * region.height) or []
    colors.sort(reverse=True)
    print(f"\n=== 会话列表区域 ({x0},{y0})-({x1},{y1}) 出现最多的 12 种颜色 ===")
    for cnt, (r, g, b) in colors[:12]:
        mark = "  <-- 像未读红" if is_unread_red(r, g, b) else ""
        print(f"  #{r:02X}{g:02X}{b:02X}  {cnt:>6} 次{mark}")

    reds = [c for c in colors if is_unread_red(*c[1])]
    print(f"\n红色像素种类数: {len(reds)}，总红色像素: {sum(c[0] for c in reds)}")

    blobs = find_red_blobs(img, SESSION_LIST)
    print(f"\n=== 找到 {len(blobs)} 个红色簇（未读角标候选）===")
    for b in blobs:
        print(
            f"  中心≈({(b['x'] + b['x2']) // 2},{(b['y'] + b['y2']) // 2}) "
            f"框=({b['x']},{b['y']})-({b['x2']},{b['y2']}) 像素={b['n']}"
        )

    if not blobs:
        print("\n判断：当前没有未读角标（或者配色不是这个红）")
    else:
        print("\n判断：未读检测可行，红色簇能定位到具体行")
    return 0


if __name__ == "__main__":
    sys.exit(main())
