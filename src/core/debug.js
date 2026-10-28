'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

// 日志只追加不清理会一直变大，超过这个大小就轮转一代（旧的留成 debug.log.1，只留一代）
const MAX_LOG_BYTES = 1024 * 1024;

function shouldRotate(size) {
  return Number.isFinite(size) && size > MAX_LOG_BYTES;
}

/** Windows 上 Electron 主进程的 console 不连控制台，调试信息落盘更方便 */
function dbg(...args) {
  const line = `${new Date().toISOString()} ${args
    .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ')}\n`;
  try {
    const base = dataDir();
    const file = path.join(base, 'debug.log');
    try {
      if (shouldRotate(fs.statSync(file).size)) fs.renameSync(file, `${file}.1`);
    } catch {
      /* 文件还不存在、或改名失败，都不影响继续写日志 */
    }
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    /* 调试日志失败不影响主流程 */
  }
}

module.exports = { dbg, shouldRotate };
