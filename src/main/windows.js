'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const config = require('../core/config');

const PET_W = 180;
const PET_H = 196;
const BUBBLE_W = 400;
const BUBBLE_H = 560;

// 气泡态（贴头小气泡）
const BUBBLE_CHAT_W = 352;      // 窗口宽
const BUBBLE_CHAT_MIN_H = 132;   // 云朵边框 + 输入行，再矮就不像对话框了
const BUBBLE_CHAT_MAX_H = 380;  // 内容超了就让消息区内部滚动
const HEAD_RATIO = 0.30;        // 脑袋在宠物窗口高度的 30% 处
const TAIL_INSET = 20;          // 三角尾巴尖距「窗口底边」的距离（设置态面板用）
const DOT_INSET = 11;           // 云朵下方「句号」圆点中心距窗口底边的距离：body 底 padding 6 + 半径 5
const BUBBLE_GAP = 10;          // 气泡与宠物的水平间距

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
let bubbleMode = 'chat';        // 'chat' | 'settings'
let bubbleChatH = 220;          // 气泡态最近一次量到的高度
let lastBubbleLayout = null;    // positionBubble() 最近一次算出的布局，供测试读取

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

/**
 * 把桌宠尺寸钉回 config 里的目标值。
 *
 * 为什么需要这个兜底：Windows 上以非 100% 缩放（本机 125%）移动透明无边框窗口时，
 * 每次移动都要做一次 DIP↔物理像素取整，误差逐次累加，桌宠会越拖越大。
 * 实测 150 次移动：只改 x 时 183x199 → 332x196；x、y 都改（真实拖动）时 → 333x345。
 * 一旦窗口变高，渲染器里 scale = min(w/192, h/208) 跟着变大，狗就真的长大了。
 *
 * movePet() 每次移动都写回目标尺寸，已经挡住了常规路径；
 * 但 show/hide、跨屏、系统缩放变化这些不经过 movePet 的地方仍会漏，
 * 所以这里在窗口尺寸一变就钉回去。
 *
 * 容差 2px 是必须的：125% 缩放下 setBounds(180) 读回来是 181，稳态就有 1px 误差；
 * 不留容差会和 resize 事件互相触发，死循环。
 */
const SIZE_TOLERANCE = 2;

function snapPetSize() {
  const win = petWin && !petWin.isDestroyed() ? petWin : null;
  if (!win) return false;
  const b = win.getBounds();
  const { width, height } = sizeForScale(petScale());
  if (Math.abs(b.width - width) <= SIZE_TOLERANCE && Math.abs(b.height - height) <= SIZE_TOLERANCE) {
    return false;
  }
  win.setBounds({ x: b.x, y: b.y, width, height });
  require('../core/debug').dbg(
    `[snap] 尺寸被改动 ${b.width}x${b.height} -> ${width}x${height}，已钉回`
  );
  return true;
}

/**
 * 移动桌宠窗口。
 *
 * 不能只用 setPosition：Windows 上以非 100% 缩放移动透明窗口时，
 * 每次移动都会把尺寸做一次 DIP↔物理像素取整，小数部分逐次累加，
 * 桌宠会越移越大（实测：漫游 150 秒从 954x548 长到 1462x732）。
 * 这里每次移动都把「目标尺寸」一起写回去，漂移就不会累积——
 * 目标尺寸来自 config，不来自已经漂了的当前 bounds。
 */
function movePet(x, y) {
  const win = petWin && !petWin.isDestroyed() ? petWin : null;
  if (!win) return false;
  const nx = Math.round(x);
  const ny = Math.round(y);
  const { width, height } = sizeForScale(petScale());
  const b = win.getBounds();
  if (b.x === nx && b.y === ny && b.width === width && b.height === height) return false;
  win.setBounds({ x: nx, y: ny, width, height });
  return true;
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
  movePet(pos.x, pos.y);

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

  // 桌宠尺寸恒定：任何不经过 movePet 的路径把尺寸改了，这里立刻钉回去
  petWin.on('resize', snapPetSize);

  return petWin;
}

function createBubbleWindow() {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin;

  bubbleMode = 'chat';
  bubbleWin = new BrowserWindow({
    width: BUBBLE_CHAT_W,
    height: bubbleChatH,
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
      // 焦点落在对话框内部（输入框 / 设置表单）时不收起，
      // 否则用户点一下输入框、系统顺手回一次 blur 就把面板收没了
      const js =
        "document.hasFocus() && document.activeElement && document.activeElement.tagName !== 'BODY'";
      bubbleWin.webContents
        .executeJavaScript(js)
        .then((keep) => {
          if (keep) return;
          require('../core/debug').dbg('[blur] 触发隐藏');
          hideBubble();
        })
        .catch(() => {
          require('../core/debug').dbg('[blur] 触发隐藏（焦点查询失败）');
          hideBubble();
        });
    }, 250);
  });

  bubbleWin.on('closed', () => {
    bubbleWin = null;
    bubbleReady = false;
  });

  return bubbleWin;
}

