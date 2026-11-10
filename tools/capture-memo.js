'use strict';

/**
 * 备忘录面板的外观自检：起一个临时 Electron，注册最少的 IPC 桩（直接读真实的
 * .data/memo.json），打开面板截图后退出。不碰正在运行的桌宠（独立 userData）。
 *
 * 用法：electron tools/capture-memo.js
 * 产物：.workbuddy/tmp/memo.png
 */

const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.workbuddy', 'tmp', 'memo.png');
process.env.PET_DATA_DIR = path.join(ROOT, '.data');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(ROOT, '.workbuddy', 'tmp', '_memo_user'));

const memo = require(path.join(ROOT, 'src/core/memo.js'));

app.whenReady().then(async () => {
  ipcMain.handle('config:get', () => ({}));
  ipcMain.handle('memo:list', () => memo.refresh());
  ipcMain.handle('memo:toggle', (_e, id) => memo.toggle(id));
  ipcMain.handle('memo:remove', (_e, id) => memo.remove(id));
  ipcMain.handle('memo:clear-done', () => memo.clearDone());
  ipcMain.handle('memo:refresh', () => memo.refresh());
  ipcMain.handle('memo:open-database', () => '');
  ipcMain.handle('memo:close', () => {});

  const windows = require(path.join(ROOT, 'src/main/windows.js'));
  windows.createPetWindow();
  await new Promise((r) => setTimeout(r, 1000));

  const win = windows.showMemo();
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, img.toPNG());
    console.log('SHOT_OK', OUT, img.getSize().width + 'x' + img.getSize().height);
  } catch (e) {
    console.log('SHOT_FAIL', e.message);
  }
  app.exit(0);
});
