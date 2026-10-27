'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { runPowerShell } = require('./ps');

/**
 * 应用启动器。
 * 查找优先级：注册表 App Paths -> 已知安装路径 -> 开始菜单快捷方式 -> 直接执行 -> 当作 URL 打开
 */

// 常见中文软件预设。paths 是兜底的常见安装位置。
const PRESETS = {
  '网易云音乐': {
    exe: 'cloudmusic.exe',
    protocol: 'orpheus://',
    web: 'https://music.163.com',
    paths: [
      '%ProgramFiles(x86)%\\Netease\\CloudMusic\\cloudmusic.exe',
      '%ProgramFiles%\\Netease\\CloudMusic\\cloudmusic.exe',
      '%ProgramFiles(x86)%\\NetEase\\CloudMusic\\cloudmusic.exe',
      '%LocalAppData%\\Netease\\CloudMusic\\cloudmusic.exe',
      '%LocalAppData%\\Programs\\Netease\\CloudMusic\\cloudmusic.exe',
      'D:\\Program Files (x86)\\Netease\\CloudMusic\\cloudmusic.exe',
      'D:\\Netease\\CloudMusic\\cloudmusic.exe',
      'D:\\software\\Netease\\CloudMusic\\cloudmusic.exe'
    ]
  },
  '微信': {
    exe: 'WeChat.exe',
    paths: [
      '%ProgramFiles(x86)%\\Tencent\\WeChat\\WeChat.exe',
      '%ProgramFiles%\\Tencent\\WeChat\\WeChat.exe',
      '%ProgramFiles(x86)%\\Tencent\\Weixin\\Weixin.exe'
    ]
  },
  '企业微信': {
    exe: 'WXWork.exe',
    paths: ['%ProgramFiles(x86)%\\WXWork\\WXWork.exe', '%ProgramFiles%\\WXWork\\WXWork.exe']
  },
  'QQ': {
    exe: 'QQ.exe',
    paths: ['%ProgramFiles(x86)%\\Tencent\\QQNT\\QQ.exe', '%ProgramFiles%\\Tencent\\QQNT\\QQ.exe']
  },
  '钉钉': {
    exe: 'DingTalk.exe',
    paths: ['%LocalAppData%\\DingTalk\\main\\current\\DingTalk.exe']
  },
  '飞书': {
    exe: 'Feishu.exe',
    paths: ['%LocalAppData%\\Feishu\\Feishu.exe', '%LocalAppData%\\ByteDance\\Feishu\\Feishu.exe']
  },
  'Chrome': {
    exe: 'chrome.exe',
    paths: [
      '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe'
    ]
  },
  'Edge': {
    exe: 'msedge.exe',
    paths: [
      '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe'
    ]
  },
  '记事本': { exe: 'notepad.exe' },
  '计算器': { exe: 'calc.exe' },
  '画图': { exe: 'mspaint.exe' },
  '任务管理器': { exe: 'Taskmgr.exe' },
  '命令提示符': { exe: 'cmd.exe' },
  '终端': { exe: 'wt.exe', paths: ['%LocalAppData%\\Microsoft\\WindowsApps\\wt.exe'] },
  'PowerShell': { exe: 'powershell.exe' },
  '资源管理器': { exe: 'explorer.exe' },
  'VS Code': {
    exe: 'Code.exe',
    paths: [
      '%LocalAppData%\\Programs\\Microsoft VS Code\\Code.exe',
      '%ProgramFiles%\\Microsoft VS Code\\Code.exe'
    ]
  },
  '系统设置': { exe: null, protocol: 'ms-settings:' },
  '控制面板': { exe: 'control.exe' }
};

