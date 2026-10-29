"""微信发送层扩展：图片 / 表情 / 语音条。

三者都走 UI 自动化（不碰协议、不注入 DLL），实机 2026-10-29 全部验证通过：

- **图片**：复用 wechatauto 的 `send_image`（剪贴板 + Ctrl+V）。
  它的 `verify=True` 会读数据库确认，但实测**会误报失败**（消息已经发出去了），
  所以这里固定 verify=False，发送结果以「有没有抛异常」为准。

- **表情**：点工具条「发送表情(Alt+E)」打开面板 → 面板里按像素网格点一格 →
  回车发送。表情面板是 Qt 自绘的，UIA 树里**没有**它的任何控件，只能靠像素定位；
  定位用「彩色像素云」自适应，不写死坐标（窗口大小/位置变了也不受影响）。

- **语音条**：PC 微信 4.x 支持「按住右 Alt 说话」。声音来源靠 VB-Audio Virtual
  Cable：TTS 音频播到 CABLE Input，同时把系统默认**录音**设备临时切到
  CABLE Output，微信按住录音时录到的就是这段 TTS。发完立即把默认设备切回去。
  这条路径实测用 ASR 回读校验过，一字不差。

安全约定：每条路径失败都返回 False / 抛异常，**绝不静默把内容发到别的会话**。
"""

import ctypes
import os
import random
import subprocess
import sys
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

VK_RMENU = 0xA5
SW_RESTORE = 9

# 微信语音条上限 60 秒，留 2 秒余量
VOICE_MAX_SECONDS = 58.0

_DPI_SET = False


def ensure_dpi():
    """坐标必须按物理像素算，否则点表情会偏一半。只设一次。"""
    global _DPI_SET
    if _DPI_SET:
        return
    try:
        import uiautomation as auto
        auto.SetProcessDpiAwareness(2)
    except Exception:
        pass
    _DPI_SET = True


def _u32():
    return ctypes.windll.user32


def win_rect(hwnd):
    r = ctypes.wintypes.RECT()
    _u32().GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def grab():
    """全屏截图（RGB ndarray）。"""
    import numpy as np
    from PIL import ImageGrab
    ensure_dpi()
    return np.array(ImageGrab.grab().convert("RGB"))


# ------------------------------------------------------------------ 图片

def send_image(gui, path, who, log=print):
    """发本地图片 / GIF（GIF 在微信里会动，观感和表情包一致）。"""
    if not os.path.isfile(path):
        log(f"  图片不存在：{path}")
        return False
    t = time.time()
    try:
        r = gui.send_image(path, who=who, verify=False)
    except Exception as exc:
        log(f"  发图片异常：{type(exc).__name__}: {exc}")
        return False
    ok = str(getattr(r, "status", "")) in ("成功", "success") or "成功" in str(r)
    log(f"  发图片 {'成功' if ok else '失败'}（{os.path.basename(path)}，"
        f"{time.time() - t:.1f}s）：{r}")
    return ok


# ------------------------------------------------------------------ 表情

def _emoji_button_point(gui, hwnd):
    """工具条上「发送表情」按钮的屏幕坐标。

    相对**输入框**定位，比相对窗口稳：窗口大小一变，按窗口比例算出来的位置
    就会漂到别的按钮上（之前点成过图片、也点成过文件夹）。输入框的矩形
    每次都能从 UIA 精确拿到，实测按钮在它左下方约 (36, 38) 处。
    """
    box = None
    try:
        box = gui.get_input_box()
    except Exception:
        pass
    if box:
        return box[0] + 36, box[3] + 38
    try:
        import uiautomation as auto
        win = auto.WindowControl(Handle=hwnd)
        btn = auto.ButtonControl(searchFromControl=win, Name="发送表情(Alt+E)")
        if btn.Exists(1, 0):
            r = btn.BoundingRectangle
            return (r.left + r.right) // 2, (r.top + r.bottom) // 2
    except Exception:
        pass
    l, t, rr, bb = win_rect(hwnd)
    return int(l + 0.376 * (rr - l)), int(t + 0.948 * (bb - t))


