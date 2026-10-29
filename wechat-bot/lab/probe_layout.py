"""
量环境 + 用移植来的常量验证未读检测。

当前没有未读消息，所以这一步验证的是**不误报**：
之前那 57 个红像素面积只有 14~22px，低于 60 的下限，应当被全部排除。
真正的未读验证需要你那边有人发条消息。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/probe_layout.py
"""

import ctypes
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ctypes import wintypes

import layout
import shot

user32 = ctypes.WinDLL("user32", use_last_error=True)

# 不开 per-monitor v2 的话 Win32 会把坐标按虚拟屏幕缩掉，
# 工作区会读成 1536x864（逻辑）而不是 1920x1080（物理）
try:
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass

try:
    user32.GetDpiForWindow.argtypes = [wintypes.HWND]
    user32.GetDpiForWindow.restype = wintypes.UINT
except AttributeError:
    pass


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


def get_dpi(hwnd):
    try:
        dpi = user32.GetDpiForWindow(hwnd)
        if dpi:
            return dpi
    except Exception:
        pass
    hdc = user32.GetDC(0)
    dpi = ctypes.WinDLL("gdi32").GetDeviceCaps(hdc, 88)
    user32.ReleaseDC(0, hdc)
    return dpi or 96


def main():
    wins = shot.enum_wechat_windows()
    win = shot.find_main_window(wins)
    if not win:
        print("没找到微信主窗口")
        return 1
    rect = shot.ensure_visible(win)
    l, t, w, h = rect
    print(f"微信窗口 hwnd={win['hwnd']} 位置=({l},{t}) 尺寸={w}x{h}")

    dpi = get_dpi(win["hwnd"])
    scale = round(dpi / 96.0 * 100)
    print(f"DPI={dpi} -> 缩放档位约 {scale}%")

    wa = RECT()
    spi = ctypes.WinDLL("user32").SystemParametersInfoW
    spi(0x0030, 0, ctypes.byref(wa), 0)  # SPI_GETWORKAREA
    print(f"工作区 = ({wa.left},{wa.top})-({wa.right},{wa.bottom}) "
          f"即 {wa.right - wa.left}x{wa.bottom - wa.top}")
    print(f"工作区右半 = {max(400, (wa.right - wa.left) // 2)}x"
          f"{max(400, wa.bottom - wa.top)}  (xiaoli 会强制窗口成这个尺寸)")

    print(f"\n=== 区域锚点（k = {scale}/175 = {layout.k_for_scale(scale):.4f}）===")
    ok, img = shot.grab_printwindow(win["hwnd"], w, h)
    st = shot.stats(img)
    print(f"PrintWindow 颜色数={st['colors']} 标准差={st['stddev']}")

    boundary = layout.detect_boundary_x(img, scale)
    print(f"实测分界列 x = {boundary}  "
          f"(静态锚 543.4 x k = {round(543.4 * layout.k_for_scale(scale))})")

    regs = layout.regions_for_window(w, h, scale, boundary)
    for key in ("session", "message", "title"):
        x1, y1, x2, y2 = regs[key]
        print(f"  {key:8s} ({x1:4d},{y1:4d})-({x2:4d},{y2:4d})  "
              f"尺寸 {x2 - x1}x{y2 - y1}")

    print(f"\n=== 未读红圈检测（当前应当没有未读）===")
    amin = layout.area_for_scale(layout.BADGE_AREA_MIN, scale)
    amax = layout.area_for_scale(layout.BADGE_AREA_MAX, scale)
    print(f"面积闸（k²={layout.k_for_scale(scale) ** 2:.3f}）= "
          f"{amin:.0f} ~ {amax:.0f}px")

    allc = layout.red_clusters(img, regs["session"], min_area=1)
    print(f"不限面积、命中品牌红 (250,81,81)±5 的连通域：{len(allc)} 个")
    for l2, t2, r2, b2, n, mean in allc:
        ok = amin <= n <= amax
        print(f"  ({l2},{t2})-({r2},{b2}) {r2 - l2 + 1}x{b2 - t2 + 1} "
              f"像素={n:5d} 均值={mean} {'通过面积闸' if ok else '被面积闸排除'}")

    merged = layout.merge_badges_same_row(
        layout.detect_badges(img, scale, boundary_px=boundary), scale)
    print(f"通过完整判据的未读角标：{len(merged)} 个")
    for b in merged:
        off = round(layout.BADGE_CLICK_OFFSET_X * layout.k_for_scale(scale))
        print(f"  {b}  点击点 = ({b[0] + off}, {(b[1] + b[3]) // 2})")
    if not merged:
        print("  0 个 —— 无未读时无误报")

    return 0


if __name__ == "__main__":
    sys.exit(main())
