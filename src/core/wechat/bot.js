'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { dbg } = require('../debug');
const { dataDir } = require('../paths');

/**
 * 微信自动回复的开关（右键菜单里那一条）。
 *
 * 和 QQ 不一样：微信这套是**独立的 Python 进程**（wechat-bot/bot_db.py watch --live），
 * 不在 Electron 里跑，因为要依赖 wechatauto-replica 的 winsdk（只有 py312 有 wheel）。
 * 所以这里只做三件事：看进程活没活、拉起来、杀掉。
 *
 * 进程识别：优先 pid 文件（我们拉起来的会写），没有就问一次 WMI/CIM
 * （用户手工起的、或者上次 Electron 重启前起的，只能这么找）。
 * 查到就把 pid 落盘，之后每 5 秒刷新只是一次 kill(pid,0)，很便宜。
 */

const ROOT = path.resolve(__dirname, '../../..');
const WX_DIR = path.join(ROOT, 'wechat-bot');
const PY = path.join(WX_DIR, 'py312', 'python.exe');
// pythonw 是 GUI 子系统：Windows 不会给它分配控制台，也就收不到 Ctrl+C。
// 值守进程被杀的事故就是 cmd 那个隐藏控制台连坐导致的，见 startViaWmi 的注释。
const PYW = path.join(WX_DIR, 'py312', 'pythonw.exe');
const SCRIPT = path.join(WX_DIR, 'bot_db.py');
const CONF = path.join(WX_DIR, 'bot-db-config.json');
const LOG = path.join(WX_DIR, 'live.log');

const DISCOVER_INTERVAL_MS = 30000;
const RESTART_COOLDOWN_MS = 15000;
const MAX_FAIL_STREAK = 5;

/** 缓存给同步调用方（右键菜单）用，避免菜单为了问一句话卡 500ms。 */
let cached = {
  available: false,
  running: false,
  pid: null,
  replyToAll: true,
  groupMode: 'all',
  whitelistCount: 0,
  persona: ''
};
let lastDiscoverAt = null;
let refreshing = null;
let notify = null;
let lastStartAt = 0;
let failStreak = 0;
let ensuring = null;

function setNotifier(fn) {
  notify = typeof fn === 'function' ? fn : null;
}

function say(text) {
  dbg('[wx]', text);
  if (notify) {
    try {
      notify(text);
    } catch (err) {
      dbg('[wx] 通知失败：', err.message);
    }
  }
}

function available() {
  try {
    return fs.existsSync(PY) && fs.existsSync(SCRIPT);
  } catch {
    return false;
  }
}

function readCfg() {
  try {
    return JSON.parse(fs.readFileSync(CONF, 'utf8')) || {};
  } catch (err) {
    dbg('[wx] 读 bot-db-config.json 失败：', err.message);
    return {};
  }
}

function pidFile() {
  try {
    return path.join(dataDir(), 'wechat-bot.pid');
  } catch {
    return path.join(WX_DIR, 'bot.pid');
  }
}

function readPid() {
  try {
    const n = parseInt(fs.readFileSync(pidFile(), 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  try {
    fs.writeFileSync(pidFile(), String(pid), 'utf8');
  } catch (err) {
    dbg('[wx] 写 pid 失败：', err.message);
  }
}

function clearPid() {
  try {
    fs.unlinkSync(pidFile());
  } catch {
    /* 没文件就没事 */
  }
}

/**
 * 「用户想要它开着」的标记。
 *
 * pid 文件只能说明现在有没有进程，说明不了**该不该**有进程。看门狗要自动重启，
 * 就必须能区分两种「没在跑」：用户主动关的（别管）、自己掉线的（要拉起来）。
 */
function wantFile() {
  try {
    return path.join(dataDir(), 'wechat-bot.want');
  } catch {
    return path.join(WX_DIR, 'bot.want');
  }
}

function setWant(on) {
  try {
    if (on) fs.writeFileSync(wantFile(), String(Date.now()), 'utf8');
    else fs.unlinkSync(wantFile());
  } catch (err) {
    if (err.code !== 'ENOENT') dbg('[wx] 写 want 标记失败：', err.message);
  }
}

function isWanted() {
  try {
    return fs.existsSync(wantFile());
  } catch {
    return false;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程在，只是没权限发信号（Windows 上少见，但别当成死了）
    return err.code === 'EPERM';
  }
}

/** 问一次系统：哪个 python 进程在跑 bot_db.py。找不到返回 null。 */
function discoverPid() {
  return new Promise((resolve) => {
    const ps =
      "$p = Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | " +
      "Where-Object { $_.CommandLine -like '*bot_db.py*' } | " +
      'Select-Object -First 1 -ExpandProperty ProcessId; if ($p) { $p }';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          dbg('[wx] 查进程失败：', err.message.split('\n')[0]);
          return resolve(null);
        }
        const n = parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(n) && n > 0 ? n : null);
      }
    );
  });
}

