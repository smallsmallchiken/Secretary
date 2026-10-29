"""
探测微信 4.x 桌面客户端暴露了多少 UI Automation 控件树。

结论决定技术路线：
  - 控件树可读 -> 走 UIAutomation（不动鼠标、不抢焦点、稳）
  - 控件树是空的 / 只有一层壳 -> 只能走视觉（截图 + 多模态模型 + 模拟点击）

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/probe.py

输出写到 wechat-bot/tree.txt，便于离线分析。
"""

import ctypes
import os
import sys
from ctypes import wintypes

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import uiautomation as auto

auto.SetGlobalSearchTimeout(3)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "tree.txt")

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


def exe_path(pid):
    """拿到进程的可执行文件全路径，用来确认哪个窗口属于 Weixin.exe。"""
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


def rect_of(ctrl):
    try:
        r = ctrl.BoundingRectangle
        return f"({r.left},{r.top})-({r.right},{r.bottom})"
    except Exception:
        return "(?)"


def walk(ctrl, depth, max_depth, out, prefix=""):
    """递归 dump 控件树。到 max_depth 就停，避免爆炸。"""
    try:
        children = ctrl.GetChildren()
    except Exception as e:
        out.append(f"{prefix}  <GetChildren 失败: {e}>")
        return
    for i, c in enumerate(children):
        last = i == len(children) - 1
        branch = "└─" if last else "├─"
        try:
            ctype = c.ControlTypeName
            name = c.Name
            cls = c.ClassName
        except Exception:
            ctype, name, cls = "?", "?", "?"
        out.append(f"{prefix}{branch}[{ctype}] name={name!r} class={cls!r} {rect_of(c)}")
        if depth + 1 < max_depth:
            walk(c, depth + 1, max_depth, out, prefix + ("   " if last else "│  "))


def main():
    lines = []
    root = auto.GetRootControl()

    lines.append("=== 所有顶层窗口 ===")
    wechat_wins = []
    try:
        tops = root.GetChildren()
    except Exception as e:
        lines.append(f"枚举顶层窗口失败: {e}")
        tops = []

    for w in tops:
        try:
            pid = w.ProcessId
        except Exception:
            pid = -1
        exe = exe_path(pid) if pid > 0 else ""
        base = os.path.basename(exe)
        try:
            cls = w.ClassName
            nm = w.Name
        except Exception:
            cls, nm = "?", "?"
        lines.append(f"PID={pid} exe={base!r} class={cls!r} name={nm!r} {rect_of(w)}")
        if base.lower() in ("weixin.exe", "wechat.exe"):
            wechat_wins.append((w, base))

    lines.append("")
    lines.append(f"=== 匹配到 {len(wechat_wins)} 个微信顶层窗口 ===")

    for idx, (w, base) in enumerate(wechat_wins):
        lines.append("")
        try:
            nm = w.Name
            cls = w.ClassName
        except Exception:
            nm, cls = "?", "?"
        lines.append(f"--- 窗口 {idx}: {base} name={nm!r} class={cls!r} {rect_of(w)} ---")
        walk(w, 0, 6, lines)

    text = "\n".join(lines)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)

    print(text[:4000])
    print()
    print(f"... 完整输出已写入 {OUT}（共 {len(lines)} 行）")


if __name__ == "__main__":
    main()
