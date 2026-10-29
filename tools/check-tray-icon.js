'use strict';

/** 校验托盘图标能否被 Electron 正确读入（防止图标尺寸/格式问题导致托盘空白） */

const path = require('path');

const { app, nativeImage } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const file = path.join(__dirname, '..', 'src', 'assets', 'tray-head.png');
  const img = nativeImage.createFromPath(file);
  console.log('文件:', file);
  console.log('是否为空:', img.isEmpty());
  if (!img.isEmpty()) {
    console.log('原始尺寸:', img.getSize());
    const small = img.resize({ width: 20, height: 20, quality: 'best' });
    console.log('缩到 20x20:', small.getSize());
  }
  app.quit();
});
