'use strict';

/**
 * NapCat 自动拉起（QQ 自动回复的"另一头"）。
 *
 * 背景：开机自启只拉桌宠，NapCat（独立 QQ 内核）不会自己起来，QQ 就一直连不上。
 * 桌宠启动时检测 127.0.0.1:3001 不通就替用户拉起 NapCat 快速登录，之后 QQ 客户端
 * （src/core/qq/client.js）的无限重连自然会接上。
 *
 * 为什么走 WMI：和 src/core/wechat/bot.js 的 startViaWmi 同理——直接 spawn 出来的
 * 进程挂在 Electron 进树/job 里，桌宠重启会被一起收走；WMI 创建的进程父级是
 * WmiPrvSE，跟桌宠彻底脱钩。 NapCat 是控制台程序，WMI 直启会给它一个可见控制台，
 * 正好和手动跑 napcat.bat 的体验一致（能看日志，关掉窗口 = 停掉 QQ 值守）。
 *
 * 相关配置（.data/config.json 的 qq 节）：
 *   napcatAutostart  是否自动拉起（默认 true；手动管理 NapCat 的用户可关）
 *   quickLoginUin    快速登录的 QQ 号（首次跑 bot 时由登录信息回填）
 *   napcatExe        NapCatWinBootMain.exe 路径（默认项目内 qq-bot/napcat/...）
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const config = require('../core/config');
const debug = require('../core/debug');

const dbg = debug.dbg;
const PORT = 3001;
const RECHECK_MS = 2 * 60 * 1000;   // 周期兜底检查
const SPAWN_COOLDOWN_MS = 90 * 1000; // 两次拉起之间至少隔这么久，防止反复拉尸体
let lastSpawnAt = 0;
let timer = null;

function cfg() {
  return config.get('qq', {}) || {};
}

function napcatExe() {
  const c = cfg();
  if (c.napcatExe && fs.existsSync(c.napcatExe)) return c.napcatExe;
  return path.join(process.cwd(), 'qq-bot', 'napcat', 'NapCat.52230.Shell', 'NapCatWinBootMain.exe');
}

/** 探测 OneBot WS 端口通不通。NapCat 登录成功后才会监听，通了 = 可用 */
function probePort(timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: PORT, host: '127.0.0.1' });
    const done = (ok) => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** WMI 创建 NapCat 进程（父级 WmiPrvSE，与桌宠脱钩）。返回 pid 或 null */
function startViaWmi() {
  return new Promise((resolve) => {
    const exe = napcatExe();
    const uin = String(cfg().quickLoginUin || '').trim();
    const cmdline = uin ? `"${exe}" ${uin}` : `"${exe}"`;
    const cwd = path.dirname(exe);
    const ps =
      '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ' +
      `-Arguments @{ CommandLine = ${psQuote(cmdline)}; CurrentDirectory = ${psQuote(cwd)} }; ` +
      'Write-Output ("{0}|{1}" -f $r.ProcessId, $r.ReturnValue)';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          dbg('[napcat] WMI 启动失败：', err.message.split('\n')[0]);
          return resolve(null);
        }
        const [pidStr, rc] = String(stdout).trim().split('|');
        const pid = parseInt(pidStr, 10);
        if (String(rc).trim() !== '0' || !Number.isFinite(pid)) {
          dbg('[napcat] WMI 启动返回异常：pid=', pidStr, 'rc=', rc);
          return resolve(null);
        }
        dbg('[napcat] WMI 创建成功 pid =', pid);
        resolve(pid);
      }
    );
  });
}

/** 拉起 NapCat（带冷却与端口预检）。返回 { ok, reason } */
async function ensureNapCat() {
  const c = cfg();
  if (c.napcatAutostart === false) return { ok: false, reason: 'disabled' };
  if (await probePort()) return { ok: true, reason: 'already-running' };
  if (Date.now() - lastSpawnAt < SPAWN_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown' };
  }
  const exe = napcatExe();
  if (!fs.existsSync(exe)) {
    dbg('[napcat] 找不到', exe, '-> 不拉起');
    return { ok: false, reason: 'exe-missing' };
  }
  lastSpawnAt = Date.now();
  const uin = String(c.quickLoginUin || '').trim();
  dbg('[napcat] 端口 3001 不通，拉起 NapCat', uin ? `(快速登录 ${uin})` : '');

  const pid = await startViaWmi();
  if (pid) return { ok: true, reason: 'wmi' };

  // 退路：普通 spawn（能用，但桌宠退出时会被一起带走）
  try {
    const child = spawn(exe, uin ? [uin] : [], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    dbg('[napcat] 退路 spawn 成功 pid =', child.pid);
    return { ok: true, reason: 'spawn' };
  } catch (err) {
    dbg('[napcat] spawn 失败：', err.message);
    return { ok: false, reason: err.message };
  }
}

/** 桌宠启动时调用一次，并挂周期兜底（NapCat 掉线且 3001 不通时自动重拉） */
function init() {
  ensureNapCat().then((r) => {
    if (r.reason === 'already-running') dbg('[napcat] NapCat 已在运行，不用拉');
    else if (r.ok) dbg('[napcat] 已发起拉起，等 QQ 登录后 3001 会就绪');
  });
  if (!timer) {
    timer = setInterval(() => {
      ensureNapCat().catch((err) => dbg('[napcat] 周期检查异常：', err.message));
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

module.exports = { init, ensureNapCat, shutdown };
