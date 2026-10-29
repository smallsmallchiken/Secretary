"""
一次抓图，同时输出「文本色块图」和「OCR 文字+坐标」，两者对齐。

本模型看不了图片，靠这个组合工具建立对界面的认知：
  - 色块图告诉我结构（哪一块是列表、哪一块是对话区）
  - OCR 告诉我语义（那块里写的是什么字）

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/look.py [列数]
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


def classify(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    if g > 120 and g - r > 40 and g - b > 30:
        return "G"
    if r > 170 and r - g > 60 and r - b > 60:
        return "R"
    if b > 140 and b - r > 30 and b - g > 20:
        return "B"
    if mx > 235:
        return "."
    if mx > 215:
        return " "
    if mx < 90:
        return "#"
    if mx < 170:
        return "-"
    return "+"


def render(img, cols):
    w, h = img.size
    rows = max(1, int(cols * (h / w) * 0.5))
    small = img.resize((cols, rows), Image.BOX)
    px = small.load()
    lines = ["".join(classify(*px[rx, ry]) for rx in range(cols)) for ry in range(rows)]
    ruler = "".join(str((i // 10) % 10) if i % 10 == 0 else " " for i in range(cols))
    return lines, ruler, (w / cols, h / rows, rows)


async def ocr(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream.get_output_stream_at(0))
    writer.write_bytes(buf.getvalue())
    await writer.store_async()
    await writer.flush_async()
    stream.seek(0)
    decoder = await BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()
    engine = OcrEngine.try_create_from_language(Language("zh-Hans-CN"))
    if engine is None:
        engine = OcrEngine.try_create_from_user_profile_languages()
    return await engine.recognize_async(bitmap)


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
    img.save(os.path.join(HERE, "look-src.png"))

    lines, ruler, (cw, ch, rows) = render(img, cols)
    print(f"\n=== 色块图（{cols} 列 x {rows} 行，每格 {cw:.1f}x{ch:.1f}px）===")
    print("图例: '.'=亮底 ' '=浅底 '#'=深色 '-'=中灰 '+'=其他 G=绿 R=红 B=蓝")
    print("     " + ruler)
    for i, line in enumerate(lines):
        print(f"{int(i * ch):>4} {line}")
    print("     " + ruler)

    result = asyncio.run(ocr(img))
    rows_txt = []
    for line in result.lines:
        ws = list(line.words)
        if not ws:
            continue
        rows_txt.append(
            {
                "text": line.text,
                "x": int(min(wd.bounding_rect.x for wd in ws)),
                "y": int(min(wd.bounding_rect.y for wd in ws)),
                "x2": int(max(wd.bounding_rect.x + wd.bounding_rect.width for wd in ws)),
                "y2": int(max(wd.bounding_rect.y + wd.bounding_rect.height for wd in ws)),
            }
        )
    rows_txt.sort(key=lambda r: (r["y"], r["x"]))

    print(f"\n=== OCR {len(rows_txt)} 行（坐标相对窗口左上角）===")
    for r in rows_txt:
        # 换算成色块图的列/行，方便和上图对照
        col = int(r["x"] / cw)
        row = int(r["y"] / ch)
        print(
            f"  ({r['x']:>4},{r['y']:>4}) 图[{col:>3},{row:>2}]  {r['text']!r}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
