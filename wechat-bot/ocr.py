"""
微信窗口 OCR：抓图 -> 系统自带 OCR -> 输出每个文本块的内容和包围盒。

这一步是开发的关键：本模型看不了图片，OCR 是我唯一的「眼睛」。
包围盒同时能反推界面布局（会话列表在哪一列 / 消息区在哪 / 输入框在哪）。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/ocr.py
"""

import asyncio
import ctypes
import io
import os
import sys
import time
from ctypes import wintypes

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image

from winrt.windows.globalization import Language
from winrt.windows.graphics.imaging import BitmapDecoder
from winrt.windows.media.ocr import OcrEngine
from winrt.windows.storage.streams import DataWriter, InMemoryRandomAccessStream

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


async def ocr(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = buf.getvalue()

    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream.get_output_stream_at(0))
    writer.write_bytes(data)
    await writer.store_async()
    await writer.flush_async()
    stream.seek(0)

    decoder = await BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()

    engine = OcrEngine.try_create_from_language(Language("zh-Hans-CN"))
    if engine is None:
        engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        raise RuntimeError("系统没有可用的 OCR 引擎")

    return await engine.recognize_async(bitmap)


def main():
    win = find_main_window()
    if not win:
        print("没找到微信主窗口")
        return 1
    hwnd = win["hwnd"]

    rect = ensure_visible(hwnd)
    l, t, w, h = rect
    print(f"主窗口 hwnd={hwnd} rect=({l},{t},{w}x{h})")
    if w <= 0 or h <= 0:
        print("窗口尺寸无效")
        return 1

    img = grab(hwnd, w, h)
    img.save(os.path.join(HERE, "ocr-src.png"))

    result = asyncio.run(ocr(img))

    rows = []
    for line in result.lines:
        words = list(line.words)
        if not words:
            continue
        xs = [wd.bounding_rect.x for wd in words]
        ys = [wd.bounding_rect.y for wd in words]
        xe = [wd.bounding_rect.x + wd.bounding_rect.width for wd in words]
        ye = [wd.bounding_rect.y + wd.bounding_rect.height for wd in words]
        rows.append(
            {
                "text": line.text,
                "x": int(min(xs)),
                "y": int(min(ys)),
                "x2": int(max(xe)),
                "y2": int(max(ye)),
            }
        )

    rows.sort(key=lambda r: (r["y"], r["x"]))

    print(f"\n=== OCR 识别到 {len(rows)} 行文本（窗口坐标，原点=窗口左上角）===")
    for r in rows:
        print(
            f"  x={r['x']:>4} y={r['y']:>4} -> x2={r['x2']:>4} y2={r['y2']:>4}  "
            f"w={r['x2'] - r['x']:>4}  {r['text']!r}"
        )

    # 按 x 起始位置聚类，帮助判断有几栏
    print("\n=== x 起始位置分布（帮助判断列结构）===")
    buckets = {}
    for r in rows:
        b = r["x"] // 50 * 50
        buckets.setdefault(b, []).append(r)
    for b in sorted(buckets):
        print(f"  x∈[{b},{b + 50}) : {len(buckets[b])} 行")

    return 0


if __name__ == "__main__":
    sys.exit(main())
