'use strict';

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');
const config = require('../core/config');
const windows = require('./windows');

let tray = null;

function buildMenu() {
  const visible = windows.isPetVisible();

  return Menu.buildFromTemplate([
    { label: '万能桌宠', enabled: false },
    { type: 'separator' },
    {
      label: visible ? '隐藏桌宠' : '显示桌宠',
      click: () => {
        windows.togglePet();
        refreshTray();
      }
    },
    {
      label: '说点什么',
      accelerator: config.get('shortcuts.toggle', 'Control+Shift+Space'),
      click: () => windows.showBubble()
    },
    { type: 'separator' },
    { label: '打开网易云音乐', click: () => require('../main/main').runQuick('打开网易云音乐') },
    { label: '播放 / 暂停', click: () => require('../main/main').runQuick('暂停播放') },
    { label: '下一首', click: () => require('../main/main').runQuick('下一首') },
    { label: '静音切换', click: () => require('../main/main').runQuick('静音') },
    { type: 'separator' },
    { label: '我的提醒', click: () => require('../main/main').runQuick('我的提醒') },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: !!config.get('autoLaunch'),
      click: (item) => {
        config.set({ autoLaunch: item.checked });
        require('../main/main').applyAutoLaunch(item.checked);
        refreshTray();
      }
    },
    {
      label: '设置',
      click: () => {
        windows.showBubble();
        setTimeout(() => windows.sendToBubble('bubble:open-settings'), 120);
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => require('../main/main').quitApp()
    }
  ]);
}

function createTray() {
  // 托盘只露一个头（全身图缩到 20px 会糊成一坨）
  const assets = path.join(__dirname, '..', 'assets');
  const candidates = [
    path.join(assets, 'tray-head.png'),
    path.join(assets, 'tray.png')
  ];

  let image = nativeImage.createEmpty();
  for (const file of candidates) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) {
      image = img.resize({ width: 20, height: 20, quality: 'best' });
      break;
    }
  }

  tray = new Tray(image);
  tray.setToolTip('万能桌宠 · 比格多栋');
  tray.setContextMenu(buildMenu());

  tray.on('click', () => windows.toggleBubble());
  tray.on('double-click', () => {
    const win = windows.getPetWindow();
    if (win) {
      win.show();
      const pos = windows.dockPosition(win);
      windows.movePet(pos.x, pos.y);
    }
  });

  return tray;
}

function refreshTray() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

module.exports = { createTray, refreshTray };
