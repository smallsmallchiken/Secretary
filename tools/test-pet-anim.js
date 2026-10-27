'use strict';

/**
 * 逐帧动画离线用例：
 *   把 src/renderer/pet/pet.js 跑在 vm + 假 DOM 里，自己驱动 rAF，
 *   验证"一次性动画（happy）播完后逐帧循环还活着"。
 *
 * 用法：node tools/test-pet-anim.js
 * 退出码：0 = 循环正常；1 = happy 播完后循环中断（bug 复现）
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src/renderer/pet/pet.js');

/* ---------- 假 DOM / 假 window ---------- */

const noop = () => {};

const ctx = {
  clearRect: noop,
  drawImage: noop,
  beginPath: noop,
  arc: noop,
  fill: noop,
  imageSmoothingEnabled: true,
  imageSmoothingQuality: 'high',
  fillStyle: ''
};

const canvas = {
  style: {},
  width: 0,
  height: 0,
  getContext: () => ctx,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 180, height: 196 })
};

const stage = {
  addEventListener: noop,
  classList: { add: noop, remove: noop },
  offsetWidth: 1
};

const documentStub = {
  getElementById: (id) => (id === 'stage' ? stage : id === 'pet' ? canvas : null),
  addEventListener: noop // 不触发 DOMContentLoaded，省得造 body
};

let rafQueue = [];
let rafCount = 0;
const requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  rafCount += 1;
  return rafCount;
};

let imgInstance = null;
class FakeImage {
  constructor() {
    imgInstance = this;
  }
  set src(v) {
    this._src = v; // 赋值不做事，由用例手动 onload
  }
  get src() {
    return this._src;
  }
}

const stateCbs = [];
const wanderCbs = [];
const configCbs = [];

const petAPI = {
  onState: (cb) => stateCbs.push(cb),
  onWander: (cb) => wanderCbs.push(cb),
  onConfig: (cb) => configCbs.push(cb),
  getConfig: () => Promise.resolve({ behavior: { autoIdle: false, allowWander: true } }),
  click: noop,
  dragStart: noop,
  dragMove: noop,
  dragEnd: noop,
  contextMenu: noop
};

const sandbox = {
  console,
  document: documentStub,
  Image: FakeImage,
  requestAnimationFrame,
  setTimeout,
  clearTimeout,
  petAPI,
  innerWidth: 180,
  innerHeight: 196,
  devicePixelRatio: 1,
  addEventListener: noop
};
sandbox.window = sandbox;

/* ---------- 驱动 ---------- */

vm.runInNewContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

let died = null; // 记录死在哪一帧
function pump(frames, stepMs, label) {
  for (let i = 0; i < frames; i++) {
    if (!rafQueue.length) {
      died = `${label} 第 ${i} 帧`;
      return;
    }
    const cbs = rafQueue;
    rafQueue = [];
    for (const cb of cbs) cb(ts);
    ts += stepMs;
  }
}

let ts = 1000;

// 1. 触发图片加载完成 → 启动 rAF 循环
imgInstance.onload();
if (!rafQueue.length) {
  console.log('FAIL  img.onload 后没有排任何 rAF，循环根本没启动');
  process.exit(1);
}

// 2. idle 跑 40 帧（约 2s），循环必须一直活着
pump(40, 50, 'idle 阶段');
if (died) {
  console.log(`FAIL  ${died}：idle 动画循环中断（rAF 队列空了，共排过 ${rafCount} 帧）`);
  process.exit(1);
}
console.log(`  idle 40 帧后循环正常（已排 ${rafCount} 帧）`);

// 3. 推 happy（6 帧 @13fps ≈ 460ms），再跑 30 帧（约 1.5s）
for (const cb of stateCbs) cb({ state: 'happy' });
pump(30, 50, 'happy 后');

if (died) {
  console.log(`复现成功：${died}：happy 播完后逐帧循环中断（共排过 ${rafCount} 帧），桌宠将永久静止`);
  process.exit(1);
}
console.log(`通过：happy 播完后逐帧循环仍在运行（已排 ${rafCount} 帧）`);
process.exit(0);
