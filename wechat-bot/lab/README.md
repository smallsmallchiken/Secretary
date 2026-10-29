# lab/ — 历史方案与一次性探测脚本

这里的代码**不在主链路上**，留着是为了「当初为什么这么选」有据可查。改动主流程不需要看它们。

## 为什么挪出来

微信 4.x 的消息读取后来改成了**直接读本地加密数据库**（`bot_db.py` 里的 `WeChatDB`），
比截图 + OCR 稳得多。于是早期那套「靠认图找未读角标」的脚本就全部退居二线。

根目录现在只放主链路：`bot_db`（入口）、`llm`、`guard`、`media_send`、`proactive`
及其依赖的 `ocr` / `send` / `keys` / `layout` / `vision` / `vlm` / `voice_bar` / `shot`。

## 文件清单

| 文件 | 曾经的作用 |
|---|---|
| `bot.py` | 纯 UI 自动化版机器人（未读数走 OCR 判定）。已被 `bot_db.py` 取代，保留作对照 |
| `probe.py` / `probe2.py` | 探测微信 4.x 暴露了多少 UIA 控件树 —— 这一步决定了技术路线 |
| `probe_badge.py` | 逐像素拆解红色未读角标，标定颜色阈值 |
| `probe_unread.py` / `probe_layout.py` | 未读角标与会话列表布局的标定（验证「不误报」） |
| `probe_region.py` | 通用区域探针：给个矩形，出像素色块图 + OCR 文字 |
| `probe_click.py` | 复现「点开会话后读不出内容」的问题 |
| `probe_vision_llm.py` | 测视觉模型能否读微信截图（结论：能，但慢且贵） |
| `ascii.py` / `look.py` | 把截图转字符画 / 快速目视，调 OCR 参数时的眼睛 |
| `selftest_pipeline.py` / `selftest_vlm.py` / `test_vlm.py` | 上述路线的自测 |

## 怎么跑

脚本里的 `sys.path` 已经指向上一级（`wechat-bot/`），所以直接跑就行：

```bash
cd wechat-bot
./py312/python.exe lab/probe.py
```

产物（`tree.txt`、`ascii-src.png` 等）会写在 `lab/` 目录下，不会弄脏根目录。

## 已经失效的部分

`probe*.py` 的注释里写的 Python 路径是 `.workbuddy/wechat-bot/.venv/Scripts/python.exe`，
那是项目搬到 `wechat-bot/py312` 之前的位置。现在统一用 `wechat-bot/py312/python.exe`。
