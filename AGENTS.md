# AGENTS.md

给参与本项目的 AI 助手看的协作约定。人类说明见 `README.md`。

## 这是什么

Windows 桌面宠（Electron），带可被 LLM 调用的工具层。核心是"本地规则 + 模型编排"双路径，
两条路径共用 `src/core/tools/index.js` 里同一份工具定义——**加能力只改这一处**。

除了桌宠本体，还有三套**独立于 Electron** 的消息机器人，各自能单独跑：

| 目录 | 通道 | 语言 | 读它的说明 |
|---|---|---|---|
| `wechat-bot/` | 个人微信，UI 自动化 | Python | `wechat-bot/README.md` |
| `qq-bot/` + `src/core/qq/` | QQ，NapCat（OneBot 11） | 协议端 + JS | 本文件下文 |
| `wecom-bot/` | 企业微信，官方 API | Python | `wecom-bot/README.md` |

改桌宠逻辑通常不涉及这三个；改它们之前先读各自 README，里面写满了踩过的坑。

## 部署现状（2026-10-31 起）

**QQ 与微信值守全部在 Linux 服务器（`8.139.252.197`）上跑，本地桌宠不提供这两项服务。**

- 本地 `.data/config.json`：`qq.enabled=false`、`wechat.autostart=false`；`config.js` 里
  `wechat.autostart` 默认也改成了 `false`。
- `src/main/main.js` 里**没有任何** `qqbot.init / wxbot.* / napcat.init / wechatApp.init` 调用，
  右键菜单也没有「QQ 自动回复 / 微信自动回复」两项。本地不会连 OneBot WS、不拉 NapCat、
  不拉微信客户端、不跑微信看门狗。
- 相关代码（`src/core/qq/`、`src/core/wechat/`、`main/napcat.js`、`main/wechat-app.js`）全部保留：
  服务器端跑的就是同一份 `src/core/qq/`，回退到本地时按 git 历史把接线补回来即可。
- **同一时间只允许一边值守**：本地再起一套会和服务器抢同一个号、重复回复、主动消息双发。
- 服务器上是完整 QQ 机器人（NapCat + OneBot WS + 主动消息调度），细节见 `server/README.md`；
  服务器上 NapCat 的坑（配置匿名卷、安全组、扫码）见 `.workbuddy/memory/2026-10-30.md`。

## 聊天归档与记事（`remember` / `recall`）

用户要「帮我记事，后面我直接问就行」，所以有两条数据线，**存法不同、用途不同**：

| 数据 | 存在哪 | 谁写 | 查什么用 |
|---|---|---|---|
| QQ 聊天流水 | 服务器 `.data/archive/YYYY-MM-DD.jsonl` | `src/core/qq/bot.js` 收到消息时（**在白名单过滤之前**，所有人都记） | 「上周跟 G 聊了啥」 |
| 记事本 | 本地 `.data/notes.jsonl` | 用户说「记一下 xxx」→ `remember` 工具 | 「我让你记的那件事」 |

**先说清楚能读到什么**：服务器上**没有**完整历史。NapCat 只是个转发器，它自带的
`nt_msg.db` 是加密的、而且只存这号登录（10-30）之后的消息；微信容器里根本没有数据库
（只有 14 MB 配置缓存）。腾讯那边的漫游记录 NapCat 也翻不到——实测 `get_friend_msg_history`
给 count=10/50/100/500 都只回同样 34 条，拿最早那条的 seq 往前翻直接「消息不存在」。
所以归档是**从现在开始攒**，不是「下载历史」。

桌宠查归档的路径（`src/core/tools/memory.js`）：

```
recall → 先查本地 .data/archive（archive.query，37ms）
       → 查不到就 tools/sync-archive.py 同步一次再查
       → 还不中才 tools/remote-chatlog.py SSH 过去实时查（约 6 秒，只做兜底）
```

- 同步用 SFTP，增量（远端文件只会变大，本地不小于远端就跳过）。
- **远端路径必须 `posixpath.join`**：Windows 上 `os.path.join` 会拼出反斜杠，SFTP 找不到文件。
- 启动时预热一次（`main.js`），之后每次查询超过 10 分钟就**后台**刷一次（不 await，
  否则又把毫秒级查询拖成 5 秒）。
