# -*- coding: utf-8 -*-
"""塔菲音色重克隆：ASR 校验样本 -> 挑最好的克隆 -> 生成试听。

用法：
  python taffy_clone.py asr                 # 转写 taffy-samples/*.wav -> asr.json
  python taffy_clone.py clone <样本名>...    # 克隆指定样本（不含扩展名）
  python taffy_clone.py speak <voiceUri> <样本名> [文本]  # 用某音色合成试听
"""
import io
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SAMPLES = os.path.join(HERE, "taffy-samples")

BASE = "https://api.siliconflow.cn/v1"
TTS_MODEL = "FunAudioLLM/CosyVoice2-0.5B"
ASR_MODEL = "FunAudioLLM/SenseVoiceSmall"

TEST_TEXT = "大家好呀，我是塔菲，今天也要元气满满哦！关注塔菲不迷路~"


def key():
    cfg = json.load(open(os.path.join(ROOT, ".data", "config.json"), encoding="utf-8"))
    return cfg["llm"]["apiKey"]


def req(url, data, headers, timeout=120):
    r = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


def asr_one(path):
    boundary = "----taffy%d" % time.time()
    name = os.path.basename(path)
    body = io.BytesIO()
    def part(s):
        body.write(s.encode("utf-8") if isinstance(s, str) else s)
    part(f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{ASR_MODEL}\r\n")
    part(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: audio/wav\r\n\r\n")
    with open(path, "rb") as f:
        body.write(f.read())
    part(f"\r\n--{boundary}--\r\n")
    data = body.getvalue()
    r = urllib.request.Request(
        BASE + "/audio/transcriptions", data=data,
        headers={"Authorization": "Bearer " + key(),
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(r, timeout=180) as resp:
        return json.loads(resp.read()).get("text", "")


def do_asr():
    out = {}
    p = os.path.join(SAMPLES, "asr.json")
    if os.path.exists(p):
        out = json.load(open(p, encoding="utf-8"))
    for f in sorted(os.listdir(SAMPLES)):
        if not f.endswith(".wav") or f in out:
            continue
        try:
            text = asr_one(os.path.join(SAMPLES, f))
            out[f] = text
            print(f, "->", text[:60])
            json.dump(out, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        except Exception as e:
            print(f, "ASR 失败:", e)
    print("完成", len(out), "条")


def upload_clone(sample, custom_name):
    path = os.path.join(SAMPLES, sample + ".wav")
    text = json.load(open(os.path.join(SAMPLES, "asr.json"), encoding="utf-8"))[sample + ".wav"]
    boundary = "----taffy%d" % time.time()
    body = io.BytesIO()
    def part(s):
        body.write(s.encode("utf-8") if isinstance(s, str) else s)
    part(f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{TTS_MODEL}\r\n")
    part(f"--{boundary}\r\nContent-Disposition: form-data; name=\"customName\"\r\n\r\n{custom_name}\r\n")
    part(f"--{boundary}\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\n{text}\r\n")
    part(f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio_format\"\r\n\r\nwav\r\n")
    part(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{sample}.wav\"\r\nContent-Type: audio/wav\r\n\r\n")
    with open(path, "rb") as f:
        body.write(f.read())
    part(f"\r\n--{boundary}--\r\n")
    r = urllib.request.Request(
        BASE + "/uploads/audio/voice", data=body.getvalue(),
        headers={"Authorization": "Bearer " + key(),
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(r, timeout=180) as resp:
        d = json.loads(resp.read())
    uri = (d.get("uri") or "").replace("speech:taffy:", f"speech:taffy:{custom_name}:")
    # 直接取返回里的 uri 字段（保证带 customName 段）
    uri2 = d.get("uri")
    print("克隆结果:", json.dumps(d, ensure_ascii=False)[:200])
    return uri2 or uri


def speak(voice_uri, out_name, text=None):
    data = json.dumps({
        "model": TTS_MODEL,
        "input": text or TEST_TEXT,
        "voice": voice_uri,
        "response_format": "mp3",
    }).encode("utf-8")
    r = urllib.request.Request(
        BASE + "/audio/speech", data=data,
        headers={"Authorization": "Bearer " + key(), "Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=180) as resp:
        audio = resp.read()
    out = os.path.join(SAMPLES, out_name + ".mp3")
    open(out, "wb").write(audio)
    print("已生成", out, len(audio), "bytes")


def main():
    cmd = sys.argv[1]
    if cmd == "asr":
        do_asr()
    elif cmd == "clone":
        for s in sys.argv[2:]:
            uri = upload_clone(s, "taffy-" + s.lower().replace("~", "-").replace("_", "-"))
    elif cmd == "speak":
        speak(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)


if __name__ == "__main__":
    main()
