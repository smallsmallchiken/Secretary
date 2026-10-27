# AGENTS.md

给参与本项目的 AI 助手看的协作约定。人类说明见 `README.md`。

## 这是什么

Windows 桌面宠（Electron），带可被 LLM 调用的工具层。核心是"本地规则 + 模型编排"双路径，
两条路径共用 `src/core/tools/index.js` 里同一份工具定义——**加能力只改这一处**。

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

- **不要提交 `config.json` 和 `.data/config.json`**。两者都含明文 API Key。
  仓库是 **public**，泄露即失效。提交前跑一次：
  ```bash
  git diff --cached | grep -E "sk-[a-zA-Z0-9]{20,}"
  ```
  有输出就立刻 `git reset` 并检查 `.gitignore`。
- 不要为了"修好"而删掉 `pets/duodong/spritesheet.webp` 或改动它的尺寸假设
  （8 列 × 9 行，单帧 192×208，各行帧数 6/8/8/4/5/8/6/6/6）。
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
| `src/core/` | 意图路由、LLM、工具层。改这里要同时跑 `node tools/test-agent.js` |
| `src/main/` | 窗口、托盘、快捷键、漫游。改这里要跑 `node tools/test-wander.js` |
| `src/renderer/` | 动画与 UI，纯前端 |
| `app/` | **旧的 Python 版，已停用**。除非要复活它，否则不要改 |

## 改完必须验证

```bash
npm test                                   # 一条命令跑完下面三条
node tools/test-agent.js --check           # 离线断言 39 条：规则路由 / 时间解析 / LLM 路径回归
node tools/test-wander.js                  # 漫游逻辑
node tools/test-pet-anim.js                # 逐帧动画循环（一次性动画播完不能断）
node tools/test-agent.js "现在几点了"      # 需要时再跑：真实链路（会联网）
```

`--check` 不联网、不写盘（只临时增删一条提醒，最后还原），失败非零退出。
脚本都不启动窗口，用 `tools/electron-stub.js` 替身跑，秒级出结果。
改了 `src/core/` 或 `src/main/` 就一定要跑 `npm test`。

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
