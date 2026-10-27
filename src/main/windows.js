'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const config = require('../core/config');

const PET_W = 180;
const PET_H = 196;
const BUBBLE_W = 400;
const BUBBLE_H = 560;

// 尺寸换算基准：scale=0.85 时窗口正好 180x196
const SCALE_BASE = 0.85;
const SCALE_MIN = 0.45;
const SCALE_MAX = 2.0;

let petWin = null;
let bubbleWin = null;
let blurTimer = null;
// 面板刚弹出/刚推送消息时，给它一个"免失焦关闭"的保护期，
// 否则窗口激活过程中的瞬时失焦会把面板闪没。
let pinUntil = 0;
// 气泡窗口是懒创建的，页面没加载完就 send 会丢消息，先排队
let bubbleReady = false;
let pendingToBubble = [];

function pinBubble(ms = 2500) {
  pinUntil = Date.now() + ms;
}

function isPinned() {
  return Date.now() < pinUntil;
}

function petScale() {
  const value = Number(config.get('pet.scale', SCALE_BASE));
  return Number.isFinite(value) && value > 0 ? value : SCALE_BASE;
}

/** scale -> 窗口像素尺寸（渲染器内部会等比填满窗口） */
function sizeForScale(scale) {
  const ratio = scale / SCALE_BASE;
  return {
    width: Math.max(48, Math.round(PET_W * ratio)),
    height: Math.max(52, Math.round(PET_H * ratio))
  };
}

function preloadPath(name) {
  return path.join(__dirname, '..', 'preload', name);
}

/** 计算宠物停靠位置（右下角，跟随当前显示器工作区） */
function dockPosition(win) {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
  const wa = display.workArea;
  const marginRight = Number(config.get('pet.marginRight', 40));
  const marginBottom = Number(config.get('pet.marginBottom', 72));
  const [w, h] = win.getSize();
  return {
    x: Math.round(wa.x + wa.width - w - marginRight),
    y: Math.round(wa.y + wa.height - h - marginBottom)
  };
}

function createPetWindow() {
  const initial = sizeForScale(petScale());
  petWin = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: preloadPath('pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const pos = dockPosition(petWin);
  petWin.setPosition(pos.x, pos.y);

  petWin.loadFile(path.join(__dirname, '..', 'renderer', 'pet', 'index.html'));

  petWin.once('ready-to-show', () => {
    petWin.show();
  });

  // 关闭时隐藏到托盘，而不是退出
  petWin.on('close', (e) => {
    if (!global.__quitting) {
      e.preventDefault();
      petWin.hide();
    }
  });

  petWin.on('closed', () => {
    petWin = null;
  });

  return petWin;
}

function createBubbleWindow() {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin;

  bubbleWin = new BrowserWindow({
    width: BUBBLE_W,
    height: BUBBLE_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath('bubble-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  bubbleWin.setAlwaysOnTop(true, 'screen-saver');
  bubbleWin.loadFile(path.join(__dirname, '..', 'renderer', 'bubble', 'index.html'));

  bubbleWin.webContents.on('did-finish-load', () => {
    bubbleReady = true;
    const queue = pendingToBubble.splice(0);
    for (const [channel, payload] of queue) {
      bubbleWin.webContents.send(channel, payload);
    }
  });

  bubbleWin.on('blur', () => {
    // 点别处自动收起。多重保护：宽限期 + 焦点复查 + pin 保护
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (!bubbleWin || bubbleWin.isDestroyed() || !bubbleWin.isVisible()) return;
      if (bubbleWin.isFocused()) return;
      if (global.__dragging) return;
      if (Date.now() < pinUntil) return;
      require('../core/debug').dbg('[blur] 触发隐藏');
      hideBubble();
    }, 250);
  });

  bubbleWin.on('closed', () => {
    bubbleWin = null;
    bubbleReady = false;
  });

  return bubbleWin;
}

/** 把气泡窗口摆到宠物旁边（优先左侧，放不下就右侧） */
function positionBubble() {
  if (!bubbleWin || !petWin) return;
  const pb = petWin.getBounds();
  const display = screen.getDisplayMatching(pb);
  const wa = display.workArea;
  const gap = 12;

  let x = pb.x - BUBBLE_W - gap;
  // 左边放不下就放右边
  if (x < wa.x + 8) x = pb.x + pb.width + gap;

  // 底部与宠物底部对齐
  let y = pb.y + pb.height - BUBBLE_H;
  if (y < wa.y + 8) y = wa.y + 8;
  if (y + BUBBLE_H > wa.y + wa.height - 8) y = wa.y + wa.height - BUBBLE_H - 8;

  // 最后兜底，别跑出屏幕
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - BUBBLE_W - 8));

  bubbleWin.setPosition(Math.round(x), Math.round(y));
}

function showBubble() {
  const win = createBubbleWindow();
  pinBubble(2500);
  positionBubble();
  if (!win.isVisible()) win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.focus();
  win.moveTop();
  win.webContents.send('bubble:focus-input');
  require('../core/debug').dbg('[showBubble] 已显示，isVisible=', win.isVisible());
  // 部分场景 show() 后焦点会慢一拍，补一次
  setTimeout(() => {
    if (bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.isVisible()) bubbleWin.focus();
  }, 80);
}

function hideBubble() {
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    require('../core/debug').dbg('[hideBubble] 隐藏');
    bubbleWin.hide();
  }
}

function toggleBubble() {
  if (!bubbleWin || bubbleWin.isDestroyed() || !bubbleWin.isVisible()) showBubble();
  else hideBubble();
}

function sendToPet(channel, payload) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send(channel, payload);
}

