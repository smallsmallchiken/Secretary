# 万能桌宠 · 比格多栋

一只住在 Windows 桌面右下角的比格犬，除了陪你坐着，还能真的替你干活：
开应用、控音乐、设提醒、截图、查东西，**还能替你回微信和 QQ**。

分两层：**动画层**（雪碧图状态机）+ **能力层**（可被模型调用的工具）。
配了模型之后，你用大白话提要求，它自己决定调哪个工具、按什么顺序调。

---

## 启动

```bash
cd G:/资料/Github-Plugin/Secretary
npm start
```

或者直接双击根目录的 **`start.bat`**（它会先清掉 `ELECTRON_RUN_AS_NODE` 再启动）。

依赖（Electron 33）已经装好。换机器先 `npm install`。

> `ELECTRON_RUN_AS_NODE` 是本机全局环境变量，不清掉的话 Electron 会退化成纯 Node，
> `require('electron')` 只拿到程序路径、`app` 是 undefined。这是最容易踩的坑。

---

## 现在就能用（不需要额外配置）

| 你说 | 它做什么 |
|---|---|
| 打开网易云 / 打开微信 / 开一下计算器 | 启动程序；没装客户端就自动开网页版 |
| 播放 / 暂停 / 下一首 / 上一首 | 控制系统媒体播放 |
| 静音 / 音量大一点 / 声音小一点 | 调系统音量 |
| 10分钟后提醒我喝水 | 定时提醒，到点弹通知 + 桌宠跳出来 |
| 明天下午三点提醒我交报告 | 支持「明天/后天 + 上午/下午/晚上 + 几点半」 |
| 我的提醒 / 取消所有提醒 | 查看、清空待办 |
| 现在几点 / 今天几号 | 报时间日期 |
| 截个屏 / 锁屏 | 截图存桌面 / 立即锁屏 |
| 搜索 显卡驱动怎么更新 | 浏览器搜索 |
| 回复老王说明天开会改到三点 | 生成微信回复文案并复制到剪贴板 |

这些走**本地规则引擎**，毫秒级响应，不花 token。

---

## 智能模式（已配置）

`.data/config.json` 里已经接好了 SiliconFlow 的 `deepseek-ai/DeepSeek-V4.1-Flash`，
面板左上角显示「智能模式」就说明生效了。

配了模型之后：

- **复杂说法自动交给模型**。像「帮我看看现在几点，然后提醒我二十分钟后去倒杯水」这种带
  多个意图的，本地规则会吃掉一半语义，所以会自动转给模型编排。
- 模型通过 function calling 调用同一套工具，跟本地规则共用一份工具注册表，
  两边行为完全一致。
- 简单单条指令仍然走本地，快且省 token。

换模型：点齿轮改接口地址 / Key / 模型名。任何 OpenAI 兼容服务都能用
（DeepSeek 官方、OpenAI、Kimi、通义、本地 Ollama…）。

实测日志（一轮真实的链式调用）：

```
[llm] 第 1 轮 → 调用 get_time {}
[llm] 第 1 轮 → 返回 "现在是 2026年10月28日 星期三 01:05"
[llm] 第 2 轮 → 调用 set_reminder {"text":"去倒杯水","at":"2026-10-28T01:25:00"}
[llm] 第 3 轮 → "现在是 01:05，周三凌晨。提醒已经定在 01:25，到点提醒你去倒杯水～"
```

---

## 性格与回复格式

设置面板「性格」区可以直接调，改完保存后下一条消息生效。

**四种语气**（同时会调采样温度，脾气越"活"温度越高）：

| 语气 | 温度 | 什么感觉 |
|---|---|---|
| 黏人 | 0.85 | 懒散、会撒娇、偶尔小抱怨，说到正事立刻认真 |
| 利落 | 0.30 | 助理口吻，不寒暄不卖萌，办事报结果，办不了说原因 |
| 损友 | 0.90 | 嘴上不饶人但正事靠谱，会吐槽你的拖延（只损行为不损人格） |
| 元气 | 0.80 | 精力过剩，爱打气，容易替你高兴 |

同一句「你好」的真实差异：

```
损友 → 你好，有事说事，我等着。
黏人 → 你好呀，我在呢，有什么要我帮忙的吗？
```

**三档长度**：很短（≤30 字）、适中（≤60 字）、可长一点（解释类可到 150 字）。

