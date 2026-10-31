# server/ — Linux 服务器上的值守

本地桌宠那套（Electron + Windows）只负责卖萌之后，QQ / 微信的实际值守搬到这里跑。
目前**只有 QQ 已经上服务器**，微信还在改（见文末）。

## 现在长什么样

```
                  ┌────────────────────────── 服务器 8.139.252.197 ──────────────────────────┐
   QQ 用户 ──http──▶ napcat 容器（官方 QQ 内核 + Xvfb :1）                                  │
                  │      └ 3001/tcp OneBot 11 WS（token 鉴权）                             │
                  │                    ▲                                                    │
                  │                    │ ws://127.0.0.1:3001                               │
                  │      qqbot 容器（node:20-slim，跑 server/qq-bot.js）                    │
                  │        └ 读写 /opt/secretary/.data（config / 媒体库 / 语音缓存）         │
                  └────────────────────────────────────────────────────────────────────────┘
```

- **qqbot 容器**用 `--network host`：NapCat 的 WS 只监听宿主机回环，走桥接网络连不上，
  而且 3001 也不该暴露到公网（实测从外网连 3001/6099 都是超时，只有 22/80 开着）。
- 桌宠（本地 Windows）如果也想看一眼消息，走 nginx 反代而不是开端口：
  `/etc/nginx/default.d/qqws.conf` 里 `location /qqws` → `proxy_pass http://127.0.0.1:3001`
  （带 Upgrade/Connection 头），对外就是 `ws://8.139.252.197/qqws`。
  **但别让桌宠和 qqbot 同时连**：两边都会回复，同一个好友会收到两条。
- **NapCat 容器必须挂 `/opt/secretary:ro`**。发图片/发语音用的是
  `file:///opt/secretary/.data/media/...` 这种绝对路径，NapCat 是在**它自己的容器**里
  解析这个路径的，不挂就是"文件不存在"。
  重建 NapCat 时别忘了这一条（参考下面的命令）。

## 部署 / 更新

```bash
# 在服务器上（root）
bash /opt/secretary/server/deploy.sh              # 拉最新代码 + 装依赖 + 重启 qqbot
bash /opt/secretary/server/deploy.sh --no-restart # 只更新代码
```

脚本干的事：`git reset --hard origin/main` → 容器内 `npm install --omit=dev`
→ 重建 `qqbot` 容器。**密钥不在仓库里**，`.data/config.json` 要单独放（600 权限），
脚本只检查它在不在。

宿主机没装 node（CentOS 7 的 glibc 2.17 跑不了 node 18+，而代码用了全局 `fetch`），
所以一律走 `node:20-slim` 容器。

## 配置

`/opt/secretary/.data/config.json` 的 `qq` 段：

| 字段 | 服务器上应该是什么 | 说明 |
|---|---|---|
| `enabled` | `true` | 关着的话入口直接退出 |
| `wsUrl` | `ws://127.0.0.1:3001` | 同机 NapCat，别写成公网地址 |
| `token` | 和 NapCat `onebot11_*.json` 里的 token 一致 | 不一致握手会被拒 |
| `napcatAutostart` | `false` | 服务器上 NapCat 是容器，不该由 bot 去拉 |
| `allFriends` / `whitelist` | 按需 | 只回私聊好友；群聊按 `groupMode` |

## 主动发消息

不只是被动回复：它会自己找由头开口。调度器在 `src/core/qq/proactive.js`（纯决策）+ `bot.js`
的 `proactiveTick()`（生成和发送），每 60 秒走一轮，只对**私聊**（白名单 / allFriends 里打过交道的人）生效。

五路触发，按固定优先级判定，先命中先算：

| 触发 | 什么时候 | 默认参数 |
|---|---|---|
| `followUp` 话题追问 | 我上一条是问句、对方没回 | 40–90 分钟后、最多追到 6 小时 |
| `revisit` 旧事回访 | 翻聊天归档看到前些天聊过的事，隔几小时接一句 | 距上次说话 ≥3 小时、两次回访隔 18 小时 |
| `timed` 定时问候 | 到点随口打个招呼 | `09:40`、`14:20`、`21:30`，前后抖 20 分钟，每槽一天一次 |
| `silence` 空闲唤醒 | 安静太久了找个话头 | 距上次说话 7–15 小时（按会话抖动） |
| `random` 随机关怀 | 突然想起他 | 每天 2 条、每 50 分钟掷一次骰子、命中率 0.5 |

