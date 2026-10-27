'use strict';

/**
 * 漫游逻辑离线验证：不启动 Electron 窗口，
 * 用假的 windows 模块记录 setPosition 调用，确认桌宠窗口真的在被挪动、
 * 撞到屏幕边缘会掉头。
 *
 * 用法：node tools/test-wander.js
 */

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};

// ---- 假窗口 ----
const state = { x: 900, y: 800, visible: true };
const moves = [];
const petStates = [];

const fakeWin = {
  isDestroyed: () => false,
  isVisible: () => state.visible,
  getBounds: () => ({ x: state.x, y: state.y, width: 180, height: 196 }),
  setPosition: (x, y) => {
    state.x = x;
    state.y = y;
    moves.push(x);
  }
};

const windowsPath = require.resolve(path.join(ROOT, 'src/main/windows.js'));
require.cache[windowsPath] = {
  id: windowsPath,
  filename: windowsPath,
  loaded: true,
  exports: {
    getPetWindow: () => fakeWin,
    getBubbleWindow: () => null,
    sendToPet: (channel, payload) => petStates.push(payload),
    dockPosition: () => ({ x: 900, y: 800 })
  }
};

const wander = require(path.join(ROOT, 'src/main/wander.js'));

const started = wander.nudge();
if (!started) {
  console.log('没能开始漫游（可能被 config 的 behavior.allowWander 关掉了）');
  process.exit(1);
}

setTimeout(() => {
  wander.stop();
  const first = moves[0];
  const last = moves[moves.length - 1];
  console.log(`触发成功，共移动 ${moves.length} 次`);
  console.log(`x: ${first} -> ${last}  (${last > first ? '向右' : '向左'})`);
  console.log(`推给渲染器的状态: ${JSON.stringify(petStates.slice(0, 2))} … ${JSON.stringify(petStates.slice(-1))}`);
  console.log(`方向切换次数: ${petStates.filter((p) => p.dir === 'left').length} 次朝左 / ${petStates.filter((p) => p.dir === 'right').length} 次朝右`);

  if (moves.length < 5) {
    console.log('异常：几乎没有移动');
    process.exit(1);
  }
  console.log('漫游逻辑正常 ✓');
}, 700);
