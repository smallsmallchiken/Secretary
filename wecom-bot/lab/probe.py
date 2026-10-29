"""
探测企业微信（WXWork）的窗口与 UI Automation 控件树。

背景：微信 4.x 是 Qt 自绘（Qt51514QWindowIcon），整个界面渲染成一整块
MMUIRenderSubWindow，控件树只有 2 个节点，UIA 彻底不可用，只能走视觉。

企业微信不同：进程里有 WXWorkWeb.exe（CEF/Chromium），界面是网页渲染的。
Chromium 默认会暴露无障碍树，所以这里有机会直接读到消息控件 —— 那就不用
截图、不用 OCR、不用多模态模型，可靠性和速度都是另一个量级。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wecom-bot/probe.py [最大深度]
"""

import ctypes
import os
import sys
import time
from ctypes import wintypes

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TARGET_EXES = ("wxwork.exe", "wecom-agent.exe", "wxworkweb.exe")

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


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


def enum_windows():
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        exe = os.path.basename(exe_path(pid.value) or "")
        if exe.lower() not in TARGET_EXES:
            return True
        cls = ctypes.create_unicode_buffer(512)
        user32.GetClassNameW(hwnd, cls, 512)
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, 512)
        r = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        found.append({
            "hwnd": hwnd, "pid": pid.value, "exe": exe,
            "cls": cls.value, "title": title.value,
            "rect": (r.left, r.top, r.right - r.left, r.bottom - r.top),
            "visible": bool(user32.IsWindowVisible(hwnd)),
        })
        return True

    user32.EnumWindows(cb, 0)
    return found


def walk(ctrl, depth, max_depth, out, path=""):
    if depth > max_depth:
        return
    try:
        children = ctrl.GetChildren()
    except Exception:
        children = []
    for c in children:
        try:
            name = (c.Name or "").replace("\n", " ")[:70]
            cls = c.ClassName or ""
            r = c.BoundingRectangle
            rect = (r.left, r.top, r.right - r.left, r.bottom - r.top)
            ct = c.ControlTypeName or ""
        except Exception:
            continue
        out.append((depth, ct, cls, name, rect))
        walk(c, depth + 1, max_depth, out, path + "/" + name)


SW_RESTORE = 9
SW_SHOW = 5


def ensure_visible(win):
    """恢复最小化的窗口。企业微信把最小化的窗口扔到 (-25600,-25600)。"""
    l, t, w, h = win["rect"]
    hwnd = win["hwnd"]
    if (w <= 0 or h <= 0 or l <= -20000 or t <= -20000
            or user32.IsIconic(hwnd)):
        print(f"  窗口在哨兵坐标/最小化 ({l},{t},{w}x{h})，执行恢复")
        user32.ShowWindow(hwnd, SW_RESTORE)
        user32.ShowWindow(hwnd, SW_SHOW)
        user32.SetForegroundWindow(hwnd)
        time.sleep(2.0)
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def main():
    max_depth = int(sys.argv[1]) if len(sys.argv) > 1 else 8

    wins = enum_windows()
    print(f"=== 企业微信相关顶层窗口 {len(wins)} 个 ===")
    for w in wins:
        l, t, ww, hh = w["rect"]
        print(f"  hwnd={w['hwnd']} pid={w['pid']} {w['exe']} "
              f"title={w['title']!r} cls={w['cls']!r} "
              f"rect=({l},{t},{ww}x{hh}) visible={w['visible']}")

    main_win = next((w for w in wins
                     if w["cls"] == "WeWorkWindow" and w["title"] == "企业微信"),
                    None)
    if not main_win:
        print("\n没找到 WeWorkWindow")
        return 1
    print(f"\n恢复主窗口 hwnd={main_win['hwnd']} ...")
    rect = ensure_visible(main_win)
    main_win["rect"] = rect
    print(f"  恢复后 rect={rect}")

    try:
        import uiautomation as auto
    except ImportError as exc:
        print(f"\nuiautomation 没装：{exc}")
        return 1
    auto.SetGlobalSearchTimeout(2)

    # 恢复之后再枚举一次：CEF 窗口这时才会出现/可见
    wins2 = enum_windows()
    print(f"\n=== 恢复后重新枚举 ===")
    for w in wins2:
        l, t, ww, hh = w["rect"]
        if ww > 100 and hh > 100:
            print(f"  hwnd={w['hwnd']} {w['exe']} cls={w['cls']!r} "
                  f"({l},{t}) {ww}x{hh} visible={w['visible']}")

    targets = [("WeWorkWindow", main_win["hwnd"])]
    for w in wins2:
        if w["cls"].startswith("Chrome_WidgetWin") and w["rect"][2] > 200:
            targets.append((f"CEF {w['cls']}", w["hwnd"]))

    for label, hwnd in targets:
        print(f"\n=== 控件树 {label} hwnd={hwnd} （深度 <= {max_depth}）===")
        root = auto.ControlFromHandle(hwnd)
        if root is None:
            print("  ControlFromHandle 失败")
            continue
        out = []
        walk(root, 0, max_depth, out)
        print(f"  控件节点 {len(out)} 个")
        for depth, ct, cls, name, rect in out:
            pad = "  " * depth
            print(f"{pad}[{ct}] cls={cls!r} {name!r} {rect}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
