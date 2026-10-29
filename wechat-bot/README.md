# wechat-bot — 个人微信自动回复

桌宠拉起的一个独立 Python 进程。**读消息读的是微信本地加密数据库（只读）**，
发送走 UIA 自动化。不需要 hook、不注入 DLL、不改微信客户端。

> 为什么只能这样：个人微信没有开放 API，微信 4.0 又打断了所有 hook 方案
> （WeChatFerry 只支持 3.9.12，wxauto 已停更，wechaty 免费 puppet 全失效）。
> UI 自动化是 4.x 下唯一还能走、且检测风险最低的路。风险仍在，**用小号**。
> 只想对同事用的话，走同项目的 `wecom-bot/`（官方 API，零风险）。

## 运行

```bash
cd wechat-bot

./py312/python.exe bot_db.py status          # 看配置、账号、数据库、护栏状态
./py312/python.exe bot_db.py sessions        # 列最近会话和未读数
./py312/python.exe bot_db.py watch --live    # 值守（桌宠就是这么拉起的）
./py312/python.exe bot_db.py once --live     # 只跑一轮，适合调试
./py312/python.exe bot_db.py stop            # 写 STOP 文件，下一轮自己停
./py312/python.exe bot_db.py resume          # 清 STOP

./py312/python.exe bot_db.py tts 要说的话    # 单独试 TTS
./py312/python.exe bot_db.py asr 音频路径    # 单独试 ASR
```

`--live` 不加就是 dry-run：只打印要回什么，不真发。

`py312/` 是自带的 Python 3.12 运行时（含 PySide6、uiautomation、pycaw 等），
不入库。换机器要重建，见 `requirements.txt`。

## 前置条件

1. **微信 4.x 已登录**，且**有主窗口**（托盘态读得到数据库，但发消息需要窗口）
2. `bot-db-config.json` 里的 `dbDir` / `account` 指向正确：
   - `dbDir` 一般是 `...\Documents\Tencent Files\wechat_logs\xwechat_files`
   - `account` 是 `wxid_xxx_abcd` 这一层目录名
   - 对不上就在 `bot_db.py status` 里看，它会打印实际用的路径
3. 发语音条需要 **VB-Audio Virtual Cable**（本机已装）

## 命令背后在做什么

```
watch 循环：
  ├─ 读数据库：哪些会话有未读、未读里哪些是别人发的
  ├─ 语境门禁（群聊）：@我 / 点我名 / 接着我的话 → 才进入下一步
  ├─ 概率闸：确定性判定后摇一次骰子（默认全 1.0 不过滤）
  ├─ 生成：历史 + 攒下没接的话一并给模型，模型可输 [SKIP] 否决
  ├─ 护栏：频率 / 去重 / 黑名单 / STOP
  ├─ 等待 2–8 秒（模拟打字，也把对方连发几条的空档等过去）
  └─ 发送：长回复切 2–3 条，段间停顿；可能附带表情 / 图片 / 语音条
```

## 配置（`bot-db-config.json`，含账号信息，已 gitignore）

| 键 | 说明 |
|---|---|
| `dbDir` / `account` | 微信数据库位置 |
| `replyToAll` | `true` = 所有私聊都回；`false` = 只回 `whitelist` |
| `whitelist` / `blacklist` | 昵称或 wxid。`replyToAll=false` 且白名单空 = 谁都不回 |
| `groupMode` | `smart`（默认，只在冲我来时开口）/ `all`（每条都回，**会被踢**）/ `skip` |
| `persona` | 这套机器人自己的人设，和桌宠本体、QQ 的性格互相独立 |
| `historyLimit` / `groupMemoryLimit` | 带多少条上下文 |
| `replyDelaySeconds` | `[2, 8]`，回复前随机等待区间 |
| `segmentReply` / `segmentMinChars` / `segmentMaxParts` / `typingCps` | 长回复分条发 + 打字节奏 |
| `groupAddressProbability` | `{at, named, following}`，判定该说话后再摇骰子。1.0=不过滤 |
| `contextBufferLimit` | 没接话的群消息攒多少条（下次开口时并进 prompt） |
| `emojiReply` / `emojiProbability` / `emojiOnEmoji` | 发内置表情（真表情消息）的开关与概率 |
| `stickerReply` / `stickerDir` | 发本地表情包，素材放 `stickers/` |
| `voiceReply` / `voiceAlways` / `voiceSendMode` | 语音：`voice`=真语音条 / `file`=当文件发 / `off` |
| `proactive` | 主动找人说话：时间窗、每日上限、间隔、同人冷却 |
| `maxPerHour` / `maxConsecutive` / `dedupeWindowSeconds` | 护栏 |
| `sendVerify` | 发送后回读校验。**建议关**，实测常误报 |

## 目录

```
bot_db.py         入口：轮询、门禁、生成、发送、护栏
llm.py            模型调用 + 输出清洗（剥 Markdown）
guard.py          频率限制 / 去重 / STOP 文件 / 事件日志
media_send.py     发图片 / 表情 / 语音条（像素定位 + 虚拟声卡）
proactive.py      主动发消息（挑人 + 生成 + 配额）
ocr.py / vision.py / vlm.py   截图与文字识别（发消息时兜底定位用）
send.py / keys.py / layout.py / voice_bar.py / shot.py   底层输入与坐标
stickers/         表情包素材（放 gif/png，空着就退回内置表情）
lab/              历史方案与一次性探测脚本，不在主链路上，见 lab/README.md
_probe/           调试截图，已 gitignore
```

## 踩过的坑（改之前先看）

- **发送「未确认」多半是误报**：回车已经按下、消息在群里了，只是输入框清空的判定超时。
  当失败处理会导致下一轮把同一句再发一遍。代码里按已发送处理，只记日志。
- **发完要让出前台**：点开会话后不最小化微信，后续消息不产生角标，就永远检测不到新消息。
- **表情面板是 Qt 自绘的**，UIA 树里一个控件都没有，只能按像素定位。
  工具条上那个表情按钮还会被任务栏挡住，所以用 `Alt+E` 而不是点击。
- **窗口坐标是 DPI 相关的**，改布局前先 `SetProcessDpiAwareness(2)`。
- **测试里绝不能漏打桩**：`live=True` 会走真实 GUI。曾经往真实会话发出去过一条。

## 测试

```bash
./py312/python.exe test_db_flow.py    # 决策链：门禁/分段/缓冲/概率闸/媒体标记
./py312/python.exe test_guard.py      # 护栏
```

两套都不需要开微信，所有会真操作微信的调用都打了桩。
