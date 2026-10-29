'use strict';

/**
 * 静默启动外部程序（不弹黑窗、且与桌宠脱钩）。
 *
 * 三个必须同时满足的约束：
 *   ① 不弹控制台黑窗 —— 控制台程序用 WMI 直启会分配可见控制台，用户明确不要；
 *   ② 与桌宠脱钩 —— 直接 spawn 的子进程挂在 Electron 进程树/job 里，桌宠重启就被收走；
 *   ③ powershell 退出后继续活 —— ShellExecute 方式创建的进程不挂在 powershell 名下。
 *
 * ProcessStartInfo + UseShellExecute=true + WindowStyle=Hidden 正好全满足。
 * 实测：桌宠重启、powershell 退出都不影响被拉起的进程。
 */

const { execFile } = require('child_process');
const debug = require('../core/debug');

const dbg = debug.dbg;

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * @param {string} exe  可执行文件绝对路径
 * @param {string[]} args 参数（没有传 []）
 * @param {string} cwd  工作目录（很多客户端依赖 cwd 找同目录 dll/资源）
 * @param {string} label 日志前缀，如 'napcat'
 * @returns {Promise<number|null>} pid 或 null
 */
function startHidden(exe, args = [], cwd = null, label = 'launch') {
  return new Promise((resolve) => {
    const ps =
      `$si = New-Object System.Diagnostics.ProcessStartInfo; ` +
      `$si.FileName = ${psQuote(exe)}; ` +
      `$si.Arguments = ${psQuote(args.join(' '))}; ` +
      (cwd ? `$si.WorkingDirectory = ${psQuote(cwd)}; ` : '') +
      `$si.UseShellExecute = $true; ` +
      `$si.WindowStyle = 'Hidden'; ` +
      `$p = [System.Diagnostics.Process]::Start($si); ` +
      `Write-Output $p.Id`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          dbg(`[${label}] 静默启动失败：`, err.message.split('\n')[0]);
          return resolve(null);
        }
        const pid = parseInt(String(stdout).trim(), 10);
        if (!Number.isFinite(pid)) {
          dbg(`[${label}] 静默启动返回异常：`, String(stdout).trim().slice(0, 60));
          return resolve(null);
        }
        dbg(`[${label}] 静默创建成功（无控制台）pid =`, pid);
        resolve(pid);
      }
    );
  });
}

module.exports = { startHidden, psQuote };