**格式是硬约束，写在所有性格共用的部分里**：只输出纯文本，禁止 Markdown、
禁止列表符号、默认单段。这条不是可有可无的偏好——气泡面板用 `textContent` 渲染，
模型真输出 `**加粗**` 的话，你看到的就是那串星号本身。

**完全自定义**：`persona.custom` 非空时会整体替换预设的性格描述，
`persona.signature` 则是追加的额外要求（比如「每句话结尾加个汪」）。

```json
"persona": {
  "preset": "损友",
  "length": "short",
  "emoji": false,
  "name": "多栋",
  "custom": "",
  "signature": "偶尔提到狗粮"
}
```

实现上提示词由 `src/core/persona.js` 拼装：身份设定 + 格式硬约束 + 能力边界三段组成，
预设只影响第一段，格式约束对所有性格一致。

---

## 自动回复微信 / QQ（已在服务器上跑，本地不启动）

> **2026-10-31 起：本地桌宠不再提供这两项服务。**值守整套搬到 Linux 服务器
> （`8.139.252.197`，NapCat + qqbot 容器），本地 `main.js` 不再连 OneBot WS、不拉 NapCat、
> 不拉微信客户端，右键菜单也没有这两个开关了。下面写的是这套系统的原理和网络结构，
> 代码仍在 `src/core/qq/`、`src/core/wechat/`，服务器跑的就是同一份。
> 部署、调参、排障见 `server/README.md`。

这是这个项目里最重的一块，独立成了两个子系统，和桌宠本体通过 IPC 通信。

### QQ：走官方协议端（稳）

```
QQ 客户端 ── NapCat ── OneBot 11 正向 WS :3001 ── 桌宠 src/core/qq/
```

NapCat 是一个独立进程，加载官方 QQ 内核并暴露标准 OneBot 接口，所以**收发都是结构化数据**，
不用截图不用 OCR。桌宠负责判断该不该回、怎么回。

- 开机自启时桌宠会先探 3001 端口，不通就静默拉起 NapCat（无控制台窗口）并尝试快速登录
- 只回**白名单内好友的私聊**；群聊、临时会话、图片一律不回
- 护栏：同一会话 20 秒间隔、连发 3 条停 5 分钟、每小时 20 条、60 秒去重、按 `message_id` 指纹防重复
- 状态落盘 `.data/qq-state.json`

**风险**：NapCat 是非官方协议端，有封号风险，**务必挂小号**。
NapCat 本体（1GB+）不入库，首次要自己下载到 `qq-bot/napcat/`。

### 微信：只能走 UI 自动化（脏但能用）

个人微信没有开放 API，微信 4.x 又打断了所有 hook 方案（WeChatFerry 只支持 3.9.12，
wxauto 已停更），所以只剩下 UI 自动化这条路。

```
微信数据库（只读）── 读消息
        UIA + OCR ── 发送
```

具体在 `wechat-bot/`，是个独立的 Python 进程，桌宠只负责拉起和开关：

| 能力 | 怎么做的 |
|---|---|
| 读消息 | **直接读本地加密数据库**（只读，检测风险最低），不是截图认字 |
| 发文字 | UIA 控件树 + 剪贴板粘贴 + 回车 |
| 发图片 | 剪贴板 + Ctrl+V |
| 发内置表情 | `Alt+E` 开面板 → 像素网格定位 → 点选 → 回车（面板是 Qt 自绘的，UIA 读不到） |
| 发语音条 | TTS → VB-Audio 虚拟声卡 → 临时切换默认录音设备 → 按住右 Alt 说话 |

拟人化做了这几件事（都在 `bot_db.py`）：回复前随机等 2–8 秒、长回复切成 2–3 条分开发、
群聊先用确定性规则判「是不是冲我来的」再交给模型、没接的话先攒着当上下文、
去掉 Markdown 和书面语、主动发消息有每日上限和时间窗。

**风险**：UI 自动化违反微信用户协议，封的是主号。同样建议小号。
详细配置见 `wechat-bot/README.md`。

### 企业微信：官方 API（零风险，但只能对同事用）

`wecom-bot/` 是另一套完全合规的实现：接收官方回调 + 主动发消息，没有任何封号风险。
代价是只能给**同企业通讯录**里的人用。三条路线怎么选，见 `wecom-bot/README.md` 开头的对照表。

### 半自动：生成草稿

如果你连 UI 自动化都不想用，还有一档最保守的：对桌宠说「回复老王说明天开会改到三点」，
它把话写好复制到剪贴板，你自己切到微信 `Ctrl+V` 回车。零风险，代价是多按一次粘贴。