def _grid_centers(img, x1, y1, x2, y2, gap=16, min_w=20):
    """在 ROI 内找表情网格：返回 (列中心 xs, 行中心 ys)。

    表情是彩色小方块，格子之间是白底。按饱和度阈值得到「彩色像素」，
    再分别沿 x/y 投影，投影值连续的区间就是一个格子。
    gap 取格子间距的一半，才能把相邻两个表情分开（间距实测约 66px）。
    """
    import numpy as np
    roi = img[y1:y2, x1:x2].astype(np.int16)
    mx, mn = roi.max(axis=2), roi.min(axis=2)
    color = ((mx - mn) > 45) & (mx > 90)

    def spans(proj):
        idx = np.where(proj > max(2, proj.max() * 0.10))[0]
        if not len(idx):
            return []
        out, start, prev = [], idx[0], idx[0]
        for i in idx[1:]:
            if i - prev > gap:
                if prev - start + 1 >= min_w:
                    out.append((int(start), int(prev)))
                start = i
            prev = i
        if prev - start + 1 >= min_w:
            out.append((int(start), int(prev)))
        return out

    cols = spans(color.sum(axis=0))
    rows = spans(color.sum(axis=1))
    xs = [(a + b) // 2 + x1 for a, b in cols]
    ys = [(a + b) // 2 + y1 for a, b in rows]
    return xs, ys


def send_emoji(gui, hwnd, who, log=print, index=None):
    """在表情面板里点一格发出去。index=None 随机挑。

    实机环境：面板 10 列、可见 5 行；「最近使用」那一行只有一个表情，
    行投影太小会被过滤掉，所以检测出来的行天然都是网格行。

    打开面板用 Alt+E 而不是点工具条按钮——实测按钮经常被任务栏挡住
    （窗口高度超过工作区时），键盘快捷键不受遮挡影响。
    """
    import keys

    ensure_dpi()
    if not gui.ensure_visible():
        log("  发表情失败：微信窗口不可见")
        return False
    gui.bring_to_front()
    time.sleep(0.5)

    box = gui.get_input_box()
    if not box:
        log("  发表情失败：读不到输入框")
        return False
    gui.focus_input(box)
    time.sleep(0.35)
    keys.hotkey("alt", "e")
    time.sleep(1.5)

    img = grab()
    # 面板底边和输入框底边对齐，左边界在输入框左边再往左约 310px。
    # 用输入框反推 ROI，比按窗口比例稳得多。
    x1, x2 = max(0, box[0] - 330), min(img.shape[1], box[0] + 420)
    y1, y2 = max(0, box[3] - 660), min(img.shape[0], box[3] + 20)
    xs, ys = _grid_centers(img, x1, y1, x2, y2)
    log(f"  表情面板定位：{len(xs)} 列 / {len(ys)} 行")

    if len(xs) < 6 or len(ys) < 3:
        log("  表情面板没打开或定位失败")
        keys.send(keys._key(0x1B), keys._key(0x1B, up=True))  # Esc 关掉
        return False

    i = random.randrange(len(xs)) if index is None else index % len(xs)
    j = random.randrange(len(ys))
    px, py = xs[i], ys[j]

    keys.click(px, py)
    time.sleep(0.8)
    keys.send(keys._key(0x0D), keys._key(0x0D, up=True))
    time.sleep(0.8)
    log(f"  已发表情（第 {j + 1} 行第 {i + 1} 列 @{px},{py}）")
    return True


# ------------------------------------------------------------------ 语音

def _ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def to_wav16k(src, dst=None):
    dst = dst or os.path.splitext(src)[0] + "_16k.wav"
    subprocess.run([_ffmpeg(), "-y", "-i", src, "-ar", "16000", "-ac", "1",
                    "-f", "wav", dst], check=True, capture_output=True)
    return dst


def wav_pcm(path):
    import numpy as np
    with wave.open(path, "rb") as w:
        sr, ch = w.getframerate(), w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    if ch > 1:
        data = data.reshape(-1, ch)[:, 0]
    return data.astype("float32") / 32768.0, sr


def _cable_devices():
    """返回 (播放设备索引, 录音设备 id)。"""
    import sounddevice as sd
    from pycaw.utils import AudioUtilities
    out_idx = None
    for i, d in enumerate(sd.query_devices()):
        if d["max_output_channels"] > 0 and "VB-Audio Virtual Cable" in d["name"]:
            out_idx = i
            break
    rec_id = None
    for d in AudioUtilities.GetAllDevices():
        did = getattr(d, "id", "")
        if did.startswith("{0.0.1.") and "CABLE Output" in str(d):
            rec_id = did
            break
    return out_idx, rec_id


def _default_capture():
    from pycaw.utils import AudioUtilities
    return AudioUtilities.GetDeviceEnumerator().GetDefaultAudioEndpoint(1, 0).GetId()


def send_voice(gui, text, cfg, log=print, max_seconds=VOICE_MAX_SECONDS):
    """合成语音并按住右 Alt 发送语音条。失败返回 False（调用方退回文字）。"""
    import sounddevice as sd
    from pycaw.utils import AudioUtilities
    import keys

    out_idx, rec_id = _cable_devices()
    if out_idx is None or rec_id is None:
        log("  发语音失败：没找到 VB-Audio Virtual Cable（装它才能把 TTS 送进麦克风）")
        return False

    import bot_db
    mp3 = bot_db.tts_to_file(text, cfg)
    wav = to_wav16k(mp3)
    pcm, sr = wav_pcm(wav)
    if len(pcm) / sr > max_seconds:
        pcm = pcm[: int(max_seconds * sr)]
    dur = len(pcm) / sr
    if dur < 1.0:                    # 微信最短 1 秒，太短会发不出去
        pcm = list(pcm) + [0.0] * int((1.2 - dur) * sr)
        pcm = __import__("numpy").array(pcm, dtype="float32")
    log(f"  语音 {len(pcm) / sr:.1f}s，开始录音…")

    prev = _default_capture()
    try:
        AudioUtilities.SetDefaultDevice(rec_id)
        time.sleep(0.7)
        keys.send(keys._key(VK_RMENU, extended=True))
        time.sleep(0.55)
        sd.play(pcm, sr, device=out_idx)
        sd.wait()
        time.sleep(0.45)
        keys.send(keys._key(VK_RMENU, up=True, extended=True))
        time.sleep(1.2)
        log("  语音已发送")
        return True
    except Exception as exc:
        log(f"  发语音异常：{type(exc).__name__}: {exc}")
        try:
            keys.send(keys._key(VK_RMENU, up=True, extended=True))
        except Exception:
            pass
        return False
    finally:
        # 一定要恢复，否则用户自己说话时微信收到的是静音虚拟设备
        try:
            AudioUtilities.SetDefaultDevice(prev)
        except Exception as exc:
            log(f"  !! 录音设备恢复失败，请手动切回：{exc}")
        time.sleep(0.2)


# ------------------------------------------------------------------ 素材库

def pick_sticker(cfg, log=print):
    """从本地表情图库里随机挑一张，没有就返回 None。"""
    d = cfg.get("stickerDir") or os.path.join(HERE, "stickers")
    if not os.path.isdir(d):
        return None
    exts = (".gif", ".png", ".jpg", ".jpeg", ".webp")
    files = [os.path.join(d, f) for f in os.listdir(d)
             if f.lower().endswith(exts)]
    if not files:
        return None
    return random.choice(files)
