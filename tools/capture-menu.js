'use strict';

/**
 * 右键菜单的外观自检：单独起一个透明窗口加载菜单页面，截图存盘后退出。
 * 只截菜单窗口本身，不会抓取桌面内容。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/capture-menu.js
 */

const fs = require('fs');
const path = require('path');

const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.workbuddy', 'tmp', 'menu.png');

// 和 buildMenuItems() 保持一致的样例数据
const ITEMS = [
  { id: 'chat', label: '说点什么…', hint: 'Alt+W' },
  { sep: true },
  { id: 'netease', label: '打开网易云音乐' },
  { id: 'playpause', label: '播放 / 暂停' },
  { id: 'next', label: '下一首' },
  { id: 'mute', label: '静音切换' },
  { sep: true },
  { id: 'reminders', label: '我的提醒' },
  { id: 'walk', label: '走两步' },
  { id: 'dock', label: '回到右下角' },
  { sep: true },
  { id: 'settings', label: '设置' },
  { id: 'toggle_pet', label: '隐藏桌宠', hint: 'Alt+Q' },
  { id: 'quit', label: '退出', danger: true }
];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 240,
    height: 470,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'menu-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'menu', 'index.html'));
  win.webContents.send('menu:render', ITEMS);

  // 给 CSS 动画留点时间
  setTimeout(async () => {
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, image.toPNG());
    console.log('已保存', OUT, image.getSize());
    app.quit();
  }, 900);
});
