'use strict';

/**
 * 命令行跑 Electron 主进程模块时用的 electron 替身。
 * 只提供 config.js / debug.js / tools 需要的那几个东西，
 * 目的是能在纯 node 下验证 agent 链路，不用启动窗口。
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.data');

const app = {
  isPackaged: false,
  getAppPath: () => ROOT,
  getPath: (name) => (name === 'userData' ? DATA : path.join(ROOT, '.data', name)),
  whenReady: () => Promise.resolve(),
  on: () => {},
  quit: () => {}
};

const noopDisplay = {
  id: 0,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }
};

const screen = {
  getCursorScreenPoint: () => ({ x: 100, y: 100 }),
  getPrimaryDisplay: () => noopDisplay,
  getDisplayNearestPoint: () => noopDisplay,
  getDisplayMatching: () => noopDisplay
};

class BrowserWindow {
  constructor() {
    this.webContents = { send() {}, on() {}, once() {}, isLoading: () => false };
    this._visible = false;
    this._destroyed = false;
    this._bounds = { x: 0, y: 0, width: 180, height: 196 };
  }
  isDestroyed() {
    return this._destroyed;
  }
  isVisible() {
    return this._visible;
  }
  show() {
    this._visible = true;
  }
  hide() {
    this._visible = false;
  }
  focus() {}
  moveTop() {}
  on() {}
  once() {}
  loadFile() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setPosition(x, y) {
    this._bounds.x = x;
    this._bounds.y = y;
    // 模拟真实平台行为：Windows 上以非 100% 缩放移动透明窗口时，
    // 尺寸会做一次 DIP↔物理像素取整，小数部分逐次累加，窗口越移越大
    // （实测：漫游 150 秒从 954x548 长到 1462x732）。
    // 默认关闭，只有 test-pet-ui.js 的「移动不许改尺寸」用例打开。
    if (BrowserWindow.simulateMoveDrift) {
      this._bounds.width += 1;
      this._bounds.height += 1;
    }
  }
  setBounds(b) {
    this._bounds = { ...this._bounds, ...b };
  }
  getBounds() {
    return { ...this._bounds };
  }
  getSize() {
    return [this._bounds.width, this._bounds.height];
  }
}

/** 打开后 setPosition 会模拟真实平台的尺寸漂移（见上面注释） */
BrowserWindow.simulateMoveDrift = false;

let clipText = '';
const clipboard = {
  readText: () => clipText,
  writeText: (t) => {
    clipText = String(t);
  }
};

class Notification {
  constructor(opts) {
    this.opts = opts;
  }
  show() {}
  static isSupported() {
    return false;
  }
}

module.exports = {
  app,
  screen,
  BrowserWindow,
  ipcMain: { on() {}, handle() {} },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  Tray: class {},
  nativeImage: { createFromPath: () => ({}) },
  globalShortcut: { register() {}, unregisterAll() {} },
  clipboard,
  shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve('') },
  Notification
};
