'use strict';

/**
 * 微信客户端保活（微信自动回复的前置条件）。
 *
 * **本地已停用**：微信值守在服务器上跑，main.js 不再调用这里的 init()（2026-10-31）。
 * 代码留着，回退到本地值守时按 git 历史把接线补回来即可。
 *
 * 问题：开机后只有桌宠自己起来，**微信 PC 端根本不在跑**，微信值守进程抓不到窗口，
 * 于是"微信没连上"。微信本身没有可用的自启项（本机实测 Run 项里没有），
 * 所以由桌宠在启动时负责把客户端拉起来。
 *
 * 注意：这里只负责"把客户端打开"。如果微信没开启自动登录，仍会停在扫码页——
 * 那一步只能用户在客户端里勾「自动登录」，程序无法代劳。
 *
 * 配置（.data/config.json）：
 *   appAliases["微信"]  微信可执行文件路径（找不到就按常见路径探测）
 *   wechat.autostart    设为 false 可关闭这个保活（默认开）
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../core/config');
const debug = require('../core/debug');
const { startHidden } = require('./hidden-launch');

const dbg = debug.dbg;
const RECHECK_MS = 3 * 60 * 1000;  // 掉线后最多 3 分钟补拉一次
const SPAWN_COOLDOWN_MS = 60 * 1000;
let lastSpawnAt = 0;
let timer = null;

const CANDIDATES = [
  'D:/software/restore-app/Weixin/Weixin.exe', // 本机（新版微信 4.x）
  'C:/Program Files/Tencent/Weixin/Weixin.exe',
  'C:/Program Files (x86)/Tencent/Weixin/Weixin.exe',
  'C:/Program Files/Tencent/WeChat/WeChat.exe',
  'C:/Program Files (x86)/Tencent/WeChat/WeChat.exe',
  'D:/software/restore-app/WeChat/WeChat.exe'
];

function wechatExe() {
  const aliases = config.get('appAliases', {}) || {};
  for (const key of ['微信', 'wechat', 'WeChat', 'weixin']) {
    const p = aliases[key];
    if (p && fs.existsSync(p)) return p;
  }
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/** 微信在不在跑。新版叫 Weixin.exe，旧版 WeChat.exe，两个都认 */
function isRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null); // 查不了就当不知道，不贸然再开一个
      const out = String(stdout).toLowerCase();
      resolve(out.includes('weixin.exe') || out.includes('wechat.exe'));
    });
  });
}

/**
 * 唤出主窗口。
 *
 * 微信 4.x 常见状态：进程在跑、只剩一个托盘图标，主窗口根本没创建；
 * 值守进程靠截图 OCR 干活，没有窗口就什么也读不到。再执行一次客户端
 * （单实例程序）会把主窗口叫出来。
 *
 * 只在「本轮我们自己刚拉起客户端」时补一次，不做周期性判断——
 * 窗口检测本身不可靠（PowerShell 的 MainWindowHandle 会把托盘隐藏消息窗
 * 也算成主窗口），周期性乱唤会不停抢用户焦点。
 */
async function summonOnce(exe, delayMs = 10000) {
  setTimeout(() => {
    dbg('[wechat-app] 补一次唤窗（客户端可能只在托盘）');
    startHidden(exe, [], path.dirname(exe), 'wechat-app').catch(() => {});
  }, delayMs).unref?.();
}

async function ensureWeChat() {
  if (config.get('wechat.autostart', true) === false) return { ok: false, reason: 'disabled' };
  const running = await isRunning();
  if (running !== false) {
    // 已经在跑就完全不动它：可能是用户自己开着的，别抢焦点
    return { ok: true, reason: running ? 'already-running' : 'unknown' };
  }
  if (Date.now() - lastSpawnAt < SPAWN_COOLDOWN_MS) return { ok: false, reason: 'cooldown' };

  const exe = wechatExe();
  if (!exe) {
    dbg('[wechat-app] 找不到微信客户端，跳过自动拉起');
    return { ok: false, reason: 'exe-missing' };
  }
  lastSpawnAt = Date.now();
  dbg('[wechat-app] 微信没在跑，静默拉起', exe);
  const pid = await startHidden(exe, [], path.dirname(exe), 'wechat-app');
  if (pid) {
    summonOnce(exe);
    return { ok: true, reason: 'launched' };
  }

  // 退路：普通 spawn（会被桌宠进程树带着走，但聊胜于无）
  try {
    const { spawn } = require('child_process');
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    dbg('[wechat-app] 退路 spawn 成功 pid =', child.pid);
    summonOnce(exe);
    return { ok: true, reason: 'spawn' };
  } catch (err) {
    dbg('[wechat-app] spawn 失败：', err.message);
    return { ok: false, reason: err.message };
  }
}

function init() {
  ensureWeChat().then((r) => {
    if (r.reason === 'already-running') dbg('[wechat-app] 微信已在运行');
  });
  if (!timer) {
    timer = setInterval(() => {
      ensureWeChat().catch((err) => dbg('[wechat-app] 周期检查异常：', err.message));
    }, RECHECK_MS);
    if (timer.unref) timer.unref();
  }
}

function shutdown() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { init, ensureWeChat, shutdown };
