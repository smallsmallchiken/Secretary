"""
视觉层：一次抓图拿到窗口/缩放/分界列/三区域，并在任意区域上做 OCR。

坐标约定：所有坐标都是「窗口内物理像素」，原点 = 窗口客户区左上角。
要点击时用 Snap.to_screen() 换成屏幕绝对坐标。

为什么一定要开 per-monitor v2 DPI 感知：不开的话 Win32 会把坐标按虚拟屏幕
缩掉，125% 缩放下窗口会被读成 894x718（逻辑）而不是 1118x898（物理），
而 layout 的常量全是按物理像素标定的，区域会整体漂到错误位置。
"""

import asyncio
import ctypes
import os
import sys
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import layout
import ocr as ocr_mod
import shot

user32 = ctypes.WinDLL("user32", use_last_error=True)

try:
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass


def get_dpi(hwnd):
    try:
        user32.GetDpiForWindow.argtypes = [wintypes.HWND]
        user32.GetDpiForWindow.restype = wintypes.UINT
        return user32.GetDpiForWindow(hwnd) or 96
    except Exception:
        return 96


def window_alive(hwnd):
    """窗口存活校验：句柄有效 + 可见 + 尺寸合理。

    踩坑记录第 3 条：微信 4.x 的「按 Esc 关闭到托盘」会把窗口隐藏
    （IsWindowVisible=False）而进程还活着。任何注入动作之后都要查这个。
    """
    if not hwnd or not user32.IsWindow(hwnd):
        return False
    if not user32.IsWindowVisible(hwnd):
        return False
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    return w > 200 and h > 200


class Snap:
    """一次抓图的全部结果。"""

    def __init__(self, win, rect, img, scale, boundary, regions):
        self.win = win
        self.hwnd = win["hwnd"]
        self.rect = rect
        self.img = img
        self.scale = scale
        self.k = layout.k_for_scale(scale)
        self.boundary = boundary
        self.regions = regions

    def to_screen(self, x, y):
        """窗口内坐标 -> 屏幕绝对坐标。"""
        return (self.rect[0] + int(x), self.rect[1] + int(y))

    def in_window(self, x, y):
        return 0 <= x < self.rect[2] and 0 <= y < self.rect[3]

    def ocr_rows(self, region):
        """OCR 指定区域，返回窗口坐标的文本行 [{text,x,y,x2,y2}]。"""
        l, t, r, b = region
        if r - l < 4 or b - t < 4:
            return []
        res = asyncio.run(ocr_mod.ocr(self.img.crop((l, t, r, b))))
        rows = []
        for line in res.lines:
            ws = list(line.words)
            if not ws:
                continue
            xs = [w.bounding_rect.x for w in ws]
            ys = [w.bounding_rect.y for w in ws]
            xe = [w.bounding_rect.x + w.bounding_rect.width for w in ws]
            ye = [w.bounding_rect.y + w.bounding_rect.height for w in ws]
            rows.append({
                "text": line.text,
                "x": l + int(min(xs)),
                "y": t + int(min(ys)),
                "x2": l + int(max(xe)),
                "y2": t + int(max(ye)),
            })
        rows.sort(key=lambda r2: (r2["y"], r2["x"]))
        return rows

    def session_blocks(self):
        return self.ocr_rows(self.regions["session"])

    def title_lines(self):
        return self.ocr_rows(self.regions["title"])

    def message_lines(self):
        return self.ocr_rows(self.regions["message"])

    def badges(self):
        return layout.merge_badges_same_row(
            layout.detect_badges(self.img, self.scale,
                                 boundary_px=self.boundary), self.scale)


def capture(restore=True, find=True):
    """抓一张微信主窗口的图。找不到主窗口返回 None。"""
    wins = shot.enum_wechat_windows()
    win = shot.find_main_window(wins)
    if not win:
        return None
    rect = shot.ensure_visible(win) if restore else win["rect"]
    l, t, w, h = rect
    if w <= 0 or h <= 0:
        return None
    if restore:
        # ensure_visible 可能刚把窗口从最小化恢复，重新取一次真实句柄状态
        win = shot.find_main_window(shot.enum_wechat_windows()) or win
    dpi = get_dpi(win["hwnd"])
    scale = round(dpi / 96.0 * 100)
    _, img = shot.grab_printwindow(win["hwnd"], w, h)
    boundary = layout.detect_boundary_x(img, scale)
    regions = layout.regions_for_window(w, h, scale, boundary)
    if not regions:
        return None
    return Snap(win, rect, img, scale, boundary, regions)


if __name__ == "__main__":
    s = capture()
    if s is None:
        print("没找到微信主窗口")
        sys.exit(1)
    print(f"窗口 {s.rect[2]}x{s.rect[3]} @({s.rect[0]},{s.rect[1]}) "
          f"缩放 {s.scale}% k={s.k:.4f} 分界列 {s.boundary}")
    for key in ("session", "message", "title"):
        print(f"  {key:8s} {s.regions[key]}")
    b = s.badges()
    print(f"未读角标 {len(b)} 个: {b}")
    if b:
        blocks = s.session_blocks()
        print(f"会话区 OCR {len(blocks)} 行")
        for bd in b:
            nb = layout.pick_block_near_badge(bd, blocks, s.scale)
            print(f"  角标 {bd} -> 会话名 {nb['text'] if nb else '(锚定失败)'}")
