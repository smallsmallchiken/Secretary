'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * 统一的运行时数据目录（配置 / 状态 / 日志 / 表情库都放这里）。
 *
 * 开发态写项目内 `.data`（遵守"所有产出放工作区"的约定），打包后写 userData。
 *
 * 允许用环境变量 `PET_DATA_DIR` 整体重定向 —— 自动化测试靠它把数据全写到临时目录，
 * 否则一跑测试就会改到线上 config.json：正在值守的机器人会立刻读到测试用的
 * 假 baseUrl（127.0.0.1:1），回复直接全挂；测试中途被杀还会把这个假配置留在盘上。
 */
function dataDir() {
  const override = process.env.PET_DATA_DIR;
  const base = override
    ? path.resolve(override)
    : app.isPackaged
      ? app.getPath('userData')
      : path.join(app.getAppPath(), '.data');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

module.exports = { dataDir };
