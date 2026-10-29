"""
第二轮探测：把微信主窗口恢复出来再 dump 控件树。

第一轮探测时微信窗口是最小化状态（rect 全 0、坐标是负哨兵值），
控件树为空可能只是因为没渲染，不能据此下结论。
这轮先 ShowWindow(SW_RESTORE) 再测，排除假阴性。
"""

import ctypes
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import uiautomation as auto

auto.SetGlobalSearchTimeout(3)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "tree2.txt")

user32 = ctypes.WinDLL("user32", use_last_error=True)
SW_RESTORE = 9
SW_SHOW = 5


def rect_of(ctrl):
    try:
        r = ctrl.BoundingRectangle
        return f"({r.left},{r.top})-({r.right},{r.bottom})"
    except Exception:
        return "(?)"


def walk(ctrl, depth, max_depth, out, prefix=""):
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

    # 找出微信的顶层窗口
    targets = []
    for w in root.GetChildren():
        try:
            cls = w.ClassName or ""
            nm = w.Name or ""
        except Exception:
            continue
        if "QWindowIcon" in cls or nm == "微信":
            targets.append(w)

    lines.append(f"=== 找到 {len(targets)} 个候选微信窗口，尝试恢复 ===")

    for w in targets:
        try:
            hwnd = w.NativeWindowHandle
        except Exception:
            hwnd = 0
        before = rect_of(w)
        if hwnd:
            user32.ShowWindow(hwnd, SW_RESTORE)
            user32.ShowWindow(hwnd, SW_SHOW)
            user32.SetForegroundWindow(hwnd)
        time.sleep(1.2)
        lines.append(
            f"hwnd={hwnd} class={w.ClassName!r} name={w.Name!r} 恢复前={before} 恢复后={rect_of(w)}"
        )

    time.sleep(1.5)

    # 恢复后再枚举一遍顶层窗口
    lines.append("")
    lines.append("=== 恢复后重新枚举顶层窗口 ===")
    for w in root.GetChildren():
        try:
            cls = w.ClassName or ""
            nm = w.Name or ""
            pid = w.ProcessId
        except Exception:
            continue
        if "QWindowIcon" in cls or nm in ("微信", "Weixin"):
            lines.append(f"PID={pid} class={cls!r} name={nm!r} {rect_of(w)}")

    # 对恢复后的微信窗口 dump 树
    for idx, w in enumerate(targets):
        lines.append("")
        try:
            nm, cls = w.Name, w.ClassName
        except Exception:
            nm, cls = "?", "?"
        lines.append(f"--- 窗口 {idx} 恢复后: name={nm!r} class={cls!r} {rect_of(w)} ---")
        walk(w, 0, 7, lines)

    text = "\n".join(lines)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)

    print(text[:6000])
    print()
    print(f"... 完整输出已写入 {OUT}（共 {len(lines)} 行）")


if __name__ == "__main__":
    main()