**开口必须有具体的事**，这是这块最容易做砸的地方。`revisit` 和别的几路不同：它的由头不在
决策层，而是 `bot.js` 的 `historyDigest()` 从 `.data/archive/` 里捞出该会话最近 5 天的对话
（压掉纯表情和超短感叹，最多 24 行）喂给模型，模型从里面挑一件接下去。所以：

- 归档里少于 4 条时 `revisit` 不触发（刚认识的人硬提旧事很尴尬），只剩定时/空闲/随机三路
- **归档是空的，主动消息就退化成「到点打个招呼」**，质量会明显掉——归档是这块的地基

闸门（任何一个不满足就不发）：

- `quietHours` 免打扰，默认北京时间 **1:00–8:00** 一条不发
- `dailyMax` 每人每天最多 4 条；`cooldownMinutes` 两次之间至少隔 75 分钟
- `maxUnanswered` 连着 2 条主动都没回就**彻底闭嘴**，等他先开口（对方一发消息立刻清零）
- `minGapMinutes` 对方刚说完 20 分钟内不插嘴；`activeDays` 超过 14 天没互动的人不找
- 生成失败/发送失败记 `lastProactiveAttemptAt`，10 分钟内不重试，避免白烧模型钱

> 额度这块踩过坑：早期 `dailyMax=2` + `cooldownMinutes=240`，实测中午就把两条用完，
> 之后 9 小时一条不发，体感是「根本不会主动」。放宽到 4 条 / 75 分钟后才散得开。
> 但也别无限放宽——`maxUnanswered` 那个护栏一定要留着，它防的是「追命连环问」。

调参直接改 `/opt/secretary/.data/config.json` 的 `qq.proactive`，改完 `docker restart qqbot`
（配置在内存里缓存，不重启不生效）。**注意 `proactive` 整段是覆盖关系**：
写了 `dailyMax` 之外没写的键会走代码默认（`{...DEFAULTS, ...config}`），
但如果这里存着一份**旧的完整配置**，它会整个盖住代码里新调的默认值——
所以调过默认值之后，记得把服务器上这份旧配置清成 `null`。

```bash
# 验证：临时把一个 slot 设到两三分钟后，看日志里有没有「主动找 xxx 说了句」
docker logs --since 10m qqbot | grep 主动找
grep "主动消息 ->" /opt/secretary/.data/debug.log | tail
```

注意：`qq-state.json` 里每个会话会记 `lastIncomingAt / lastOutgoingAt / awaitingReply /
lastProactiveAt / lastRevisitAt / proactiveDay / slotFired`。老状态没有这些字段时，
会用 `lastSentAt` 倒推对话结束时间，不然上线后要好几天才满足「必须聊过才主动」。

**别在两个进程里同时开 QQ 值守**（本地桌宠 + 服务器容器）：回复会重复，主动消息也会双发。

## 常用命令

```bash
docker logs -f --tail 100 qqbot                  # 值守日志（收发播报都在这）
docker restart qqbot                             # 改完配置重启
docker exec -it qqbot node server/qq-bot.js --check   # 体检：配置 + WS 握手
docker exec qqbot node -e "…"                    # 临时调 API 验证（发图/发语音）
```

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| `docker logs qqbot` 里一直"与 NapCat 断开了，正在自动重连"，NapCat 侧 `socket hang up` | NapCat 进程起来了但 QQ 还没登录完。`docker restart napcat`，等 15–60 秒；3001 开始 accept 就说明好了 |
| 发图片/语音报 `retcode=1200` | 九成是 NapCat 容器没挂 `/opt/secretary`，路径在它那边不存在 |
| 3001 从外网连不上 | 正常。只监听宿主机回环，外网只有 22 |
| 容器重建后 QQ 掉线 | 数据在 `/opt/napcat`、`/opt/napcat-qq` 两个 bind mount 里，重建时把挂载原样带上就不会掉登录态 |

## 微信（待迁）

微信这套的核心库 `wechatauto-replica` 是 Windows 专用（UIA + 进程内存提 key，26k 行），
搬不过来；服务器上跑的是**官方 Linux 版微信**（容器 `im-linux:wx2`，Xvfb :99 + x11vnc 5900，
带 `xdotool` / ImageMagick / xclip，没有 tesseract、没有 node）。

路线已定：**重写一层 Linux 后端**（截图 + VLM 读会话/未读 + xdotool 点击输入），
复用现有的 `llm` / `guard` / `media_lib` / 语音文件发送，不做数据库解密
（Linux 微信的库同样是 SQLCipher，主密钥只存在于进程内存里，`key_info.db` 里的是密文，
试过 282 个 32 字节窗口均不匹配）。
