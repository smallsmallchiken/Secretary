# QQ 自动回复（桌宠 × NapCat）

桌宠通过 NapCat 协议端挂一个小号，自动替你回复**白名单内好友的私聊消息**。

```
QQ 服务器 ⇄ NapCat（本目录，独立 QQ 内核，和你日常 QQ 隔离） ⇄ OneBot 11 WebSocket ⇄ 桌宠
                                                        ↓
                                    白名单 → 护栏(限流/去重) → LLM(DeepSeek) → 自动回复
```

## 首次使用（三步）

1. **启动 NapCat**：双击 `napcat/napcat/NapCat.52230.Shell/napcat.bat`（或 `napcat.quick.bat` 快速登录）。
   控制台会出二维码，用**小号**手机 QQ 扫码登录。日志里还会给一个 `http://127.0.0.1:6099/...` 的 WebUI 链接（带 token）。
2. **配置 OneBot WebSocket 服务端**：浏览器打开 WebUI → 「网络配置」→ 新建 →
   - 类型：**WebSocket 服务器**
   - Host：`127.0.0.1`，Port：`3001`
   - 消息格式：**Array**
   - Token：随便设一个 32 位随机串（下面第 3 步要用）
   - 保存并启用。
3. **配置桌宠**：编辑项目根的 `.data/config.json`，填 `qq` 段：

```jsonc
"qq": {
  "enabled": true,
  "wsUrl": "ws://127.0.0.1:3001",
  "token": "上面设置的token",
  "whitelist": [
    { "qq": 123456789, "name": "老王" }
  ],
  "perChatIntervalSeconds": 20,
  "maxConsecutive": 3,
  "maxPerHour": 20,
  "dedupeWindowSeconds": 60
}
```

然后重启桌宠（或在右键菜单里开关一次「QQ 自动回复」）。

## 日常使用

- NapCat 的控制台窗口保持开着（或把 `napcat.bat` 加开机自启）。
- 桌宠右键菜单 →「QQ 自动回复」可随时开/关，菜单上会显示值守状态。
- 白名单内好友发来私聊 → 桌宠气泡提示「收到 xx 的消息」→ LLM 生成回复 → 自动发出 → 气泡提示「已替你回复 xx」。

## 护栏（防止回错人/刷屏）

- 白名单为空 = 谁都不回（默认安全）。
- 只回**好友私聊**；群聊、临时会话、纯图片/语音一律忽略。
- 同一个人两次回复至少隔 20 秒；连续回 3 条后停 5 分钟；每小时最多 20 条；60 秒内不重样。
- 同一条消息（message_id 相同）绝不重复回复。
- 桌宠日志在 `.data/debug.log`（搜 `[qq]`）。

## 风险提醒

NapCat 是非官方协议端，违反 QQ 用户协议，**有封号风险**。务必用小号，别挂主号。

## 目录说明

- `napcat/NapCat.52230.Shell/` — NapCat + 独立 QQ 9.9.33 内核（已 gitignore，1GB+）
- `../src/core/qq/client.js` — OneBot 11 WebSocket 客户端（连接/重连/API 调用）
- `../src/core/qq/bot.js` — 业务层（白名单/护栏/LLM/发送/状态落盘）
- `../tools/test-qq.js` — 链路自测（桩 NapCat，无网络依赖）：`node tools/test-qq.js`
