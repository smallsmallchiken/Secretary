"""
生成层：调模型写回复。不碰企业微信。

复用桌宠已配置的模型（`.data/config.json` 的 llm 段），key 也可以用环境变量
PET_LLM_API_KEY 覆盖。apiKey 全程不出现在日志里。

注意这里的角色定位和企业微信自建应用一致：它是**公司的助手**，不是冒充某个
人。要改成别的语气，改 config.json 的 systemPrompt。
"""

import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PET_CONFIG = os.path.abspath(os.path.join(HERE, "..", ".data", "config.json"))

DEFAULT_BASE = "https://api.siliconflow.cn/v1"
DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash"

DEFAULT_SYSTEM = """你是公司的企业微信助手，同事会在企业微信里给你发消息。
要求：
- 简洁、直接、口语化，通常一到两句话
- 不知道的事不要编，说「这个我确认一下再回你」
- 不承诺任何具体的时间、金额、人事安排
- 只输出要发的那句话本身，不要任何解释、引号或前缀"""


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


def generate(incoming, system=None, cfg=None, max_tokens=200, timeout=40):
    """生成一句回复。失败返回 (None, 原因)。"""
    cfg = cfg or load_llm_config()
    if not cfg.get("apiKey"):
        return None, "没有 API Key"
    body = json.dumps({
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": system or DEFAULT_SYSTEM},
            {"role": "user", "content": incoming},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }).encode("utf-8")
    req = urllib.request.Request(
        cfg["baseUrl"] + "/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + cfg["apiKey"]})
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
    t = text.strip()
    for q in ('"', "'", "「", "」", "“", "”"):
        if t.startswith(q):
            t = t[1:]
        if t.endswith(q):
            t = t[:-1]
    for pre in ("回复：", "回复:", "可以这样回："):
        if t.startswith(pre):
            t = t[len(pre):]
    return t.strip()
