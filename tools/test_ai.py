"""命令行联调脚本：不弹窗，直接验证 config.json 里的模型能否正常对话。

用法：
    .venv\\Scripts\\python.exe tools\\test_ai.py "你在干嘛"
"""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))

from PySide6.QtCore import QCoreApplication  # noqa: E402

from ai import ChatWorker  # noqa: E402

try:  # 让 Windows 控制台正确显示中文
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


def main() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else "你在干嘛呀"
    cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))

    app = QCoreApplication(sys.argv[:1])
    messages = [
        {"role": "system", "content": cfg.get("persona", "")},
        {"role": "user", "content": prompt},
    ]

    t0 = time.time()
    pieces: list[str] = []
    worker = ChatWorker(cfg, messages)

    def on_thinking() -> None:
        print(f"[{time.time() - t0:5.2f}s] 模型开始思考…")

    def on_delta(piece: str) -> None:
        pieces.append(piece)

    def on_done(text: str) -> None:
        print(f"[{time.time() - t0:5.2f}s] 完成，共 {len(text)} 字")
        print(f"[{time.time() - t0:5.2f}s] 回复：{text}")
        app.quit()

    def on_fail(message: str) -> None:
        print(f"[{time.time() - t0:5.2f}s] 失败：{message}")
        app.quit()

    worker.thinking.connect(on_thinking)
    worker.delta.connect(on_delta)
    worker.finished_ok.connect(on_done)
    worker.failed.connect(on_fail)

    print(f"模型：{cfg['api']['model']}")
    print(f"地址：{cfg['api']['base_url']}")
    print(f"提问：{prompt}")
    worker.start()
    app.exec()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
