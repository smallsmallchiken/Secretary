'use strict';

/**
 * 对话框外观自检：单独起一个透明窗口加载云朵气泡页面，截图存盘后退出。
 * 只截气泡窗口本身，不会抓取桌面内容。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/capture-bubble.js
 * 可选参数：--below 模拟「气泡翻到脑袋下方」，--settings 截设置页
 */

const fs = require('fs');
const path = require('path');

const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..');
const BELOW = process.argv.includes('--below');
const SETTINGS = process.argv.includes('--settings');
const EMPTY = process.argv.includes('--empty');
const OUT = path.join(
  ROOT,
  '.workbuddy',
  'tmp',
  SETTINGS ? 'bubble-settings.png' : EMPTY ? 'bubble-empty.png' : BELOW ? 'bubble-below.png' : 'bubble.png'
);

// 主进程不在，这里把渲染器用到的几个通道补成哑实现
const noop = async () => ({});
ipcMain.handle('app:info', async () => ({ version: '0.0.0', electron: 'x', llmReady: true }));
ipcMain.handle('config:get', async () => ({}));
ipcMain.handle('config:path', async () => '.data/config.json');
ipcMain.handle('reminder:list', async () => []);
ipcMain.handle('bubble:resize', noop);
ipcMain.handle('bubble:mode', noop);
ipcMain.handle('bubble:send', async () => ({ type: 'ok', message: '汪！收到。' }));
ipcMain.handle('bubble:hide', noop);
ipcMain.handle('config:set', noop);
ipcMain.handle('reminder:cancel', noop);
ipcMain.handle('app:quit', () => app.quit());

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SETTINGS ? 400 : 352,
    height: SETTINGS ? 560 : 220,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'bubble-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`[renderer:${level}] ${message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`[did-fail-load] ${code} ${desc}`);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'bubble', 'index.html'));

  // 放两条消息进去，好看出云朵里的排版（--empty 看空态有多干净）
  await new Promise((r) => setTimeout(r, 300));
  if (!EMPTY) {
    win.webContents.send('bubble:push', { role: 'user', text: '打开网易云音乐' });
    win.webContents.send('bubble:push', {
      role: 'assistant',
      text: '好，已经帮你把网易云拉起来了。'
    });
  }
  win.webContents.send('bubble:layout', { side: 'left', below: BELOW });

  setTimeout(async () => {
    if (SETTINGS) win.webContents.send('bubble:open-settings');
    await new Promise((r) => setTimeout(r, 500));
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, image.toPNG());
    console.log('已保存', OUT, image.getSize());
    app.quit();
  }, 900);
});