- 服务器配置在 `.data/config.json` 的 `server` 段（host/user/password，已 gitignore）。

改归档格式时两边都要动：`src/core/qq/archive.js` 是唯一的读写实现，
`tools/qq-archive.js`（服务器查）和 `tools/remote-chatlog.py`（渲染）都跟着它的字段走。


## 启动

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . \
  --no-sandbox --disable-gpu --disable-gpu-compositing --disable-software-rasterizer
```

三个必须知道的点：

1. 本机全局有 `ELECTRON_RUN_AS_NODE=1`，不清掉 Electron 会退化成纯 Node，报
   `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
   `ELECTRON_RUN_AS_NODE=` 置空**无效**，必须用 `env -u`。
2. 不加那排 `--disable-*` 参数，GPU 进程会以 `0xC0000005` 崩溃。
3. 主进程的 `console.log` 在 Windows 上不连控制台。调试信息一律 `dbg()` 写
   `.data/debug.log`（`src/core/debug.js`）。

## 绝对不要做

- **不要提交任何含密钥的配置**。仓库是 **public**，泄露即失效。完整清单：

  | 文件 | 含什么 |
  |---|---|
  | `config.json` | 旧 Python 版的 API Key |
  | `.data/config.json` | 桌宠的 API Key、微信/QQ 的 token |
  | `wechat-bot/bot-db-config.json` | 微信账号 wxid、数据库绝对路径 |
  | `wecom-bot/config.json` | 企业微信 CorpID / Secret / AESKey |

  全部已在 `.gitignore` 里。提交前跑一次：
  ```bash
  git diff --cached | grep -E "sk-[a-zA-Z0-9]{20,}|corpsecret|wxid_"
  ```
  有输出就立刻 `git reset` 并检查 `.gitignore`。
- 不要为了"修好"而删掉 `pets/duodong/spritesheet.webp` 或改动它的尺寸假设
  （8 列 × 9 行，单帧 192×208，各行帧数 6/8/8/4/5/8/6/6/6）。
  **第 2 行是第 1 行的水平镜像**（左向行走），不是重复行。
- 不要动 `~/.ssh` 里的密钥，也不要改 git 全局配置。

## 并发协作：两个 agent 共用一个工作目录

这是当前最容易出事的地方。**git 检测不到"工作区被另一个进程覆盖"**，
你的改动可能在对方一次保存后无声消失，反之亦然。

按这个顺序操作，能把风险降到最低：

1. **动手前先看**：`git status --short` 和 `git log --oneline -3`。
   工作区有你不认识的未提交改动 → 说明另一个 agent 正在改，**先别动那批文件**。
2. **改前先同步**：`git pull --rebase`
3. **小步提交**：改完一个完整的小功能就 `commit`，别挂着半小时未提交的状态。
4. **提交前再查一次**：`git status --short` 确认要提交的文件确实是你改的。
5. **报 `Unable to create index.lock`** = 另一个 agent 正在提交，等 2 秒重试，别硬删锁文件。

### 文件归属建议

同一时间尽量只让一个 agent 改同一批文件。天然的分界线：

| 区域 | 说明 |
|---|---|
| `src/core/` | 意图路由、LLM、工具层、QQ/微信托管。改这里要同时跑 `node tools/test-agent.js` |
| `src/main/` | 窗口、托盘、快捷键、漫游、进程拉起。改这里要跑 `node tools/test-wander.js` |
| `src/renderer/` | 动画与 UI，纯前端 |
| `wechat-bot/*.py` | 微信决策链与发送。改这里跑 `test_db_flow.py` + `test_guard.py` |
| `wechat-bot/media_send.py` | 图片/表情/语音条。**改这个必须真机验证**（有像素定位和虚拟声卡） |
| `wechat-bot/lab/` | 历史方案与探测脚本，**不在主链路上**，除非专门考古否则不要改 |
| `wecom-bot/` | 企业微信官方 API 路线，和微信那套完全独立 |
| `app/` | **旧的 Python 版，已停用**。除非要复活它，否则不要改 |

### 进程常驻与重启

