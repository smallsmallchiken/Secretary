"""
看清一个红圈簇到底是什么：逐像素字符图 + 真实颜色 + 那一行的 OCR。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/probe_badge.py [l t r b]
不给坐标就用 layout.detect_badges 自己找。
"""

import asyncio
import os
import sys
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # 主链路模块在上一级

import layout
import ocr
import shot

# 必须在任何 Win32 取坐标之前设置，否则坐标被按虚拟屏幕缩掉
# （窗口读成 894x718 逻辑，而布局常量是按物理像素标定的）
import ctypes as _ctypes

_user32 = _ctypes.WinDLL("user32")
try:
    _user32.SetProcessDpiAwarenessContext(_ctypes.c_void_p(-4))
except Exception:
    pass

BADGE = layout.BADGE_RED


def sym(px, tol=layout.BADGE_TOL):
    r, g, b = px
    if all(abs(c - t) <= tol for c, t in zip(px, BADGE)):
        return "R"
    if r > 200 and g < 130 and b < 130:
        return "r"
    if r > 240 and g > 240 and b > 240:
        return "W"
    if r > 200 and g > 200 and b > 200:
        return "."
    if r < 90 and g < 90 and b < 90:
        return "#"
    return "+"


def main():
    wins = shot.enum_wechat_windows()
    win = shot.find_main_window(wins)
    if not win:
        print("没找到微信主窗口")
        return 1
    l, t, w, h = shot.ensure_visible(win)
    print(f"微信窗口 ({l},{t}) {w}x{h}")

    dpi = ctypes_dpi(win["hwnd"])
    scale = round(dpi / 96.0 * 100)
    k = layout.k_for_scale(scale)
    print(f"DPI={dpi} -> {scale}%  k={k:.4f}")

    _, img = shot.grab_printwindow(win["hwnd"], w, h)
    boundary = layout.detect_boundary_x(img, scale)

    if len(sys.argv) == 5:
        box = tuple(int(v) for v in sys.argv[1:5])
    else:
        found = layout.detect_badges(img, scale, boundary_px=boundary)
        if not found:
            print("没找到任何红圈簇")
            return 0
        box = found[0]
    print(f"检查区域 {box}  尺寸 {box[2] - box[0] + 1}x{box[3] - box[1] + 1}")

    m = 6
    x1, y1 = max(0, box[0] - m), max(0, box[1] - m)
    x2, y2 = min(w, box[2] + 1 + m), min(h, box[3] + 1 + m)
    crop = img.crop((x1, y1, x2, y2))
    print(f"\n=== 逐像素字符图（{x1},{y1} 起，R=品牌红±5 r=偏红 W=白 .=浅 #=深 +=其他）===")
    px = crop.load()
    cw, ch = crop.size
    for yy in range(ch):
        print(f"{y1 + yy:4d} " + "".join(sym(px[xx, yy]) for xx in range(cw)))
    print("     " + "".join(str((x1 + xx) // 100 % 10) for xx in range(cw)))
    print("     " + "".join(str((x1 + xx) // 10 % 10) for xx in range(cw)))
    print("     " + "".join(str((x1 + xx) % 10) for xx in range(cw)))

    cnt = Counter(crop.getdata())
    print("\n=== 该区域出现最多的 8 种颜色 ===")
    for c, n in cnt.most_common(8):
        mark = " <== 品牌红" if all(abs(a - b) <= layout.BADGE_TOL
                                 for a, b in zip(c, BADGE)) else ""
        print(f"  {c}  {n:5d}px{mark}")

    print(f"\n=== 这一行的 OCR（y {box[1] - 20} ~ {box[3] + 20}）===")
    strip = img.crop((0, max(0, box[1] - 20), boundary or 384,
                      min(h, box[3] + 20)))
    res = asyncio.run(ocr.ocr(strip))
    lines = []
    for line in res.lines:
        ws = list(line.words)
        if not ws:
            continue
        lines.append((int(min(w.bounding_rect.x for w in ws)),
                      int(min(w.bounding_rect.y for w in ws)), line.text))
    if not lines:
        print("  （没读到文字）")
    for x, y, txt in sorted(lines, key=lambda r: (r[1], r[0])):
        print(f"  x={x:>4} y={y:>4} {txt!r}")

    print("\n=== 该行的颜色分布（看是不是选中高亮 #F0F0F0）===")
    row = img.crop((int(layout.REGION_EDGES['session'][0] * k), box[1],
                    (boundary or 384), box[3] + 1))
    rc = Counter(row.getdata())
    for c, n in rc.most_common(5):
        sel = " <== 接近选中高亮" if layout._color_close(c, layout.ROW_SELECTED) else ""
        print(f"  {c}  {n:5d}px{sel}")
    return 0


def ctypes_dpi(hwnd):
    import ctypes
    import ctypes.wintypes as wt
    u = ctypes.WinDLL("user32")
    try:
        u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        pass
    try:
        u.GetDpiForWindow.argtypes = [wt.HWND]
        u.GetDpiForWindow.restype = wt.UINT
        return u.GetDpiForWindow(hwnd) or 96
    except Exception:
        return 96


if __name__ == "__main__":
    sys.exit(main())
