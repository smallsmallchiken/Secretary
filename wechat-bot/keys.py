"""
键盘/鼠标注入（Win32 SendInput）。

自动回复要用它做三件事：
  1. 按热键把微信主窗口唤起来
  2. 在输入框里打字（中文必须用 KEYEVENTF_UNICODE，不能用虚拟键码）
  3. 点击会话列表里的某个会话

用法（测试）：
  python keys.py hotkey ctrl alt w      # 发 Ctrl+Alt+W
  python keys.py type "你好"            # 打字
  python keys.py click 500 300          # 点击
"""

import ctypes
import sys
import time
from ctypes import wintypes

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

user32 = ctypes.WinDLL("user32", use_last_error=True)

INPUT_KEYBOARD = 1
INPUT_MOUSE = 0
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_EXTENDEDKEY = 0x0001
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]

VK = {
    "ctrl": 0x11,
    "alt": 0x12,
    "shift": 0x10,
    "win": 0x5B,
    "enter": 0x0D,
    "esc": 0x1B,
    "tab": 0x09,
    "space": 0x20,
    "backspace": 0x08,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
}


def _key(vk, up=False, extended=False):
    flags = (KEYEVENTF_KEYUP if up else 0) | (KEYEVENTF_EXTENDEDKEY if extended else 0)
    inp = INPUT(type=INPUT_KEYBOARD)
    inp.ki = KEYBDINPUT(wVk=vk, wScan=0, dwFlags=flags, time=0, dwExtraInfo=0)
    return inp


def _unicode_char(ch, up=False):
    inp = INPUT(type=INPUT_KEYBOARD)
    inp.ki = KEYBDINPUT(
        wVk=0,
        wScan=ord(ch),
        dwFlags=KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if up else 0),
        time=0,
        dwExtraInfo=0,
    )
    return inp


def send(*inputs):
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    sent = user32.SendInput(n, arr, ctypes.sizeof(INPUT))
    if sent != n:
        raise RuntimeError(f"SendInput 只送出 {sent}/{n} 个事件，错误码 {ctypes.get_last_error()}")


def hotkey(*names):
    """按组合键，例如 hotkey('ctrl','alt','w')。"""
    vks = []
    for n in names:
        n = n.lower()
        if n in VK:
            vks.append(VK[n])
        elif len(n) == 1:
            vks.append(ord(n.upper()))
        else:
            raise ValueError(f"不认识按键: {n}")

    downs = [_key(vk) for vk in vks]
    ups = [_key(vk, up=True) for vk in reversed(vks)]
    send(*downs)
    time.sleep(0.05)
    send(*ups)


def type_text(text, per_char_delay=0.012):
    """用 Unicode 扫描码打字，中文/emoji 都能过。"""
    for ch in text:
        send(_unicode_char(ch), _unicode_char(ch, up=True))
        time.sleep(per_char_delay)


def click(x, y):
    """绝对坐标点击（屏幕坐标，左上角为原点）。"""
    sw = user32.GetSystemMetrics(0)
    sh = user32.GetSystemMetrics(1)
    ax = int(x * 65535 / (sw - 1))
    ay = int(y * 65535 / (sh - 1))

    move = INPUT(type=INPUT_MOUSE)
    move.mi = MOUSEINPUT(
        dx=ax, dy=ay, mouseData=0,
        dwFlags=MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, time=0, dwExtraInfo=0,
    )
    down = INPUT(type=INPUT_MOUSE)
    down.mi = MOUSEINPUT(
        dx=ax, dy=ay, mouseData=0,
        dwFlags=MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE, time=0, dwExtraInfo=0,
    )
    up = INPUT(type=INPUT_MOUSE)
    up.mi = MOUSEINPUT(
        dx=ax, dy=ay, mouseData=0,
        dwFlags=MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE, time=0, dwExtraInfo=0,
    )
    send(move)
    time.sleep(0.05)
    send(down)
    time.sleep(0.05)
    send(up)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    if cmd == "hotkey":
        hotkey(*sys.argv[2:])
        print("已发送组合键", sys.argv[2:])
    elif cmd == "type":
        type_text(sys.argv[2])
        print("已输入", len(sys.argv[2]), "个字符")
    elif cmd == "click":
        click(int(sys.argv[2]), int(sys.argv[3]))
        print("已点击", sys.argv[2], sys.argv[3])
    else:
        print("未知命令", cmd)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
