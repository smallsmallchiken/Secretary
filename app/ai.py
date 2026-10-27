"""SiliconFlow / OpenAI 兼容接口的流式对话客户端。

DeepSeek-V4.1-Flash 会先返回 reasoning_content（思考过程），
这里把它单独走 thinking 信号，气泡正文只取 content。
"""

import json

import requests
from PySide6.QtCore import QThread, Signal


class ChatWorker(QThread):
    thinking = Signal()          # 收到第一段思考内容
    delta = Signal(str)          # 正文增量
    finished_ok = Signal(str)    # 完整正文
    failed = Signal(str)         # 错误信息

    def __init__(self, cfg: dict, messages: list[dict], parent=None):
        super().__init__(parent)
        api = cfg.get("api", {})
        self.base_url = str(api.get("base_url", "https://api.siliconflow.cn/v1")).rstrip("/")
        self.api_key = str(api.get("api_key", ""))
        self.model = str(api.get("model", "deepseek-ai/DeepSeek-V4.1-Flash"))
        self.temperature = float(api.get("temperature", 0.8))
        self.max_tokens = int(api.get("max_tokens", 512))
        self.timeout = float(api.get("timeout_s", 120))
        self.messages = messages
        self._stop = False

    def stop(self):
        self._stop = True

    def run(self):
        if not self.api_key:
            self.failed.emit("没有配置 api_key，请检查 config.json")
            return

        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        payload = {
            "model": self.model,
            "messages": self.messages,
            "stream": True,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }

        chunks: list[str] = []
        got_thinking = False
        try:
            with requests.post(
                url,
                headers=headers,
                json=payload,
                stream=True,
                timeout=(10, self.timeout),
            ) as resp:
                if resp.status_code != 200:
                    body = resp.text[:400].replace("\n", " ")
                    self.failed.emit(f"HTTP {resp.status_code} — {body}")
                    return

                for raw in resp.iter_lines(decode_unicode=True):
                    if self._stop:
                        break
                    if not raw:
                        continue
                    line = raw.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    if delta.get("reasoning_content") and not got_thinking:
                        got_thinking = True
                        self.thinking.emit()
                    piece = delta.get("content") or ""
                    if piece:
                        chunks.append(piece)
                        self.delta.emit(piece)
        except requests.exceptions.Timeout:
            self.failed.emit("请求超时了，网络好像有点慢")
        except requests.exceptions.RequestException as exc:
            self.failed.emit(f"网络错误：{exc.__class__.__name__}")
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(f"{exc.__class__.__name__}: {exc}")
        else:
            self.finished_ok.emit("".join(chunks).strip())
