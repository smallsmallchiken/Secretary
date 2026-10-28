'use strict';

const path = require('path');
const { app, ipcMain, shell, screen } = require('electron');

const config = require('../core/config');
const agent = require('../core/agent');
const reminder = require('../core/tools/reminder');
const qqbot = require('../core/qq/bot');
const wxbot = require('../core/wechat/bot');
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

// 子进程（GPU/网络服务/渲染进程）异常退出都记一笔——之前主进程静默死亡，
// stderr 只留下 "Network service crashed"，需要能定位是哪个进程带的
app.on('child-process-gone', (_e, details) => {
  dbg('[proc]', details.type, 'reason=', details.reason, 'exitCode=', details.exitCode);
});
app.on('render-process-gone', (_e, _win, details) => {
  dbg('[proc] renderer reason=', details.reason, 'exitCode=', details.exitCode);
});
// 主动退出（托盘退出/单实例冲突）会走这里，留下日志可区分「主动退」和「崩」
app.on('before-quit', () => {
  dbg('[quit] before-quit 触发, quitting=', global.__quitting === true);
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
    // 走 movePet：setPosition 在非 100% 缩放下会让桌宠越拖越大
    windows.movePet(
      dragState.bounds.x + (c.x - dragState.cursor.x),
      dragState.bounds.y + (c.y - dragState.cursor.y)
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
    // 菜单是同步渲染的，只能用缓存；顺手刷一下，下次打开就是准的
    wxbot.refresh().catch(() => {});
    windows.showContextMenu(buildMenuItems());
  });

  // 对话框上右键 → 同一个菜单（里面能进设置、隐藏桌宠、退出）
  ipcMain.on('bubble:context-menu', () => {
    wxbot.refresh().catch(() => {});
    windows.pinBubble(20000); // 菜单弹出期间别把气泡收了
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

  ipcMain.handle('bubble:resize', (_e, height) => windows.resizeBubbleChat(height));

  ipcMain.handle('bubble:mode', (_e, mode) => windows.setBubbleMode(mode));

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
        windows.movePet(pos.x, pos.y);
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
  const wanderOn = config.get('behavior.allowWander', true) !== false;
  const qqSt = qqbot.status();
  const wxSt = wxbot.status();

  return [
    { id: 'wander_toggle', label: '自己漫步', hint: wanderOn ? '开' : '关' },
    { id: 'walk', label: '自己溜达一圈' },
    { sep: true },
    {
      id: 'qq_toggle',
      label: 'QQ 自动回复',
      hint: qqSt.running ? `值守中(${qqSt.whitelistCount}人)` : qqSt.enabled ? '已启用(未连上)' : '关',
      danger: qqSt.running
    },
    {
      id: 'wx_toggle',
      label: '微信自动回复',
      hint: !wxSt.available ? '未配置' : wxSt.running ? '值守中' : '关',
      danger: wxSt.running
    },
    { sep: true },
    { id: 'chat', label: '说点什么…', hint: 'Alt+W' },
    { id: 'settings', label: '设置' },
    { sep: true },
    { id: 'quit', label: '退出', danger: true }
  ];
}

function runMenuAction(id) {
  switch (id) {
    case 'wander_toggle': {
      const now = config.get('behavior.allowWander', true) !== false;
      const next = !now;
      const cfg = config.set({ behavior: { allowWander: next } });
      windows.sendToPet('pet:config', cfg);
      wander.refresh();
      dbg('[wander] 菜单切换为', next ? '允许漫步' : '禁止漫步');
      break;
    }
    case 'walk':
      wander.nudge();
      break;
    case 'qq_toggle':
      qqbot
        .toggle()
        .then((st) => {
          dbg('[qq] 菜单切换后状态:', JSON.stringify(st));
          if (!st.running && !st.enabled) {
            windows.showBubble();
            windows.sendToBubble('bubble:push', {
              role: 'assistant',
              text: 'QQ 自动回复没开起来：白名单还是空的。把要替你回的人加进 .data/config.json 的 qq.whitelist（QQ 号和备注），再开一次。'
            });
          }
        })
        .catch((err) => dbg('[qq] 切换失败:', err.message));
      break;
    case 'wx_toggle':
      wxbot
        .toggle()
        .then((st) => {
          dbg('[wx] 菜单切换后状态:', JSON.stringify(st));
          if (!st.available) {
            windows.showBubble();
            windows.sendToBubble('bubble:push', {
              role: 'assistant',
              text: '微信自动回复需要 wechat-bot/py312 那个 Python 环境，现在找不到。'
            });
          }
        })
        .catch((err) => dbg('[wx] 切换失败:', err.message));
      break;
    case 'chat':
      windows.toggleBubble();
      break;
    case 'settings':
      // 点开设置后别让面板因为失焦立刻收起，否则用户还没看清就没了
      windows.showBubble(20000);
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
    qqbot.shutdown();
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

  // QQ 自动回复：上次开着就恢复，收发结果通过气泡播报
  qqbot.init((text) => {
    windows.showBubble();
    windows.sendToBubble('bubble:push', { role: 'assistant', text, data: { kind: 'qq' } });
  });

  // 微信自动回复：跑在独立的 python 进程里，这里只负责开关和状态跟踪。
  // 退出桌宠**不**顺手杀掉它 —— 它是独立值守的服务，说停才停（右键菜单里能停）。
  wxbot.setNotifier((text) => {
    windows.showBubble();
    windows.sendToBubble('bubble:push', { role: 'assistant', text, data: { kind: 'wx' } });
  });
  wxbot
    .refresh(true)
    .then((st) => dbg('[wx] 初始状态:', JSON.stringify(st)))
    .catch((err) => dbg('[wx] 初始状态失败:', err.message));
  // 右键菜单要同步返回，只能用缓存，所以后台每 5 秒刷一次
  const wxTimer = setInterval(() => wxbot.refresh().catch(() => {}), 5000);
  if (wxTimer.unref) wxTimer.unref();

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

  // 存活心跳：进程若是静默死亡，至少能从日志推断死亡时间
  setInterval(() => dbg('[alive] 还活着'), 5 * 60 * 1000);

  // 调试用：--settings 启动直接打开设置面板，--chat 直接打开对话
  if (process.argv.includes('--settings') || process.argv.includes('--chat')) {
    setTimeout(() => {
      windows.showBubble(20000);
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
