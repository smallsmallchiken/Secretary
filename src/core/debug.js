'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** Windows 上 Electron 主进程的 console 不连控制台，调试信息落盘更方便 */
function dbg(...args) {
  const line = `${new Date().toISOString()} ${args
    .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ')}\n`;
  try {
    const base = app.isPackaged ? app.getPath('userData') : path.join(app.getAppPath(), '.data');
    fs.mkdirSync(base, { recursive: true });
    fs.appendFileSync(path.join(base, 'debug.log'), line, 'utf8');
  } catch {
    /* 调试日志失败不影响主流程 */
  }
}

module.exports = { dbg };