/** 刷新缓存。并发调用会复用同一个 Promise。
 *
 *  只认「命令行里带 bot_db.py 的 python 进程」，不盲信 pid 文件：Windows 会复用 PID，
 *  我们的机器人挂掉之后那个号可能被别的程序占上，盲信就会把无关进程当机器人、
 *  甚至在点「关闭」时把人家杀掉。
 */
function refresh(force = false) {
  if (refreshing && !force) return refreshing;
  refreshing = (async () => {
    const cfg = readCfg();
    const avail = available();
    let pid = null;
    const fresh = lastDiscoverAt && Date.now() - lastDiscoverAt.at < DISCOVER_INTERVAL_MS;
    if (!force && fresh) {
      pid = lastDiscoverAt.pid;
    } else if (avail) {
      pid = await discoverPid();
      lastDiscoverAt = { at: Date.now(), pid };
      if (pid) writePid(pid);
      else clearPid();
    }
    cached = {
      available: avail,
      running: !!pid,
      pid,
      replyToAll: cfg.replyToAll !== false,
      groupMode: cfg.groupMode || 'all',
      whitelistCount: Array.isArray(cfg.whitelist) ? cfg.whitelist.length : 0,
      persona: cfg.persona || ''
    };
    // 认回「应该开着」的意愿：桌宠重启、或者值守是别人手工起的，
    // 只要看到进程活着就把标记补上，看门狗之后才会接着自愈。
    if (pid && !isWanted()) setWant(true);
    return cached;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** 同步读缓存（右键菜单用）。第一次前是 available:false，调用方先 refresh 一次即可。 */
function status() {
  return { ...cached };
}

/** PowerShell 单引号字符串转义（路径里可能带单引号，虽然少见）。 */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * 用 WMI 创建进程，而不是 spawn。
 *
 * 直接 spawn 出来的进程挂在 Electron 的进程树/job 里，桌宠一退出（甚至只是重启）
 * 就被一起收走 —— 实测确认过：关掉主进程后 python 立刻没了。
 * 走 Win32_Process.Create，父级是 WmiPrvSE，跟桌宠彻底脱钩，重启桌宠也不影响值守。
 *
 * **别再用 `cmd /c "... >> live.log"` 包一层。** 那样 WMI 创建的是 cmd，
 * cmd 是控制台程序、会拿到一个隐藏控制台；一旦这个控制台被 Ctrl+C 广播波及，
 * cmd 和它下面的 python 一起死，live.log 里只留下一个 `^C`（实际踩了两次：
 * 20:47、20:52 各掉一次线）。现在改成 pythonw.exe（GUI 子系统，没有控制台），
 * 日志由 bot_db.py 的 ensure_output() 自己写文件，整条链都不碰控制台。
 *
 * 返回新进程 pid。
 */
function startViaWmi() {
  return new Promise((resolve) => {
    const usePythonw = fs.existsSync(PYW);
    const cmdline = usePythonw
      ? `"${PYW}" -u "${SCRIPT}" watch --live`
      : `cmd /c ""${PY}" -u "${SCRIPT}" watch --live >> "${LOG}" 2>&1"`;
    const ps =
      '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ' +
      `-Arguments @{ CommandLine = ${psQuote(cmdline)}; CurrentDirectory = ${psQuote(ROOT)} }; ` +
      'Write-Output ("{0}|{1}" -f $r.ProcessId, $r.ReturnValue)';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          dbg('[wx] WMI 启动失败：', err.message.split('\n')[0]);
          return resolve(null);
        }
        const [pidStr, rc] = String(stdout).trim().split('|');
        const pid = parseInt(pidStr, 10);
        if (String(rc).trim() !== '0' || !Number.isFinite(pid)) {
          dbg('[wx] WMI 启动返回异常：pid=', pidStr, 'rc=', rc);
          return resolve(null);
        }
        dbg('[wx] 用', usePythonw ? 'pythonw（无控制台）' : 'python+cmd（回退）', '创建，pid =', pid);
        resolve(pid);
      }
    );
  });
}

