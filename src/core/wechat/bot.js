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
const SCRIPT = path.join(WX_DIR, 'bot_db.py');
const CONF = path.join(WX_DIR, 'bot-db-config.json');
const LOG = path.join(WX_DIR, 'live.log');

const DISCOVER_INTERVAL_MS = 30000;

/** 缓存给同步调用方（右键菜单）用，避免菜单为了问一句话卡 500ms。 */
let cached = {
  available: false,
  running: false,
  pid: null,
  replyToAll: true,
  groupMode: 'all',
  persona: ''
};
let lastDiscoverAt = null;
let refreshing = null;
let notify = null;

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
      persona: cfg.persona || ''
    };
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

async function start() {
  await refresh(true);
  if (!cached.available) {
    say('微信自动回复没配好：找不到 wechat-bot/py312/python.exe 或 bot_db.py');
    return { ok: false, message: '缺少 py312 环境' };
  }
  if (cached.running) {
    return { ok: true, message: '已经在跑了' };
  }
  let fd = 'ignore';
  try {
    fd = fs.openSync(LOG, 'a');
  } catch (err) {
    dbg('[wx] 打开 live.log 失败（改成丢弃输出）：', err.message);
  }
  let child;
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
  child.on('exit', (code) => {
    dbg('[wx] 子进程退出，code =', code);
    clearPid();
    refresh(true).catch(() => {});
  });
  child.unref();
  writePid(child.pid);
  // 直接信这个 pid，别去问系统进程表 —— 刚拉起来的进程可能还没进 WMI 查询窗口
  lastDiscoverAt = { at: Date.now(), pid: child.pid };
  dbg('[wx] 已拉起，pid =', child.pid);

  // 起来就死的常见原因是 py312 环境坏了、或者另一个实例占着，等一下确认
  await new Promise((r) => setTimeout(r, 800));
  if (!alive(child.pid)) {
    clearPid();
    lastDiscoverAt = null;
    cached = { ...cached, running: false, pid: null };
    say('微信自动回复没起来，详细报错看 wechat-bot/live.log 末尾');
    return { ok: false, message: '进程启动后立刻退出' };
  }
  cached = { ...cached, running: true, pid: child.pid };
  say('微信自动回复已开启，开始值守未读会话');
  return { ok: true };
}

async function stop(silent = false) {
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

module.exports = {
  refresh,
  status,
  start,
  stop,
  toggle,
  setNotifier,
  // 测试用
  _internals: { alive, readPid, writePid, clearPid, readCfg, available, ROOT }
};
