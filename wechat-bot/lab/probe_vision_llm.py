"""
测视觉模型能不能读微信截图。

动机：Windows OCR 对微信的小字号极不可靠（标题区干脆读不出），而踩坑记录里
20 条坑超过一半都是 OCR 幻觉/丢字导致的静默错误。让模型直接看截图能把
「读标题」「读消息」两件事一次解决。

默认只截聊天标题那一小块送出去，最小化外传内容。用 --full 送整窗。
用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/probe_vision_llm.py [模型名]
"""

import base64
import io
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # 主链路模块在上一级

import llm
import vision

CANDIDATES = [
    "Qwen/Qwen2.5-VL-7B-Instruct",
    "Qwen/Qwen2.5-VL-32B-Instruct",
    "Qwen/Qwen3-VL-30B-A3B-Instruct",
    "deepseek-ai/deepseek-vl2",
    "THUDM/GLM-4.1V-9B-Thinking",
]

PROMPT = ("这是微信电脑版的截图。请回答：\n"
          "1) 当前打开的是哪个会话（聊天标题原文）？\n"
          "2) 最后一条对方发来的消息原文是什么？\n"
          "只输出这两行，格式：标题=... / 最后消息=...")


def ask(cfg, model, img, prompt=PROMPT, timeout=60):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url",
             "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ]}],
        "max_tokens": 300,
    }).encode("utf-8")
    req = urllib.request.Request(
        cfg["baseUrl"] + "/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + cfg["apiKey"]})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {exc.read()[:300].decode('utf-8', 'replace')}"
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
    try:
        return data["choices"][0]["message"]["content"].strip(), ""
    except Exception:
        return None, str(data)[:300]


def main():
    cfg = llm.load_llm_config()
    if not cfg.get("apiKey"):
        print("没有 API Key")
        return 1
    print(f"baseUrl={cfg['baseUrl']}")

    s = vision.capture()
    if s is None:
        print("抓不到微信窗口")
        return 1
    print(f"窗口 {s.rect[2]}x{s.rect[3]} 缩放 {s.scale}%")

    full = "--full" in sys.argv
    if full:
        img = s.img
        note = "整窗"
    else:
        x1, y1, x2, y2 = s.regions["title"]
        # 标题区往外扩一圈，把头像也带进来（模型能靠头像认人）
        img = s.img.crop((max(0, x1 - 60), max(0, y1 - 10),
                          min(s.rect[2], x2), min(s.rect[3], y2 + 10)))
        note = f"标题带 {img.size}"
    print(f"送出去的图：{note}")

    models = [sys.argv[1]] if (len(sys.argv) > 1
                              and not sys.argv[1].startswith("--")) else CANDIDATES
    for m in models:
        out, err = ask(cfg, m, img)
        if out:
            print(f"\n[{m}] 可用\n{out}")
        else:
            print(f"\n[{m}] 失败：{err[:200]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
