# lab/ — 企业微信客户端的探测脚本

两个脚本都是为了回答一个问题：**企业微信能不能像微信那样靠 UI 自动化收发消息。**
结论是不能，所以这个项目最终走的是官方 API 回调（`server.py`）。

| 文件 | 探到了什么 |
|---|---|
| `probe.py` | 企业微信窗口的 UIA 控件树。微信 4.x 和企业微信都是 Qt 自绘，整个界面是一块 `MMUIRenderSubWindow`，控件树只有两个节点——**UIA 彻底不可用**，只能走视觉 |
| `probe_cef.py` | 窗口层级里的 CEF 渲染窗口（`Chrome_RenderWidgetHostHWND`）。Chromium 只在检测到辅助技术时才构建无障碍树，所以这里显式发 `WM_GETOBJECT(OBJID_CLIENT)` 去唤醒它 |

两个都需要企业微信客户端正在运行才有意义。

```bash
cd wecom-bot
PYTHONPATH=. ../wechat-bot/py312/python.exe lab/probe.py
```

顺便留个结论：**企微没有对外的"个人号"概念**，能自动收发的只有企业自建应用
（就是本目录正经实现的那套）。想给通讯录外的人发消息，只能走群机器人 webhook，
而 webhook 是单向的（只能发不能收）。
