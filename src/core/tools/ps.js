'use strict';

const { spawn } = require('child_process');

/**
 * 用 -EncodedCommand（UTF-16LE base64）调用 PowerShell，
 * 彻底绕开引号/中文/换行的转义地狱。
 */
function runPowerShell(script, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    );

    let stdout = '';
    let stderr = '';
    ps.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    ps.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    const timer = setTimeout(() => {
      try {
        ps.kill();
      } catch {}
      reject(new Error('PowerShell 执行超时'));
    }, timeout);

    ps.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `PowerShell 退出码 ${code}`));
    });
  });
}

const KEY_EVENT_PRELUDE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NativeKey {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public static void Tap(byte vk, int times) {
        for (int i = 0; i < times; i++) {
            keybd_event(vk, 0, 0, UIntPtr.Zero);
            keybd_event(vk, 0, 2, UIntPtr.Zero);
            System.Threading.Thread.Sleep(30);
        }
    }
}
'@
`;

/** 发送 Windows 虚拟键，times 为重复次数 */
async function tapVirtualKey(vk, times = 1) {
  await runPowerShell(`${KEY_EVENT_PRELUDE}\n[NativeKey]::Tap(${vk}, ${times})`);
}

module.exports = { runPowerShell, tapVirtualKey, KEY_EVENT_PRELUDE };
