'use strict';

const { globalShortcut } = require('electron');
const config = require('../core/config');
const windows = require('./windows');

const registered = [];

function registerShortcuts() {
  const accel = config.get('shortcuts.toggle', 'Control+Shift+Space');
  try {
    const ok = globalShortcut.register(accel, () => windows.toggleBubble());
    if (!ok) console.warn(`[shortcut] 快捷键 ${accel} 被占用，注册失败`);
    else registered.push(accel);
  } catch (err) {
    console.warn('[shortcut] 注册失败：', err.message);
  }

  // 备用：Ctrl+Shift+P 直接打开网易云
  try {
    globalShortcut.register('Control+Shift+P', () => {
      require('../main/main').runQuick('打开网易云音乐');
    });
  } catch {}
}

function unregisterShortcuts() {
  globalShortcut.unregisterAll();
  registered.length = 0;
}

module.exports = { registerShortcuts, unregisterShortcuts };
