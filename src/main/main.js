'use strict';

const path = require('path');
const { app, ipcMain, shell, screen } = require('electron');

const config = require('../core/config');
const agent = require('../core/agent');
const reminder = require('../core/tools/reminder');
const windows = require('./windows');
const wander = require('./wander');
const { createTray, refreshTray } = require('./tray');
const { registerShortcuts, unregisterShortcuts } = require('./shortcuts');
const { dbg } = require('../core/debug');

// 兜住未捕获异常，否则主进程会静默退出，什么线索都不留
process.on('uncaughtException', (err) => {
  dbg('[fatal] 未捕获异常：', (err && err.stack) || String(err));
});
process.on('unhandledRejection', (reason) => {
  dbg('[fatal] 未处理的 Promise 拒绝：', String((reason && reason.stack) || reason));
});

// 透明窗口 + canvas 2D 用不着 GPU，关掉硬件加速能避开不少显卡驱动的坑
app.disableHardwareAcceleration();

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = windows.getPetWindow();
    if (win) {
      win.show();
      windows.showBubble();
    }
  });
}

// 单实例

let dragState = null;

/* ------------------------------------------------------------------ */
/* 开机自启                                                            */
/* ------------------------------------------------------------------ */

/**
 * 注册 / 取消开机自启。
 *
 * 关键：未打包运行时 process.execPath 是 electron.exe，光设 openAtLogin 会注册成
 * 「开机启动 electron.exe 但不带项目路径」，拉起的是个空 Electron 进程。
 * 所以必须把项目路径塞进 args。打包后 execPath 就是 app 自己的 exe，不需要参数。
 */
