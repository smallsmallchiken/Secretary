'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { shell, clipboard } = require('electron');
const { spawn } = require('child_process');
const { runPowerShell } = require('./ps');

function pad(n) {
  return String(n).padStart(2, '0');
}

function nowText() {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 系统级操作 */
async function run(action, args = {}) {
  switch (action) {
    case 'time':
      return { ok: true, message: `现在是 ${nowText()}` };

    case 'shutdown': {
      // 留 15 秒缓冲：手机上点错还有机会用「取消关机」救回来（shutdown /a）
      const sec = Math.max(0, Math.min(600, Number(args.delay) || 15));
      spawn('shutdown.exe', ['/s', '/t', String(sec), '/c', '远程关机'], {
        detached: true,
        stdio: 'ignore'
      }).unref();
      return { ok: true, message: sec ? `${sec} 秒后关机` : '正在关机' };
    }

    case 'restart': {
      const sec = Math.max(0, Math.min(600, Number(args.delay) || 15));
      spawn('shutdown.exe', ['/r', '/t', String(sec), '/c', '远程重启'], {
        detached: true,
        stdio: 'ignore'
      }).unref();
      return { ok: true, message: sec ? `${sec} 秒后重启` : '正在重启' };
    }

    case 'cancel': {
      // /a 在「没有待执行的关机」时会返回非 0。不用 stderr 的内容当提示：
      // PowerShell 的错误流是 GBK，在 Node 里按 UTF-8 读会变成乱码
      await new Promise((resolve, reject) => {
        const p = spawn('shutdown.exe', ['/a'], { windowsHide: true });
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('没有待取消的关机'))));
        p.on('error', reject);
      });
      return { ok: true, message: '已取消关机' };
    }

    case 'sleep':
      // hibernate 未启用，这个调用走的是 S0 待机。detached 是必须的：进程要活到自己被挂起
      spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], {
        detached: true,
        stdio: 'ignore'
      }).unref();
      return { ok: true, message: '正在睡眠' };

    case 'lock':
      spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, message: '已锁屏' };

    case 'search': {
      const q = String(args.query || '').trim();
      if (!q) throw new Error('搜什么？');
      await shell.openExternal(`https://www.bing.com/search?q=${encodeURIComponent(q)}`);
      return { ok: true, message: `已在浏览器搜索：${q}` };
    }

    case 'open_path': {
      const target = String(args.path || '').trim();
      if (!target) throw new Error('要打开哪个路径？');
      const err = await shell.openPath(target);
      if (err) throw new Error(err);
      return { ok: true, message: `已打开 ${target}` };
    }

    case 'open_url': {
      const url = String(args.url || '').trim();
      if (!url) throw new Error('要打开哪个网址？');
      // 只放行 http/https：和 bubble:open-external 的校验保持一致，
      // 否则模型给的 file:// 或自定义协议会被原样交给系统打开
      if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 网址');
      await shell.openExternal(url);
      return { ok: true, message: '已在浏览器打开' };
    }

    case 'clipboard_write':
      clipboard.writeText(String(args.text ?? ''));
      return { ok: true, message: '已复制到剪贴板' };

    case 'clipboard_read': {
      const text = clipboard.readText();
      return { ok: true, message: text ? `剪贴板内容：${text.slice(0, 200)}` : '剪贴板是空的', data: text };
    }

    case 'screenshot': {
      // 全屏截图存到桌面。路径和格式通过环境变量传给 PowerShell，不拼接进脚本，避免注入
      const jpg = String(args.format || '').toLowerCase() === 'jpg';
      let file = String(args.path || '').trim();
      if (!file) {
        const name = `pet-screenshot-${Date.now()}.${jpg ? 'jpg' : 'png'}`;
        file = path.join(os.homedir(), 'Desktop', name);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // JPEG 给远程看屏幕用：1080p PNG 常有 2MB，JPEG 只要两三百 KB，手机加载快得多
      const fmt = jpg ? 'Jpeg' : 'Png';
      const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($env:PET_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::${fmt})
$g.Dispose(); $bmp.Dispose()
`;
      await runPowerShell(script, 15000, { PET_SHOT_PATH: file });
      return { ok: true, message: `截图已保存：${file}`, data: file };
    }

    default:
      throw new Error(`不认识的操作：${action}`);
  }
}

/* ------------------------------ 状态采集 ------------------------------ */

// CPU 占用只能靠两次采样求差，第一次必然没数，返回 null 让调用方自己处理
let cpuPrev = null;
function cpuPercent() {
  const now = Date.now();
  // 两次采样挨得太近（<300ms）算出来的数会离谱（实测直接跳 100），
  // 预热紧接着上报时就会踩到，这时直接复上次结果
  if (cpuPrev && now - cpuPrev.at < 300) return cpuPrev.pct;
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  if (!cpuPrev) {
    cpuPrev = { idle, total, at: now, pct: null };
    return null;
  }
  const di = idle - cpuPrev.idle;
  const dt = total - cpuPrev.total;
  cpuPrev = {
    idle,
    total,
    at: now,
    pct: dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : 0
  };
  return cpuPrev.pct;
}

// 电量走 WMI，不用 .NET 的 PowerStatus：这台 Dell 上 BatteryLifePercent 恒报 1，
// WMI 的 EstimatedChargeRemaining 才是真值（实测 100，和任务管理器一致）。
// 一次 PowerShell 要 1.2~1.8s，所以缓存 60 秒——手机每 2.5 秒要一次状态，不缓存会把这台机拖住
let powerCache = { at: 0, val: { battery: null, onAC: null } };
async function powerInfo(force) {
  if (!force && Date.now() - powerCache.at < 60000) return powerCache.val;
  try {
    // 插电状态用 .NET 的 PowerLineStatus（这个准），电量用 WMI，合成一次调用
    const out = await runPowerShell(
      `Add-Type -AssemblyName System.Windows.Forms
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$charge = if ($b) { [int]$b.EstimatedChargeRemaining } else { -1 }
$line = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus
Write-Output ("{0}|{1}" -f $charge, $line)`,
      12000
    );
    const [pct, line] = out.trim().split('|');
    const n = Number(pct);
    powerCache = {
      at: Date.now(),
      // -1 = 没有电池（台式机）；越界的值当未知，别显示成 255%
      val: { battery: n >= 0 && n <= 100 ? n : null, onAC: /Online/i.test(line || '') }
    };
  } catch (e) {
    powerCache = { at: Date.now(), val: { battery: null, onAC: null } };
  }
  return powerCache.val;
}

/** 手机端状态卡用的快照 */
async function sysinfo() {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const info = {
    host: os.hostname(),
    uptime: Math.round(os.uptime()),
    cpu: cpuPercent(),
    memTotal: +(memTotal / 1073741824).toFixed(1),
    memUsed: +((memTotal - memFree) / 1073741824).toFixed(1),
    ts: Date.now()
  };
  const p = await powerInfo();
  info.battery = p.battery;
  info.onAC = p.onAC;
  return info;
}

module.exports = { run, nowText, sysinfo };
