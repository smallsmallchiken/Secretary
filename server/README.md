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
