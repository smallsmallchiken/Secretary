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
      // 全屏截图存到桌面。路径通过环境变量传给 PowerShell，不拼接进脚本，避免注入
      let file = String(args.path || '').trim();
      if (!file) file = path.join(os.homedir(), 'Desktop', `pet-screenshot-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($env:PET_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;
      await runPowerShell(script, 15000, { PET_SHOT_PATH: file });
      return { ok: true, message: `截图已保存：${file}`, data: file };
    }

    default:
      throw new Error(`不认识的操作：${action}`);
  }
}

module.exports = { run, nowText };
