'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const config = require('../core/config');

const PET_W = 180;
const PET_H = 196;
const BUBBLE_W = 400;
const BUBBLE_H = 560;

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
  return Number(config.get('pet.scale', 0.85)) || 0.85;
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
  petWin = new BrowserWindow({
    width: PET_W,
    height: PET_H,
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
  dockPosition,
  PET_W,
  PET_H,
  BUBBLE_W,
  BUBBLE_H,
  petScale
};
