# wecom-bot — 企业微信自建应用机器人

和 `wechat-bot/` 是**两条完全不同的路线**，别混：

| | `wechat-bot/`（个人微信） | `wecom-bot/`（本目录） |
|---|---|---|
| 通道 | UI 自动化（读库 + 模拟键鼠） | **官方 API**（接收回调 + 主动发消息） |
| 封号风险 | 中（违反微信用户协议） | **无**（企业微信鼓励这么用） |
| 能用的人 | 好友列表里的任何人 | 只有**同一企业通讯录**里的成员 |
| 消息类型 | 文字 / 图片 / 表情 / 语音条 | 文字（图片等待扩展） |
| 是否需要开机挂机 | 是（还要微信客户端在前台） | 是（但只挂一个无界面的 Python） |

结论：**给同事/团队用走这套；给微信好友用只能走 `wechat-bot/`。**

## 架构

```
企业微信服务器
   │  POST /callback  (XML, AES 加密, 5 秒内必须应答)
   ▼
公网 HTTPS ──(serveo SSH 隧道, 443)──► 本机 HTTPServer :8765
                                        │
                                        ├─ crypto.py  验签 + AES-256-CBC 解密
                                        ├─ message.py 解析 XML / 转义
                                        ├─ server.py  去重 → 立刻回空串
                                        │             └─ 后台线程：LLM 生成
                                        └─ api.py     拿 access_token → 发文本
```

关键点都在 `server.py` 头部注释里，这里只强调三条：

1. **必须 5 秒内应答**，所以先回空串再在后台线程里生成回复。同步跑模型会导致
   企业微信超时重试，同一条消息被回好几遍。
2. **官方会重试 3 次**，所以按 `MsgId` 做去重（`State.seen_before`）。
3. **URL 验证的 echostr 必须原样返回明文**，不能带引号、BOM、换行。

## 用法

```bash
cp config.example.json config.json     # 填 corpid / agentid / corpsecret / token / encodingAESKey
python start.py                        # 回调服务 + 公网隧道，会打印要填进后台的回调地址
```

`config.json` 含密钥，**已 gitignore**，不要提交。

企业微信后台要配的地方：应用管理 → 自建应用 → 接收消息 → 设置 API 接收 →
把 `start.py` 打印的 `https://xxx.serveo.net/callback` 和 `token` / `encodingAESKey` 填进去。

首次跑 `dryRun: true`（默认）只记日志不真发，日志在 `wecom.log`。确认回复内容对了再改 `false`。

## 公网隧道为什么用 serveo

`cloudflared` 在本机**用不了**：它走 7844（UDP QUIC + TCP HTTP2），实测都被封，
precheck 直接 hard_fail。本机还挂着 fake-ip 代理（198.18.x.x）只放行 443。

所以 `tunnel.py` 默认用 **serveo.net 的 SSH 隧道走 443**——和 git 推送被逼走
443 是同一个原因。`run_cloudflared()` 保留着，换到能通 7844 的网络可以直接切。

serveo 是免费公共服务，**地址每次启动都变**，所以每次都得到企业微信后台改回调地址。
要固定域名得自己买（ngrok 付费版 / Cloudflare Tunnel + 自有域名）。

## 测试

```bash
../wechat-bot/py312/python.exe test_crypto.py       # 加解密 + 验签，离线
../wechat-bot/py312/python.exe test_message.py      # XML 解析 + 转义 + HTTP 端到端，离线（起本地服务）
../wechat-bot/py312/python.exe test_tunnel_live.py  # 真连 serveo，需要网络
```

前两个不联网、不碰企业微信，随便跑。`test_tunnel_live.py` 会真的建隧道。

## 目前没做的

- **只处理文本消息**，图片/文件/语音收到就跳过（`server.py` 里显式判断）
- 不支持群聊（企业微信的群机器人是另一套 webhook，不走上行回调）
- 没有上下文记忆，每条消息独立问一次模型
- 隧道地址变化需要手工更新后台配置