function applyAutoLaunch(enabled) {
  const on = !!enabled;
  const opts = { openAtLogin: on };
  if (!app.isPackaged) {
    opts.path = process.execPath;
    // 必须把项目路径和这套渲染参数一起带上：
    // 少了 --disable-gpu 那组，开机启动时 GPU 进程会崩（本机实测）。
    opts.args = [
      app.getAppPath(),
      '--no-sandbox',
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer'
    ];
  }
  try {
    app.setLoginItemSettings(opts);
    dbg(
      '[autolaunch]', on ? '已开启' : '已关闭',
      '| path=', opts.path || '(打包后的 exe)',
      '| args=', JSON.stringify(opts.args || [])
    );
    // 回读确认，Windows 上写注册表失败是静默的
    const actual = app.getLoginItemSettings(opts).openAtLogin;
    dbg('[autolaunch] 回读 openAtLogin =', actual);
    return { ok: true, enabled: actual };
  } catch (err) {
    dbg('[autolaunch] 失败：', err.message);
    return { ok: false, message: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* 核心消息处理                                                        */
/* ------------------------------------------------------------------ */

async function handleUserMessage(text) {
  windows.sendToPet('pet:state', { state: 'think' });
  let res;
  try {
    res = await agent.handle(text);
  } catch (err) {
    res = { type: 'error', message: err.message || '出错了' };
  }

  const mood = res.type === 'error' ? 'sad' : 'happy';
  windows.sendToPet('pet:state', { state: mood });
  setTimeout(() => windows.sendToPet('pet:state', { state: 'idle' }), 2600);

  return res;
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  // 宠物交互
  ipcMain.on('pet:click', () => windows.toggleBubble());

  ipcMain.on('pet:drag-start', () => {
    const win = windows.getPetWindow();
    if (!win) return;
    wander.hold(3000);
    global.__dragging = true;
    dragState = { bounds: win.getBounds(), cursor: screen.getCursorScreenPoint() };
  });

  ipcMain.on('pet:drag-move', () => {
    const win = windows.getPetWindow();
    if (!win || !dragState) return;
    const c = screen.getCursorScreenPoint();
    win.setPosition(
      Math.round(dragState.bounds.x + (c.x - dragState.cursor.x)),
      Math.round(dragState.bounds.y + (c.y - dragState.cursor.y))
    );
    windows.positionBubble();
  });

  ipcMain.on('pet:drag-end', () => {
    global.__dragging = false;
    dragState = null;
    // 刚放下别立刻自己溜达，给用户一个"它就待在这"的确认感
    wander.hold(10000);
  });

  ipcMain.on('pet:context-menu', () => {
    windows.showContextMenu(buildMenuItems());
  });

  // 自绘菜单的回调
  ipcMain.on('menu:pick', (_e, id) => {
    windows.hideContextMenu();
    runMenuAction(id);
  });

  ipcMain.on('menu:close', () => windows.hideContextMenu());

  ipcMain.on('menu:resize', (_e, size) => windows.resizeContextMenu(size));

  // 气泡对话
  ipcMain.handle('bubble:send', async (_e, text) => {
    // 请求期间别让面板因为失焦消失，否则用户看不到回复
    windows.pinBubble(40000);
    try {
      return await handleUserMessage(text);
    } finally {
      windows.pinBubble(10000);
    }
  });

  ipcMain.handle('bubble:hide', (_e, force = false) => {
    // 主动推送（比如提醒）的保护期内，忽略自动请求；用户点关闭时 force=true
    if (!force && windows.isPinned()) {
      dbg('[ipc] bubble:hide 被保护期拦截');
      return false;
    }
    windows.hideBubble();
    return true;
  });

  ipcMain.handle('bubble:open-external', async (_e, url) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
    return true;
  });

  // 配置
  ipcMain.handle('config:get', () => config.getAll());

  ipcMain.handle('config:set', (_e, patch) => {
    const next = config.set(patch);
    if (patch && patch.shortcuts) {
      unregisterShortcuts();
      registerShortcuts();
    }
    if (patch && patch.autoLaunch !== undefined) {
      applyAutoLaunch(patch.autoLaunch);
    }
    if (patch && patch.pet) {
      const win = windows.getPetWindow();
      if (win) {
        const pos = windows.dockPosition(win);
        win.setPosition(pos.x, pos.y);
      }
      windows.sendToPet('pet:config', next.pet);
    }
    if (patch && patch.behavior) {
      wander.refresh();
      windows.sendToPet('pet:config', next);
    }
    refreshTray();
    return next;
  });

  ipcMain.handle('config:path', () => {
    const base = app.isPackaged ? app.getPath('userData') : path.join(app.getAppPath(), '.data');
    return path.join(base, 'config.json');
  });

  ipcMain.handle('reminder:list', () => reminder.list());

  ipcMain.handle('reminder:cancel', (_e, id) => {
    try {
      return reminder.cancel(id);
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('app:quit', () => quitApp());

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    llmReady: agent.llmReady()
  }));
}

/* ------------------------------------------------------------------ */
/* 右键菜单（自绘透明菜单）                                             */
/* ------------------------------------------------------------------ */

function buildMenuItems() {
  return [
    { id: 'chat', label: '说点什么…', hint: 'Alt+W' },
    { sep: true },
    { id: 'walk', label: '走两步' },
    { id: 'settings', label: '设置' },
    { sep: true },
    { id: 'quit', label: '退出', danger: true }
  ];
}

function runMenuAction(id) {
  switch (id) {
    case 'chat':
      windows.showBubble();
      break;
    case 'walk':
      wander.nudge();
      break;
    case 'settings':
      windows.showBubble();
      setTimeout(() => windows.sendToBubble('bubble:open-settings'), 120);
      break;
    case 'quit':
      quitApp();
      break;
    default:
      break;
  }
}

function runQuick(text) {
  handleUserMessage(text).then((res) => {
    windows.showBubble();
    windows.sendToBubble('bubble:push', { role: 'user', text });
    windows.sendToBubble('bubble:push', {
      role: res.type === 'error' ? 'error' : 'assistant',
      text: res.message,
      data: res.data || null
    });
  });
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

function quitApp() {
  global.__quitting = true;
  try {
    wander.stop();
  } catch {
    /* ignore */
  }
  unregisterShortcuts();
  app.quit();
}

app.whenReady().then(() => {
  dbg('=== 应用启动 ===', new Date().toISOString());
  windows.createPetWindow();
  registerIpc();
  createTray();
  registerShortcuts();
  wander.start();

  // 恢复未到期的提醒
  dbg('[reminder] init 读取到', reminder.list().length, '条待办');
  reminder.init((item) => {
    dbg('[reminder] 回调开始');
    windows.getPetWindow()?.show();
    dbg('[reminder] pet shown');
    windows.showBubble();
    // 提醒是主动推送，得留足时间让用户看到
    windows.pinBubble(60000);
    const bw = windows.getBubbleWindow();
    dbg('[reminder] bubble: exists=', !!bw, 'visible=', bw && bw.isVisible(), 'destroyed=', bw && bw.isDestroyed());
    windows.sendToBubble('bubble:push', {
      role: 'assistant',
      text: `⏰ 提醒你：${item.text}`,
      data: { kind: 'reminder' }
    });
    windows.sendToPet('pet:state', { state: 'happy' });
    setTimeout(() => windows.sendToPet('pet:state', { state: 'idle' }), 4000);
  });

  applyAutoLaunch(config.get('autoLaunch'));

  // 调试用：--settings 启动直接打开设置面板，--chat 直接打开对话
  if (process.argv.includes('--settings') || process.argv.includes('--chat')) {
    setTimeout(() => {
      windows.showBubble();
      if (process.argv.includes('--settings')) {
        setTimeout(() => windows.sendToBubble('bubble:open-settings'), 400);
      }
    }, 1200);
  }
});

app.on('window-all-closed', () => {
  // 常驻托盘，不随窗口关闭退出。
  // 注意：这个事件不传参数，别去碰 e（之前误写成 e.preventDefault() 会抛 TypeError 直接搞崩进程）。
  // Electron 只要检测到有监听器就不会自动退出，无需 preventDefault。
});

app.on('before-quit', () => {
  global.__quitting = true;
  try {
    wander.stop();
  } catch {
    /* ignore */
  }
});

app.on('will-quit', () => {
  unregisterShortcuts();
});

module.exports = { handleUserMessage, quitApp, runQuick, applyAutoLaunch };