async function start(opts = {}) {
  setWant(true); // 先记下「用户要它开着」，看门狗据此判断该不该自动拉起
  lastStartAt = Date.now();
  await refresh(true);
  if (!cached.available) {
    say('微信自动回复没配好：找不到 wechat-bot/py312/python.exe 或 bot_db.py');
    return { ok: false, message: '缺少 py312 环境' };
  }
  if (cached.running) {
    return { ok: true, message: '已经在跑了' };
  }

  let child = null;
  const wmiPid = await startViaWmi();
  if (!wmiPid) {
    // 退路：普通 spawn。能用，但桌宠退出时会被一起带走
    let fd = 'ignore';
    try {
      fd = fs.openSync(LOG, 'a');
    } catch (err) {
      dbg('[wx] 打开 live.log 失败（改成丢弃输出）：', err.message);
    }
    try {
      child = spawn(PY, ['-u', SCRIPT, 'watch', '--live'], {
        cwd: ROOT,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd]
      });
    } catch (err) {
      say('微信自动回复启动失败：' + err.message);
      return { ok: false, message: err.message };
    }
    if (typeof fd === 'number') {
      try {
        fs.closeSync(fd); // 父进程不用留着，子进程自己持有句柄
      } catch {
        /* ignore */
      }
    }
    // spawn 的失败是异步 emit 的，不监听会直接崩主进程
    child.on('error', (err) => {
      dbg('[wx] 子进程错误：', err.message);
      clearPid();
      say('微信自动回复启动失败：' + err.message);
    });
    child.unref();
  }

  dbg('[wx] 已拉起，pid =', wmiPid || (child && child.pid));
  writePid(wmiPid || (child && child.pid));

  // 起来就死的常见原因是 py312 环境坏了、或者另一个实例占着，等一下确认
  await new Promise((r) => setTimeout(r, 900));
  const realPid = (await discoverPid()) || wmiPid || (child && child.pid);
  lastDiscoverAt = { at: Date.now(), pid: realPid || null };
  if (!realPid || !alive(realPid)) {
    clearPid();
    lastDiscoverAt = null;
    cached = { ...cached, running: false, pid: null };
    failStreak += 1;
    say('微信自动回复没起来，详细报错看 wechat-bot/live.log 末尾');
    return { ok: false, message: '进程启动后立刻退出' };
  }
  cached = { ...cached, running: true, pid: realPid };
  failStreak = 0;
  say(opts.auto ? '微信值守掉线了，已自动重新拉起' : '微信自动回复已开启，开始值守未读会话');
  return { ok: true };
}

async function stop(silent = false) {
  setWant(false); // 用户主动关的，看门狗别再把它拉起来
  // 杀之前重新确认一次：只杀命令行里带 bot_db.py 的进程，防止 PID 复用误杀别人
  const pid = await discoverPid();
  if (pid && alive(pid)) {
    try {
      process.kill(pid);
      dbg('[wx] 已结束 pid =', pid);
    } catch (err) {
      dbg('[wx] kill 失败，改用 taskkill：', err.message);
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    }
  }
  clearPid();
  lastDiscoverAt = { at: Date.now(), pid: null };
  cached = { ...cached, running: false, pid: null };
  await new Promise((r) => setTimeout(r, 500));
  await refresh(true);
  if (!silent) say('微信自动回复已关闭');
  return { ok: true };
}

async function toggle() {
  await refresh(true);
  if (cached.running) {
    await stop();
  } else {
    await start();
  }
  return status();
}

/**
 * 看门狗：掉线自动拉起。
 *
 * 只做「用户本来要它开着」的那部分：want 标记不存在（用户主动关的）就什么都不做。
 * 连续失败 MAX_FAIL_STREAK 次就停手并说一声，免得环境坏了时每 15 秒弹一次气泡、
 * 每 15 秒开一次进程。
 */
function ensureRunning() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    if (!isWanted()) return { ok: true, skipped: 'not wanted' };
    if (failStreak >= MAX_FAIL_STREAK) return { ok: false, skipped: 'too many failures' };
    if (Date.now() - lastStartAt < RESTART_COOLDOWN_MS) return { ok: true, skipped: 'cooling' };
    // 先看缓存里那个 pid 活没活，绝大多数情况这次 kill(pid,0) 就够了，不用问系统
    if (cached.pid && alive(cached.pid)) return { ok: true, skipped: 'alive' };
    await refresh(true);
    if (cached.running) return { ok: true, skipped: 'alive' };
    dbg('[wx] 看门狗发现值守进程不在了，尝试拉起');
    return start({ auto: true });
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

module.exports = {
  refresh,
  status,
  start,
  stop,
  toggle,
  ensureRunning,
  setNotifier,
  // 测试用
  _internals: {
    alive, readPid, writePid, clearPid, readCfg, available, isWanted, setWant, ROOT
  }
};