// 口语别名 -> 预设名
const ALIASES = {
  '网易云': '网易云音乐',
  '云音乐': '网易云音乐',
  '网易云音乐': '网易云音乐',
  'neteasemusic': '网易云音乐',
  'cloudmusic': '网易云音乐',
  '听歌软件': '网易云音乐',
  'w x': '微信',
  'wechat': '微信',
  'qq': 'QQ',
  '浏览器': 'Chrome',
  '谷歌浏览器': 'Chrome',
  'chrome': 'Chrome',
  'edge': 'Edge',
  'vscode': 'VS Code',
  'code': 'VS Code',
  '代码': 'VS Code',
  '计算器': '计算器',
  'notepad': '记事本',
  '写字板': '记事本',
  'cmd': '命令提示符',
  '控制台': '命令提示符',
  '资源管理器': '资源管理器',
  '文件管理器': '资源管理器',
  '我的电脑': '资源管理器',
  '设置': '系统设置'
};

function expandEnv(p) {
  return p.replace(/%([^%]+)%/g, (m, name) => {
    const v = process.env[name];
    return v === undefined ? m : v;
  });
}

function regQueryDefault(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // 输出形如：    (默认)    REG_SZ    C:\path\to\app.exe
      const m = stdout.match(/REG_SZ\s+(.+?)\s*$/m);
      resolve(m ? m[1].trim().replace(/^"|"$/g, '') : null);
    });
  });
}

/** reg.exe 不可用时的兜底（有些环境会把它列进安全黑名单） */
async function psQueryDefault(key) {
  const psPath = key.replace(/^HKCU\\/, 'HKCU:\\').replace(/^HKLM\\/, 'HKLM:\\');
  try {
    const out = await runPowerShell(
      `try { (Get-ItemProperty -Path '${psPath}' -ErrorAction Stop).'(default)' } catch { '' }`,
      8000
    );
    const p = String(out || '').trim();
    return p || null;
  } catch {
    return null;
  }
}