---

## 操作

| 操作 | 效果 |
|---|---|
| 左键点宠物 | 弹出 / 收起对话面板 |
| 拖动宠物 | 挪位置 |
| 右键宠物 | 自绘透明菜单：自己漫步 / 溜达一圈 / 设置 / 退出（QQ、微信值守已迁到服务器，菜单里没有开关了） |
| `Alt + W` | 显隐对话面板（`Ctrl + Shift + Space` 也能用） |
| `Alt + Q` | 显隐桌宠本体（不退出进程） |
| `Alt + ↑` / `Alt + ↓` | 放大 / 缩小（0.45–2.0 倍） |
| `Esc` | 收起面板 |
| 托盘图标单击 | 唤起对话 |

不管它的时候，它会在 idle / 坐 / 趴 / 溜达之间自己切换，25–55 秒随机会真的在桌面上走两步
（撞到屏幕边缘会掉头）。干活时变成摸下巴的思考状态，干完开心一下。

---

## 架构

```
src/
├── main/                    # 主进程
│   ├── main.js              # 生命周期、IPC、消息调度、右键菜单条目
│   ├── windows.js           # 宠物窗口 + 气泡窗口 + 自绘菜单窗口，定位与失焦保护
│   ├── wander.js            # 自主漫游（主进程挪窗口 + 渲染器播行走帧）
│   ├── tray.js              # 系统托盘
│   ├── shortcuts.js         # 全局快捷键（默认 Alt+W / Alt+Q / Alt+↑↓）
│   ├── napcat.js            # 探测并静默拉起 QQ 协议端
│   ├── wechat-app.js        # 拉起微信客户端 + 托盘态唤窗
│   └── hidden-launch.js     # 静默启动封装（无控制台窗口）
├── preload/                 # contextBridge 安全桥，渲染进程不碰 Node
│   ├── pet-preload.js
│   ├── bubble-preload.js
│   └── menu-preload.js
├── renderer/
│   ├── pet/                 # canvas 逐帧动画引擎 + 状态机
│   ├── bubble/              # 对话面板 + 设置面板
│   └── menu/                # 自绘透明右键菜单（原生 Menu 无法透明）
└── core/
    ├── agent.js             # 意图路由：本地规则 / 中文时间解析 / LLM 编排
    ├── llm.js               # OpenAI 兼容客户端（function calling）
    ├── config.js            # 配置持久化
    ├── persona.js           # 性格提示词拼装（预设 + 格式硬约束）
    ├── debug.js             # 调试日志（Windows 上 console 不连控制台，落盘）
    ├── paths.js             # 路径解析（开机自启时 cwd 是 system32，不能靠 cwd）
    ├── qq/                  # OneBot 11 客户端 + 回复决策
    ├── wechat/              # 微信 Python 进程的托管（拉起 / 查状态 / 开关）
    └── tools/               # 能力层，一份定义同时供规则引擎和模型使用
        ├── apps.js          # 找应用：注册表 → 常见路径 → 开始菜单 → 协议 → 网页
        ├── media.js         # 媒体/音量（Win32 虚拟键）
        ├── system.js        # 时间、截图、锁屏、搜索、剪贴板
        ├── ps.js            # PowerShell 辅助
        ├── reminder.js      # 提醒调度 + 持久化
        ├── wechat.js        # 微信草稿（只写剪贴板，不发送）
        └── index.js         # 工具注册表
```

微信 / QQ / 企业微信三块各自独立成目录：`wechat-bot/`（Python）、`qq-bot/`（NapCat）、
`wecom-bot/`（Python），都不依赖 Electron 就能单独跑。

动画素材：`pets/duodong/spritesheet.webp`，8 列 × 9 行，单帧 192×208。
每行帧数不同（0:6 / 1:8 / 3:4 / 4:5 / 5:8 / 6:6 / 7:6 / 8:6）。
**第 2 行是第 1 行的水平镜像**（左向行走），不是重复帧——少了它往左走时会变成倒着退。

---

## 测试

四套测试，**都不需要开微信也能跑**（会碰真实微信的调用全部打了桩）：

```bash
# 桌宠主进程：模块加载 + 对话链路（不需要 GUI）
node tools/test-agent.js
# 漫游位移逻辑
node tools/test-wander.js

# 微信决策链：群聊门禁 / 分段 / 缓冲 / 概率闸 / 媒体标记
wechat-bot/py312/python.exe wechat-bot/test_db_flow.py
# 护栏：频率限制 / 去重 / 白名单
wechat-bot/py312/python.exe wechat-bot/test_guard.py

# 企业微信：加解密 / XML / HTTP 端到端（离线）
wechat-bot/py312/python.exe wecom-bot/test_crypto.py
wechat-bot/py312/python.exe wecom-bot/test_message.py
```

