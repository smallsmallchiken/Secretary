'use strict';

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');
const config = require('../core/config');
const windows = require('./windows');

let tray = null;

function buildMenu() {
  const petWin = windows.getPetWindow();
  const visible = !!(petWin && petWin.isVisible());

  return Menu.buildFromTemplate([
    { label: '万能桌宠', enabled: false },
    { type: 'separator' },
    {
      label: visible ? '隐藏桌宠' : '显示桌宠',
      click: () => {
        if (!petWin) return;
        if (petWin.isVisible()) petWin.hide();
        else {
          petWin.show();
          const pos = windows.dockPosition(petWin);
          petWin.setPosition(pos.x, pos.y);
        }
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
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // 兜底：1x1 透明图标，至少不让托盘崩
    image = nativeImage.createEmpty();
  } else {
    image = image.resize({ width: 20, height: 20 });
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
      win.setPosition(pos.x, pos.y);
    }
  });

  return tray;
}

function refreshTray() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

module.exports = { createTray, refreshTray };