/**
 * 把气泡窗口摆到宠物旁边，并让「指向脑袋的那一点」压在脑袋上。
 *
 * 锚点（距窗口某条边多少像素）：
 *   设置态 = 三角尾巴尖，距窗口底边 TAIL_INSET(20)
 *   聊天态 = 云朵下方那个「句号」圆点的中心，距窗口底边 DOT_INSET(11)
 *           （bubble.css: body 底 padding 6 + 圆点半径 5）
 * 气泡默认向上生长（锚点在下），上方放不下时翻到脑袋下方、锚点改走顶边。
 */
function positionBubble() {
  if (!bubbleWin || bubbleWin.isDestroyed() || !petWin || petWin.isDestroyed()) return;
  const pb = petWin.getBounds();
  const wa = screen.getDisplayMatching(pb).workArea;
  const [bw, bh] = bubbleWin.getSize();

  const headY = pb.y + Math.round(pb.height * HEAD_RATIO);
  const anchor = bubbleMode === 'settings' ? TAIL_INSET : DOT_INSET;

  // 左右：桌宠在工作区左半边 → 气泡挂右侧；右半边 → 挂左侧
  const petCenterX = pb.x + pb.width / 2;
  const waCenterX = wa.x + wa.width / 2;
  let side = petCenterX < waCenterX ? 'right' : 'left';

  const gap = bubbleMode === 'settings' ? 12 : BUBBLE_GAP;
  const xFor = (s) => (s === 'left' ? pb.x - bw - gap : pb.x + pb.width + gap);
  let x = xFor(side);
  // 贴屏幕边缘放不下就翻边
  if (x < wa.x + 8 || x + bw > wa.x + wa.width - 8) {
    side = side === 'left' ? 'right' : 'left';
    x = xFor(side);
  }
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - bw - 8));

  // 气泡在脑袋上方生长，锚点（距底边 anchor）落在脑袋上
  let below = false;
  let y = headY - (bh - anchor);
  if (y < wa.y + 8) {
    // 上方放不下（桌宠被拖到屏幕顶部）→ 翻到脑袋下方，锚点改走顶边
    below = true;
    y = headY - anchor;
  }
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - bh - 8));

  x = Math.round(x);
  y = Math.round(y);
  // 同 movePet：setPosition 在非 100% 缩放下会让窗口越移越大，把尺寸一起写回去
  bubbleWin.setBounds({ x, y, width: bw, height: bh });
  lastBubbleLayout = { side, below, x, y };
  if (bubbleReady) bubbleWin.webContents.send('bubble:layout', { side, below });
}

/** 渲染器量完高度后回调：改窗口尺寸再重新定位 */
function resizeBubbleChat(height) {
  if (!bubbleWin || bubbleWin.isDestroyed()) {
    return { width: BUBBLE_CHAT_W, height: bubbleChatH };
  }
  const h = Math.max(
    BUBBLE_CHAT_MIN_H,
    Math.min(BUBBLE_CHAT_MAX_H, Math.round(Number(height) || bubbleChatH))
  );
  bubbleChatH = h;
  if (bubbleMode === 'chat') {
    bubbleWin.setBounds({ width: BUBBLE_CHAT_W, height: h });
    positionBubble();
  }
  return { width: BUBBLE_CHAT_W, height: bubbleChatH };
}

/** 聊天态 ↔ 设置态切换（同一个窗口改尺寸） */
function setBubbleMode(mode) {
  bubbleMode = mode === 'settings' ? 'settings' : 'chat';
  if (!bubbleWin || bubbleWin.isDestroyed()) return { mode: bubbleMode };
  if (bubbleMode === 'settings') bubbleWin.setBounds({ width: BUBBLE_W, height: BUBBLE_H });
  else bubbleWin.setBounds({ width: BUBBLE_CHAT_W, height: bubbleChatH });
  positionBubble();
  return { mode: bubbleMode };
}

/** 最近一次 positionBubble() 算出的布局（side/below/x/y），供离线测试断言 */
function getBubbleLayout() {
  return lastBubbleLayout;
}

function showBubble(pinMs = 2500) {
  const win = createBubbleWindow();
  // 保护期由调用方决定：普通唤起 2.5s 够用，打开设置这类需要用户慢慢看的给更长
  pinBubble(pinMs);
  // 唤起时回到聊天态（同步切，position 之前），设置页由渲染器收到 bubble:open-settings 后再切
  setBubbleMode('chat');
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
  resizeBubbleChat,
  setBubbleMode,
  getBubbleLayout,
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
  snapPetSize,
  movePet,
  showContextMenu,
  hideContextMenu,
  resizeContextMenu,
  dockPosition,
  PET_W,
  PET_H,
  BUBBLE_W,
  BUBBLE_H,
  BUBBLE_CHAT_W,
  BUBBLE_CHAT_MIN_H,
  BUBBLE_CHAT_MAX_H,
  HEAD_RATIO,
  TAIL_INSET,
  DOT_INSET,
  BUBBLE_GAP,
  petScale
};