微信侧有一个必须遵守的约定：**任何 `live=True` 的发送都必须打桩**
（`b.generate = _gen`），否则会真的往真实会话里发消息。之前踩过一次，往「wangzr」发出了「还行吧」。

---

## 配置与数据

- 开发运行：`项目/.data/config.json`
- 打包后：`%APPDATA%/万能桌宠/config.json`
- 提醒队列：`.data/reminders.json`（重启不丢）
- 调试日志：`.data/debug.log`（主进程 console 不连终端，只能看这个文件）
- QQ 状态：`.data/qq-state.json`

`.data/` 里有 API Key，**不要提交到 git**。同理还有 `config.json`（旧 Python 版）、
`wechat-bot/bot-db-config.json`、`wecom-bot/config.json`。

---

## 已知情况

**网易云装在非标准目录。** 它在 `D:\software\restore-app\CloudMusic\`，注册表和常见路径都猜不到，
所以通过 `appAliases` 显式配置了路径（见下）。

**会看到两只狗。** 之前通过 petdex 装的静态桌宠还在跑（窗口标题 `多栋`，纯皮肤无能力）。
在 Petdex Desktop 里关掉它，只留这个。

**沙箱环境限制。** 如果启动时提示 `spawn EPERM`，是运行环境禁止启动外部程序；
正常双击启动不受此限制。

---

## 应用装在奇怪目录时怎么办

「打开应用」的查找顺序是：配置里的 `appAliases` → 常见路径 → 注册表 App Paths →
开机自启项反查 → 开始菜单 → 协议 → 网页版。

如果都找不到（比如装在了 `D:\software\restore-app\...` 这种地方），
直接在 `.data/config.json` 里写死路径，这是优先级最高的一档：

```json
"appAliases": {
  "网易云": "D:\\software\\restore-app\\CloudMusic\\cloudmusic.exe",
  "微信": "C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe"
}
```

键名可以用口语别名（说「打开网易云」就能命中）。

---

## 开机自启

托盘菜单或设置面板里勾选「开机自动启动」，会写入
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。

开发模式下注册的命令会带上项目路径和那排 `--disable-gpu` 参数——
少了它们，开机启动时会因为 GPU 进程崩溃而失败。打包成 exe 后只需注册 exe 本身。

**开机后会连带拉起的东西**（都是静默的，不弹控制台）：

1. NapCat（QQ 协议端）+ 快速登录
2. 微信客户端——微信 4.x 常驻托盘且没有主窗口时，UI 自动化抓不到，所以还要再执行一次
   exe 触发单实例唤窗
3. 微信自动回复的 Python 值守进程

这三个都有开关（`.data/config.json` 的 `qq.napcatAutostart`、`wechat.autostart`、
`wechat.autoreply`）。**一个坑**：开机自启时 `process.cwd()` 是 `C:\Windows\system32`，
所有路径都必须用 `app.getAppPath()` 算，不能用相对路径。

**托盘图标在哪：** 应用窗口设了 `skipTaskbar`，不会占用任务栏。
图标由系统托盘承载，Windows 11 默认把新图标收进 `^` 折叠区。
想让它常驻任务栏，点 `^` 展开后把它拖到外面即可（系统记住这个设置）。


---

## 目录里几个 .bat 的区别

容易搞混，列一下：

| 文件 | 作用 |
|---|---|
| `start.bat` | **启动桌宠（Electron 版）**，日常用这个 |
| `run.bat` | 启动旧 Python 版桌宠（`app/pet.py`），只能聊天 |
| `setup.bat` | 给旧 Python 版建 `.venv` 环境，只跑一次 |

`app/`、`run.bat`、`setup.bat`、`config.json` 是早先的 Python 实现，它只能聊天、
不能操作电脑，也没有微信/QQ 那套。Electron 版重写了它并补上了工具层，
**新版本是功能超集**，旧版仅作备选保留。

两者互不干扰（配置文件名不同：`config.json` vs `.data/config.json`）。

---

## 打包成 exe（可选）

```bash
npm i -D electron-builder
npx electron-builder --win portable
```

产物在 `dist/`。首次会下载约 100MB 打包工具链。
