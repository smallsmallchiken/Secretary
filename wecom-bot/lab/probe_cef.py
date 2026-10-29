"""
挖企业微信的窗口层级，找 CEF 的渲染窗口（Chrome_RenderWidgetHostHWND）。

目的：Chromium 只在检测到辅助技术时才构建无障碍树。uiautomation 查顶层
窗口不一定会唤醒它。这里把子窗口全枚举出来，并对渲染窗口显式发
WM_GETOBJECT(OBJID_CLIENT) —— 这是 Chromium 判定「有 AT 在访问」的信号之一。
然后再重查一次控件树，看能不能读到消息列表。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wecom-bot/probe_cef.py
"""

import ctypes
import os
import sys
import time
from ctypes import wintypes

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import probe as P

user32 = P.user32

WM_GETOBJECT = 0x003D
OBJID_CLIENT = 0xFFFFFFFC
SW_RESTORE = 9


def children(hwnd, depth=0, max_depth=6, out=None):
    if out is None:
        out = []
    if depth > max_depth:
        return out

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(child, _):
        cls = ctypes.create_unicode_buffer(512)
        user32.GetClassNameW(child, cls, 512)
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(child, title, 512)
        r = wintypes.RECT()
        user32.GetWindowRect(child, ctypes.byref(r))
        out.append((depth, child, cls.value, title.value,
                    (r.left, r.top, r.right - r.left, r.bottom - r.top),
                    bool(user32.IsWindowVisible(child))))
        children(child, depth + 1, max_depth, out)
        return True

    user32.EnumChildWindows(hwnd, cb, 0)
    return out


def main():
    wins = P.enum_windows()
    main_win = next((w for w in wins
                     if w["cls"] == "WeWorkWindow" and w["title"] == "企业微信"),
                    None)
    if not main_win:
        print("没找到 WeWorkWindow")
        return 1
    P.ensure_visible(main_win)
    time.sleep(1.5)

    wins2 = P.enum_windows()
    cef = next((w for w in wins2
                if w["cls"].startswith("Chrome_WidgetWin") and w["rect"][2] > 200),
               None)
    print(f"CEF 顶层窗口：{cef['hwnd'] if cef else None} "
          f"{cef['rect'] if cef else ''} visible={cef['visible'] if cef else ''}")

    for label, root in (("WeWorkWindow", main_win["hwnd"]),
                        ("CEF 顶层", cef["hwnd"] if cef else None)):
        if not root:
            continue
        print(f"\n=== {label} hwnd={root} 的子窗口 ===")
        kids = children(root)
        print(f"  共 {len(kids)} 个")
        for depth, hwnd, cls, title, rect, vis in kids:
            mark = ""
            if "RenderWidgetHost" in cls:
                mark = "   <== CEF 渲染窗口"
            print(f"  {'  ' * depth}hwnd={hwnd} cls={cls!r} "
                  f"title={title[:30]!r} {rect} vis={vis}{mark}")

    # 对渲染窗口发 WM_GETOBJECT，唤醒 Chromium 的无障碍
    renders = [k for k in children(main_win["hwnd"]) if "RenderWidgetHost" in k[2]]
    if cef:
        renders += [k for k in children(cef["hwnd"]) if "RenderWidgetHost" in k[2]]
    print(f"\n找到 {len(renders)} 个渲染窗口，逐个发 WM_GETOBJECT(OBJID_CLIENT)")
    for _, hwnd, cls, *_ in renders:
        res = user32.SendMessageW(hwnd, WM_GETOBJECT, 0, OBJID_CLIENT)
        print(f"  hwnd={hwnd} -> 返回 {res}")

    if not renders:
        print("  没找到渲染窗口，试试对顶层窗口发")
        for h in filter(None, (main_win["hwnd"], cef["hwnd"] if cef else None)):
            res = user32.SendMessageW(h, WM_GETOBJECT, 0, OBJID_CLIENT)
            print(f"  hwnd={h} -> 返回 {res}")

    time.sleep(2.0)

    try:
        import uiautomation as auto
    except ImportError as exc:
        print(f"uiautomation 没装：{exc}")
        return 1
    auto.SetGlobalSearchTimeout(2)

    print("\n=== 唤醒后重查控件树 ===")
    for label, hwnd in (("WeWorkWindow", main_win["hwnd"]),
                        ("CEF 顶层", cef["hwnd"] if cef else None)):
        if not hwnd:
            continue
        root = auto.ControlFromHandle(hwnd)
        out = []
        if root is not None:
            P.walk(root, 0, 8, out)
        print(f"\n  {label}: {len(out)} 个节点")
        for depth, ct, cls, name, rect in out[:60]:
            print(f"  {'  ' * depth}[{ct}] cls={cls!r} {name!r} {rect}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
