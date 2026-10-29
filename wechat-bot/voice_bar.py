"""微信「语音条」发送（聊天里那种绿色语音气泡，不是文件）。

原理：微信 4.1.9+ 电脑端支持发语音条，但入口只有「按住说话」——
输入框右侧的按钮 `发语音 ( 按住右 Alt )`。没有上传音频的接口，
所以这里做的是：

    1. 打开目标会话、确保窗口在前台；
    2. 用鼠标按住那个话筒按钮开始录音（等价于人按住不放）；
    3. 把 TTS 的 mp3 播出去，让麦克风拾到（或走立体声混音/虚拟声卡数字化直连）；
    4. 松开鼠标，微信自己把这段录音作为语音条发出去。

为什么不用按住右 Alt：keybd_event 合成的右 Alt 微信收不到（实测录不上），
鼠标按住按钮这条路更接近真人操作。

用法：
    py312/python.exe voice_bar.py <会话名> <mp3路径> [--mix]
        --mix 用「立体声混音」当音源做数字化回环（先要把微信麦克风设为它）
"""

import ctypes
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = os.path.abspath(os.path.join(
    HERE, "..", "tools", "ffmpeg", "ffmpeg-9.0.2-essentials_build", "bin", "ffmpeg.exe"))

SR = 48000
VK_RMENU = 0xA5
KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


# ---------------------------------------------------------------- 鼠标 / 键盘

_user32 = ctypes.WinDLL("user32", use_last_error=True)


def _mouse(flags):
    _user32.mouse_event(flags, 0, 0, 0, 0)


MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


def mouse_hold_start(x, y):
    _user32.SetCursorPos(int(x), int(y))
    time.sleep(0.05)
    _mouse(MOUSEEVENTF_LEFTDOWN)


def mouse_hold_end():
    _mouse(MOUSEEVENTF_LEFTUP)


def right_alt(up=False):
    flags = KEYEVENTF_EXTENDEDKEY | (KEYEVENTF_KEYUP if up else 0)
    _user32.keybd_event(VK_RMENU, 0x38, flags, 0)


# ---------------------------------------------------------------- 音频

def decode_mp3(path):
    import numpy as np
    if not os.path.exists(FFMPEG):
        raise RuntimeError(f"找不到 ffmpeg：{FFMPEG}")
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", path,
         "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
        capture_output=True, check=True).stdout
    if not raw:
        raise RuntimeError("解码得到空音频")
    return np.frombuffer(raw, dtype=np.float32)


def find_input_device(keyword):
    import sounddevice as sd
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0 and keyword in d["name"]:
            return i, d["name"]
    return None, None


def play(wave, device=None):
    import sounddevice as sd
    sd.play(wave, samplerate=SR, device=device, blocking=True)


# ---------------------------------------------------------------- 找按钮

def find_voice_button(gui):
    """返回话筒按钮的 (x, y, w, h)。找不到返回 None。"""
    try:
        import uiautomation as auto
    except ImportError:
        return None
    hwnd = getattr(gui, "main_hwnd", None)
    if not hwnd:
        return None
    win = auto.ControlFromHandle(hwnd)
    if win is None:
        return None
    for depth in (40,):
        btn = win.ButtonControl(searchDepth=depth, Name="发语音 ( 按住右 Alt )")
        if btn.Exists(1, 0.2):
            r = btn.BoundingRectangle
            return (r.left, r.top, r.width(), r.height())
    return None


# ---------------------------------------------------------------- 主流程

def send_voice_bar(chat, mp3_path, use_mix=False, lead=0.9, tail=1.0):
    from wechatauto import WeChatGUI

    wave = decode_mp3(mp3_path)
    log(f"音频时长 {len(wave)/SR:.2f}s，目标会话 {chat!r}")

    gui = WeChatGUI()
    if not gui.ensure_visible():
        return False, "微信窗口不可见"
    if not gui.open_chat(chat):
        return False, f"打不开会话：{chat}"
    time.sleep(0.8)

    btn = find_voice_button(gui)
    if btn:
        log(f"话筒按钮 {btn}")
        x, y = btn[0] + btn[2] // 2, btn[1] + btn[3] // 2
        gui.wx_click(x, y)          # 第一次点：从「输入框」切到「按住说话」态
        time.sleep(0.5)
    else:
        log("没找到话筒按钮，退回按住右 Alt")

    dev = None
    if use_mix:
        dev, name = find_input_device("立体声混音")
        log(f"音源设备：{name}" if dev is not None else "没有立体声混音，退回扬声器外放")

    if btn:
        mouse_hold_start(x, y)
    else:
        right_alt(up=False)
    try:
        time.sleep(lead)            # 等录音真正起来
        log("播放合成语音 ...")
        play(wave)
        time.sleep(tail)            # 尾部留白，避免最后一个字被切
    finally:
        if btn:
            mouse_hold_end()
        else:
            right_alt(up=True)
        log("松开，等待微信把语音发出去 ...")
    time.sleep(2.5)
    return True, "已执行"


def _open_db():
    from wechatauto import WeChatDB
    with open(os.path.join(HERE, "bot-db-config.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    return WeChatDB(db_dir=cfg["dbDir"], account=cfg["account"])


def main():
    argv = sys.argv[1:]
    use_mix = "--mix" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) < 2:
        print("用法：voice_bar.py <会话名> <mp3路径> [--mix]")
        return 1
    chat, mp3 = args[0], args[1]

    db = _open_db()
    chat_id = None
    for s in db.get_sessions(limit=80):
        if (db.get_nickname(s.get("username")) or "") == chat:
            chat_id = s.get("username")
            break
    if not chat_id:
        print(f"找不到会话 {chat!r}")
        return 1

    ok, why = send_voice_bar(chat, mp3, use_mix=use_mix)
    print("执行结果:", ok, why)
    if not ok:
        return 1
    time.sleep(1.5)
    recent = [(m.get("type"), (m.get("content") or "")[:24])
              for m in db.get_messages(chat_id, limit=4)]
    print("发送后最近消息:", recent)
    got = any(t == "语音" for t, _ in recent)
    print("收到语音条:", "是" if got else "否")
    return 0 if got else 2


if __name__ == "__main__":
    sys.exit(main())