function sendToBubble(channel, payload) {
  if (!bubbleWin || bubbleWin.isDestroyed()) {
    pendingToBubble.push([channel, payload]);
    return;
  }
  if (!bubbleReady) {
    pendingToBubble.push([channel, payload]);
    return;
  }
  bubbleWin.webContents.send(channel, payload);
}

function getPetWindow() {
  return petWin;
}
function getBubbleWindow() {
  return bubbleWin;
}

/* ------------------------------------------------------------------ */
/* 桌宠显隐（快捷键 Alt+Q 用，不退出进程）                              */
/* ------------------------------------------------------------------ */

function isPetVisible() {
  return !!(petWin && !petWin.isDestroyed() && petWin.isVisible());
}

function togglePet() {
  if (!petWin || petWin.isDestroyed()) {
    createPetWindow();
    return true;
  }
  if (petWin.isVisible()) {
    hideBubble();
    hideContextMenu();
    petWin.hide();
    return false;
  }
  // 重新出现时保持在用户上次放的位置，不强行回右下角
  petWin.show();
  petWin.moveTop();
  return true;
}

/* ------------------------------------------------------------------ */
/* 缩放（Alt+↑ 放大 / Alt+↓ 缩小）                                      */
/* ------------------------------------------------------------------ */

function applyPetScale(scale) {
  const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(scale) || SCALE_BASE));
  const win = petWin && !petWin.isDestroyed() ? petWin : null;
  if (!win) return next;

  const b = win.getBounds();
  const { width, height } = sizeForScale(next);
  if (b.width === width && b.height === height) return next;

  // 以底部中心为锚点，看起来像原地长大 / 缩小
  const centerX = b.x + b.width / 2;
  const bottom = b.y + b.height;
  let x = Math.round(centerX - width / 2);
  let y = Math.round(bottom - height);

  const wa = screen.getDisplayMatching({ x, y, width, height }).workArea;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));

  win.setBounds({ x, y, width, height });
  positionBubble();
  return next;
}

/** factor > 1 放大，< 1 缩小。返回 { scale, changed } */
function stepPetScale(factor) {
  const current = petScale();
  const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number((current * factor).toFixed(3))));
  if (Math.abs(next - current) < 0.001) {
    return { scale: current, changed: false };
  }
  config.set({ pet: { scale: next } });
  applyPetScale(next);
  return { scale: next, changed: true };
}

/* ------------------------------------------------------------------ */
/* 自绘右键菜单（原生 Menu 没法做透明，这里用透明窗口画）               */
/* ------------------------------------------------------------------ */

const MENU_W = 240;
let menuWin = null;
let menuShownAt = 0;

function estimateMenuHeight(items) {
  let h = 16 + 14; // body 外边距 8*2 + 卡片内边距 7*2
  for (const it of items) h += it.sep ? 11 : 33;
  return Math.max(64, Math.round(h));
}

function createMenuWindow() {
  if (menuWin && !menuWin.isDestroyed()) return menuWin;

  menuWin = new BrowserWindow({
    width: MENU_W,
    height: 120,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: preloadPath('menu-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  menuWin.setAlwaysOnTop(true, 'screen-saver');
  menuWin.loadFile(path.join(__dirname, '..', 'renderer', 'menu', 'index.html'));

  menuWin.on('blur', () => {
    // 刚弹出的瞬间可能还没拿到焦点，给它一点缓冲
    if (Date.now() - menuShownAt < 220) return;
    hideContextMenu();
  });

  menuWin.on('closed', () => {
    menuWin = null;
  });

  return menuWin;
}

function showContextMenu(items) {
  const win = createMenuWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
  const wa = display.workArea;

  const height = estimateMenuHeight(items);
  let x = cursor.x + 6;
  let y = cursor.y + 6;
  if (x + MENU_W > wa.x + wa.width - 8) x = cursor.x - MENU_W - 6;
  if (y + height > wa.y + wa.height - 8) y = cursor.y - height - 6;

  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - MENU_W - 8));
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - height - 8));

  win.setBounds({ x: Math.round(x), y: Math.round(y), width: MENU_W, height });

  const send = () => {
    if (!win.isDestroyed()) win.webContents.send('menu:render', items);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();

  menuShownAt = Date.now();
  if (!win.isVisible()) win.show();
  win.focus();
  win.moveTop();
}

/** 渲染器量出真实高度后回调，避免估算不准留空白 */
function resizeContextMenu(size) {
  if (!menuWin || menuWin.isDestroyed()) return;
  const b = menuWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const width = Math.max(120, Math.round(size.width || b.width));
  const height = Math.max(48, Math.round(size.height || b.height));
  let { x, y } = b;
  if (y + height > wa.y + wa.height - 8) {
    y = Math.max(wa.y + 8, wa.y + wa.height - height - 8);
  }
  menuWin.setBounds({ x, y, width, height });
}

function hideContextMenu() {
  if (menuWin && !menuWin.isDestroyed() && menuWin.isVisible()) menuWin.hide();
}

function getMenuWindow() {
  return menuWin;
}

module.exports = {
  createPetWindow,
  createBubbleWindow,
  showBubble,
  hideBubble,
  toggleBubble,
  positionBubble,
  pinBubble,
  isPinned,
  sendToPet,
  sendToBubble,
  getPetWindow,
  getBubbleWindow,
  getMenuWindow,
  isPetVisible,
  togglePet,
  applyPetScale,
  stepPetScale,
  sizeForScale,
  showContextMenu,
  hideContextMenu,
  resizeContextMenu,
  dockPosition,
  PET_W,
  PET_H,
  BUBBLE_W,
  BUBBLE_H,
  petScale
};