async function findByRegistry(exe) {
  if (!exe) return null;
  const keys = [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`
  ];
  for (const k of keys) {
    let p = await regQueryDefault(k);
    if (!p) p = await psQueryDefault(k);
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function findByPaths(list) {
  if (!list) return null;
  for (const raw of list) {
    const p = expandEnv(raw);
    if (p.includes('%')) continue; // 环境变量没展开成功，跳过
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const startMenuDirs = [
  path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
  path.join(process.env.APPDATA || '', 'Microsoft\\Windows\\Start Menu\\Programs')
];

/**
 * 从开机自启项里反查可执行文件路径。
 * 网易云、微信这类客户端通常自己会注册自启，这是绕过非标准安装目录的好线索
 * （比如装在 D:\software\restore-app\... 这种地方，靠常见路径根本猜不到）。
 */
async function findByRunKey(exeName) {
  if (!exeName) return null;
  const script = [
    "$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue",
    "if ($p) {",
    `  ($p.PSObject.Properties | Where-Object { $_.Value -like '*${exeName}*' } | Select-Object -First 1).Value`,
    '}'
  ].join('\n');
  try {
    const out = await runPowerShell(script, 10000);
    if (!out) return null;
    const m = out.match(/"([^"]+\.exe)"|([A-Za-z]:\\[^\s"]+\.exe)/i);
    const p = m ? m[1] || m[2] : null;
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function findByStartMenu(name) {
  // 在开始菜单里找名字匹配的 .lnk（浅层扫描，避免太慢）
  const stack = startMenuDirs.filter((d) => d && fs.existsSync(d));
  let depth = 0;
  while (stack.length && depth < 3) {
    const dir = stack.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.lnk')) continue;
      const base = e.name.slice(0, -4).toLowerCase();
      if (base === name.toLowerCase() || base.includes(name.toLowerCase())) {
        return full;
      }
    }
    depth += 1;
  }
  return null;
}

/**
 * 启动一个可执行文件。
 *
 * 注意：spawn 失败（EPERM / ENOENT）不会同步抛错，而是异步 emit 'error'。
 * 不监听的话会变成未捕获异常，直接把主进程搞崩——所以这里包成 Promise，
 * 并给一个很短的窗口来捕捉"立刻失败"的情况。
 */
function launch(target) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(target, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    }, 200);
  });
}

async function openApp(rawName, extraAliases = {}) {
  const name = String(rawName || '').trim();
  if (!name) throw new Error('没有指定要打开的程序');

  const lower = name.toLowerCase();

  // 0) 用户在 appAliases 里写死的路径，优先级最高（装在奇怪目录时的终极兜底）
  const customPath = extraAliases[name] || extraAliases[lower];
  if (customPath && typeof customPath === 'string' && fs.existsSync(customPath)) {
    try {
      await launch(customPath);
      return { ok: true, message: `已打开${name}`, detail: customPath };
    } catch (err) {
      throw new Error(`找到 ${customPath}，但启动失败：${err.message}`);
    }
  }

  const presetKey =
    ALIASES[lower] ||
    ALIASES[name] ||
    (PRESETS[name] ? name : null);

  // 1) 已经有预设
  if (presetKey && PRESETS[presetKey]) {
    const preset = PRESETS[presetKey];
    let exePath = findByPaths(preset.paths);
    if (!exePath) exePath = await findByRegistry(preset.exe);
    // 装在非标准目录时（例如 D:\software\restore-app\...），靠自启项反查
    if (!exePath) exePath = await findByRunKey(preset.exe);
    if (!exePath && preset.exe) {
      // 系统自带命令（notepad.exe 之类）直接交给 shell
      const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', preset.exe);
      if (fs.existsSync(sys)) exePath = sys;
    }
    if (exePath) {
      await launch(exePath);
      return { ok: true, message: `已打开${presetKey}`, detail: exePath };
    }

    // 客户端没装：协议唤起 -> 网页版，依次降级
    if (preset.protocol) {
      try {
        await shell.openExternal(preset.protocol);
        return { ok: true, message: `已打开${presetKey}` };
      } catch {
        /* 协议没注册，继续往下 */
      }
    }
    if (preset.web) {
      await shell.openExternal(preset.web);
      return { ok: true, message: `没找到${presetKey}客户端，已经帮你打开网页版` };
    }
    // 预设没找到实体文件，继续走下面的通用查找
  }

  // 2) 绝对路径
  if (fs.existsSync(name)) {
    const stat = fs.statSync(name);
    if (stat.isDirectory()) {
      await shell.openPath(name);
      return { ok: true, message: '已打开文件夹', detail: name };
    }
    await launch(name);
    return { ok: true, message: '已启动程序', detail: name };
  }

  // 3) URL
  if (/^(https?:\/\/|www\.)/i.test(name)) {
    await shell.openExternal(/^www\./i.test(name) ? `https://${name}` : name);
    return { ok: true, message: '已在浏览器打开' };
  }

  // 4) 注册表按 exe 名查
  const guessExe = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;
  const fromReg = await findByRegistry(guessExe);
  if (fromReg) {
    await launch(fromReg);
    return { ok: true, message: `已打开${name}`, detail: fromReg };
  }

  // 4.5) 自启项反查
  const fromRun = await findByRunKey(guessExe);
  if (fromRun) {
    await launch(fromRun);
    return { ok: true, message: `已打开${name}`, detail: fromRun };
  }

  // 5) 开始菜单
  const lnk = findByStartMenu(name);
  if (lnk) {
    await launch(lnk);
    return { ok: true, message: `已打开${name}`, detail: lnk };
  }

  // 6) 交给系统 shell 试试
  try {
    await shell.openExternal(name);
    return { ok: true, message: `已交给系统处理：${name}` };
  } catch {
    throw new Error(`找不到「${name}」，可以把它的安装路径告诉我，或直接说完整路径`);
  }
}

module.exports = { openApp, PRESETS, ALIASES, findByPaths, findByRegistry, expandEnv };
