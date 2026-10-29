"""
生成层：调桌宠已配置的模型（SiliconFlow）。不碰微信。

复用桌宠的 .data/config.json，key 也可以用环境变量 PET_LLM_API_KEY 覆盖。
apiKey 全程不出现在日志里。
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PET_CONFIG = os.path.abspath(os.path.join(HERE, "..", ".data", "config.json"))

DEFAULT_BASE = "https://api.siliconflow.cn/v1"
DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash"

SYSTEM_PROMPT = """你在替本人回复微信消息。要求：
- 用本人第一人称，口语化，像真人随手打的，不要书面语
- 短，通常一到两句话，不要长篇大论
- 不要用「您好」「感谢您的来信」这类客服腔
- 不确定的事不要替本人承诺，说「我看一下」「回头跟你说」
- 只输出要发的那句话本身，不要任何解释、引号或前缀

对方消息是截图 OCR 出来的，可能有错别字。理解大意即可，不要纠结字面。"""


def load_llm_config():
    key = os.environ.get("PET_LLM_API_KEY", "")
    base, model = DEFAULT_BASE, DEFAULT_MODEL
    if os.path.exists(PET_CONFIG):
        try:
            with open(PET_CONFIG, encoding="utf-8") as f:
                llm = (json.load(f) or {}).get("llm", {})
            key = key or llm.get("apiKey", "")
            base = (llm.get("baseUrl") or base).rstrip("/")
            model = llm.get("model") or model
        except Exception as exc:
            print(f"读桌宠配置失败（忽略）：{exc}", file=sys.stderr)
    return {"apiKey": key, "baseUrl": base, "model": model}


def generate(incoming, history=None, cfg=None, system=None,
             max_tokens=200, timeout=40, temperature=0.8):
    """生成一句回复。失败返回 (None, 原因)。

    system 传 None 时用模块默认的「替本人回复」人设；微信数据库版会传入
    自己的温柔人设和群聊规则。

    temperature：默认 0.8；去 AI 味那套提示词用 1.0（温度低时模型会退回
    「工整、客气、面面俱到」的默认腔调，反而更像客服）。
    """
    cfg = cfg or load_llm_config()
    if not cfg.get("apiKey"):
        return None, "没有 API Key"
    user = ""
    if history:
        user += "最近的聊天记录：\n" + history + "\n\n"
    user += f"对方刚发来的消息：{incoming}\n\n请直接给出要回复的那句话。"
    body = json.dumps({
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": system or SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }).encode("utf-8")
    req = urllib.request.Request(
        cfg["baseUrl"] + "/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + cfg["apiKey"]},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {exc.read()[:200]!r}"
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
    try:
        text = data["choices"][0]["message"]["content"].strip()
    except Exception:
        return None, f"响应结构异常: {str(data)[:200]}"
    return clean(text), ""


def clean(text):
    """去掉模型爱加的引号、前缀，以及漏出来的 Markdown 符号。

    QQ 那边踩过同一个坑：气泡里 Markdown 不渲染，用户看到的就是一串星号。
    这里在发送前统一剥掉，别指望提示词百分百听话。
    """
    t = (text or "").strip()
    for q in ('"', "'", "「", "」", "“", "”"):
        if t.startswith(q):
            t = t[1:]
        if t.endswith(q):
            t = t[:-1]
    for pre in ("回复：", "回复:", "要回复的那句话：", "可以这样回：", "我："):
        if t.startswith(pre):
            t = t[len(pre):]
    if t.strip() == "[SKIP]":
        return "[SKIP]"  # 群聊沉默信号，别去动它
    # Markdown 残留
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)", r"\1", t)
    t = t.replace("`", "").replace("~~", "")
    # 列表符号（- * + 1. 1、），只剥行首
    t = re.sub(r"(?m)^\s*(?:[-*+]|\d+[.、)])\s+", "", t)
    t = re.sub(r"(?m)^\s*#+\s*", "", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    return t.strip()


if __name__ == "__main__":
    cfg = load_llm_config()
    print(f"模型 {cfg['model']} @ {cfg['baseUrl']}  key={'有' if cfg['apiKey'] else '无'}")
    msg = sys.argv[1] if len(sys.argv) > 1 else "在吗"
    out, err = generate(msg, cfg=cfg)
    print(f"对方: {msg}\n回复: {out!r}" if out else f"失败: {err}")
