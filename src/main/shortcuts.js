'use strict';

const { globalShortcut } = require('electron');

const config = require('../core/config');
const windows = require('./windows');
const { dbg } = require('../core/debug');

/**
 * 全局快捷键。
 *   Alt+W  和桌宠对话（打开气泡面板）
 *   Alt+Q  显示 / 隐藏桌宠（进程常驻，不退出）
 *
 * 两个都可以在设置里改，配置项分别是 shortcuts.toggle / shortcuts.petToggle。
 */

const registered = [];

function bind(accel, handler, tag) {
  if (!accel) return false;
  try {
    const ok = globalShortcut.register(accel, handler);
    if (!ok) {
      dbg(`[shortcut] ${tag} ${accel} 被其他程序占用，注册失败`);
      return false;
    }
    registered.push(accel);
    dbg(`[shortcut] ${tag} -> ${accel}`);
    return true;
  } catch (err) {
    dbg(`[shortcut] ${tag} ${accel} 注册异常：${err.message}`);
    return false;
  }
}

function registerShortcuts() {
  const chatAccel = config.get('shortcuts.toggle', 'Alt+W');
  const petAccel = config.get('shortcuts.petToggle', 'Alt+Q');

  bind(chatAccel, () => windows.showBubble(), '对话');

  bind(
    petAccel,
    () => {
      windows.togglePet();
    },
    '显隐桌宠'
  );

  // 兼容旧习惯：Ctrl+Shift+Space 也能唤出对话
  if (chatAccel !== 'Control+Shift+Space') {
    bind('Control+Shift+Space', () => windows.showBubble(), '对话(备用)');
  }

  // 缩放：Alt+↑ 放大，Alt+↓ 缩小
  const upAccel = config.get('shortcuts.scaleUp', 'Alt+Up');
  const downAccel = config.get('shortcuts.scaleDown', 'Alt+Down');
  const STEP = 1.12;

  bind(
    upAccel,
    () => {
      const res = windows.stepPetScale(STEP);
      if (!res.changed) dbg(`[scale] 已经是最大 ${res.scale}`);
    },
    '放大桌宠'
  );

  bind(
    downAccel,
    () => {
      const res = windows.stepPetScale(1 / STEP);
      if (!res.changed) dbg(`[scale] 已经是最小 ${res.scale}`);
    },
    '缩小桌宠'
  );

  // 老功能的快捷入口
  bind(
    'Control+Shift+P',
    () => {
      require('../main/main').runQuick('打开网易云音乐');
    },
    '网易云'
  );
}

function unregisterShortcuts() {
  globalShortcut.unregisterAll();
  registered.length = 0;
}

module.exports = { registerShortcuts, unregisterShortcuts };