- 微信值守是独立 Python 进程，桌宠只负责拉起和查状态（`src/core/wechat/bot.js`）。
  **改完 py 不需要重启桌宠**，杀掉 python 进程，看门狗 20 秒内会用新代码重拉。
- QQ 走 NapCat，改 `src/core/qq/` 后同样不用动 NapCat。
- 重启 Electron 前必须确认旧进程死透：单实例锁没释放时新进程会**静默退出**，
  看起来像"启动失败"，实际是锁。强杀后等 10–30 秒再拉。
- **经 Bash 启动的进程会随命令退出被清理**（`detached: true` 也逃不掉）。
  要长期存活只能：走 WMI `Win32_Process.Create`、用 `hidden-launch.js` 的
  PowerShell `ShellExecute + Hidden`、或让 Electron 本体去拉。

## 改完必须验证

```bash
npm test          # 桌宠主进程 + 窗口 + QQ + 微信开关，七套，全离线
npm run test:py   # 微信决策链 + 护栏 + 企业微信加解密，四套，全离线
```

拆开看：

```bash
node tools/test-agent.js --check    # 离线断言：规则路由 / 时间解析 / LLM 路径回归
node tools/test-wander.js           # 漫游位移与掉头
node tools/test-pet-anim.js         # 逐帧动画循环（一次性动画播完不能断）
node tools/test-pet-ui.js           # 桌宠尺寸恒定 + 拖动一定能收尾
node tools/test-windows.js          # 显隐逻辑 + 自绘菜单窗口能否创建
node tools/test-qq.js               # 桩 NapCat：白名单 / 去重 / 间隔护栏
node tools/test-wx.js               # 微信开关（pid 文件 / 进程探测），默认只读

node tools/test-agent.js "现在几点了"   # 需要时再跑：真实链路（会联网）
node tools/test-wx.js --live            # 真启停微信值守（会中断正在跑的机器人）

wechat-bot/py312/python.exe wechat-bot/test_db_flow.py   # 群聊门禁/分段/缓冲/概率闸
wechat-bot/py312/python.exe wechat-bot/test_guard.py     # 频率/去重/白名单
wechat-bot/py312/python.exe wecom-bot/test_crypto.py     # 加解密 + 验签
wechat-bot/py312/python.exe wecom-bot/test_message.py    # XML + HTTP 端到端
```

`npm test` 不启动窗口、不联网、不写盘（只临时增删一条提醒，最后还原），
用 `tools/electron-stub.js` 替身跑，秒级出结果。改了 `src/core/` 或 `src/main/` 就一定要跑。

**微信侧的铁律**：任何 `live=True` 的发送调用都必须打桩（`b.generate = _gen`），
否则会真的往真实会话发消息。踩过一次，往「wangzr」发出了「还行吧」，超出撤回时限。

## API Key 与配置

`.data/config.json` 的 `llm.apiKey` 可以用环境变量 `PET_LLM_API_KEY` 覆盖
（`config.getLLM()` 读取，不会写回文件）——在别人机器上跑、或 CI 里跑，就别把 Key 落盘。

## 提交规范

- 身份：仓库级已配 `smallsmallchiken <smallsmallchiken@users.noreply.github.com>`。
- 一个提交做一件事，中文描述，说清"改了什么 + 为什么"。
- 推送：
  ```bash
  GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes" git push
  ```
  22 端口在本机被代理阻断，remote 已指向 `ssh://git@ssh.github.com:443/...`，不要改回 `github.com`。

## 平台限制

- `reg.exe` 在本机工具沙箱属程序黑名单，`execFile('reg')` 会失败。应用内已用 PowerShell 兜底
  （`src/core/tools/apps.js` 的 `psQueryDefault`）。
- 沙箱内启动外部程序会 `spawn EPERM`，所以"打开应用"类功能无法在沙箱里端到端验证，属正常。
- 网易云客户端装在非标准目录 `D:\software\restore-app\CloudMusic\`，靠 `.data/config.json` 的
  `appAliases` 显式指定路径才能启动。改「打开应用」相关逻辑时别把这个分支删了。
- 本沙箱会拦经 Bash 发起的 PowerShell 调用，所以 `findByRunKey`（自启项反查）在这里测不出来，
  不代表它在真实运行环境下失效。
