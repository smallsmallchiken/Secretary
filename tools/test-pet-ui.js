'use strict';

/**
 * 桌宠交互离线回归用例（纯 node，不需要 Electron）。
 *
 * 第 1 组：pet.css 不允许再把 #stage 放大（scale / :hover），
 *          窗口只有画布那么大，放大只会被 overflow:hidden 裁边——"点一下就变大"。
 * 第 2 组：pet.js 的拖动状态一定会收尾（鼠标在窗口外松开也不会卡住）。
 *
 * 用法：node tools/test-pet-ui.js
 * 退出码：0 全过；1 有失败。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CSS_FILE = path.join(ROOT, 'src/renderer/pet/pet.css');
const JS_FILE = path.join(ROOT, 'src/renderer/pet/pet.js');

let passCount = 0;
let failCount = 0;

function ok(name) {
  passCount += 1;
  console.log(`  ok   ${name}`);
}

function fail(name, detail) {
  failCount += 1;
  console.log(`  FAIL ${name} -> ${detail}`);
}

function check(name, cond, detail) {
  if (cond) ok(name);
  else fail(name, detail);
}

/* ==================== 第 1 组：尺寸不随交互变化 ==================== */

function checkCss() {
  console.log('\n[1] pet.css：尺寸恒定');
  const raw = fs.readFileSync(CSS_FILE, 'utf8');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  check(
    '全文没有 scale(（谁把放大加回来了？）',
    !/scale\s*\(/.test(css),
    '找到 scale( —— 桌宠窗口只有画布大，任何放大都会被裁边'
  );
  check(
    '没有 #stage:hover 规则（悬停放大是本次删掉的）',
    !/#stage\s*:\s*hover/.test(css),
    '找到 #stage:hover 规则'
  );
}

/* ==================== 第 2 组：拖动状态一定会收尾 ==================== */

const noop = () => {};

function makeCanvas() {
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
  return {
    style: {},
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 180, height: 196 })
  };
}

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c)
  };
}

/** 每个场景加载一份新的 pet.js 到新 vm 上下文，互不污染 */
function loadPet() {
  const listeners = { stage: {}, window: {} };
  const classList = makeClassList();
  const calls = { dragStart: 0, dragMove: 0, dragEnd: 0, click: 0 };
  const canvas = makeCanvas();
  const stageEl = {
    addEventListener: (type, cb) => {
      (listeners.stage[type] = listeners.stage[type] || []).push(cb);
    },
    classList,
    offsetWidth: 1
  };

  const documentStub = {
    getElementById: (id) => (id === 'stage' ? stageEl : id === 'pet' ? canvas : null),
    addEventListener: noop
  };

  const sandbox = {
    console,
    document: documentStub,
    Image: class {
      set src(v) {}
    },
    requestAnimationFrame: () => 0,
    setTimeout,
    clearTimeout,
    innerWidth: 180,
    innerHeight: 196,
    devicePixelRatio: 1,
    addEventListener: (type, cb) => {
      (listeners.window[type] = listeners.window[type] || []).push(cb);
    },
    petAPI: {
      onState: noop,
      onWander: noop,
      onConfig: noop,
      getConfig: () => Promise.resolve({ behavior: { autoIdle: false, allowWander: true } }),
      click: () => (calls.click += 1),
      dragStart: () => (calls.dragStart += 1),
      dragMove: () => (calls.dragMove += 1),
      dragEnd: () => (calls.dragEnd += 1),
      contextMenu: noop
    }
  };
  sandbox.window = sandbox;

  vm.runInNewContext(fs.readFileSync(JS_FILE, 'utf8'), sandbox, { filename: JS_FILE });

  const dispatch = (target, type, props = {}) => {
    const evt = { preventDefault: noop, ...props };
    for (const cb of listeners[target][type] || []) cb(evt);
  };

  return { dispatch, calls, classList };
}

/* ---- 场景 1：按下 → 回来时按键已抬起（鼠标在窗外松开）---- */
function sceneStuckDrag() {
  const { dispatch, calls, classList } = loadPet();
  dispatch('stage', 'mousedown', { button: 0, screenX: 0, screenY: 0 });
  check('场景1 mousedown 后 dragStart===1', calls.dragStart === 1, `dragStart=${calls.dragStart}`);
  check('场景1 mousedown 后 dragging 已挂上', classList.contains('dragging'), '');
  // 鼠标在窗口外松开 → 收不到 mouseup；回到窗口时 buttons=0
  dispatch('window', 'mousemove', { buttons: 0, screenX: 0, screenY: 0 });
  check('场景1 buttons=0 的 mousemove 补收尾 dragEnd===1', calls.dragEnd === 1, `dragEnd=${calls.dragEnd}`);
  check('场景1 dragging 已摘掉', !classList.contains('dragging'), 'dragging 还挂着——卡死复现');
}

/* ---- 场景 2：正常点击 ---- */
function sceneClick() {
  const { dispatch, calls, classList } = loadPet();
  dispatch('stage', 'mousedown', { button: 0, screenX: 0, screenY: 0 });
  dispatch('window', 'mouseup', { button: 0, screenX: 0, screenY: 0 });
  check('场景2 mouseup 后 dragEnd===1', calls.dragEnd === 1, `dragEnd=${calls.dragEnd}`);
  check('场景2 没拖动的释放算一次 click', calls.click === 1, `click=${calls.click}`);
  check('场景2 dragging 已摘掉', !classList.contains('dragging'), '');
}

/* ---- 场景 3：按住拖动 ---- */
function sceneDrag() {
  const { dispatch, calls, classList } = loadPet();
  dispatch('stage', 'mousedown', { button: 0, screenX: 0, screenY: 0 });
  dispatch('window', 'mousemove', { buttons: 1, screenX: 30, screenY: 20 });
  check('场景3 拖过阈值后 dragMove>=1', calls.dragMove >= 1, `dragMove=${calls.dragMove}`);
  check('场景3 拖动中不算点击 click===0', calls.click === 0, `click=${calls.click}`);
  check('场景3 拖动中 dragging 仍在', classList.contains('dragging'), '');
  dispatch('window', 'mouseup', { button: 0, screenX: 30, screenY: 20 });
  check('场景3 mouseup 后 dragEnd===1', calls.dragEnd === 1, `dragEnd=${calls.dragEnd}`);
  check('场景3 拖过的不算点击 click===0', calls.click === 0, `click=${calls.click}`);
}

/* ---- 场景 4：右键不参与拖动 ---- */
function sceneRightButton() {
  const { dispatch, calls } = loadPet();
  dispatch('stage', 'mousedown', { button: 2, screenX: 0, screenY: 0 });
  check('场景4 右键 mousedown 不开拖 dragStart===0', calls.dragStart === 0, `dragStart=${calls.dragStart}`);
  dispatch('window', 'mouseup', { button: 2, screenX: 0, screenY: 0 });
  check('场景4 右键 mouseup 无收尾 dragEnd===0', calls.dragEnd === 0, `dragEnd=${calls.dragEnd}`);
}

function checkDrag() {
  console.log('\n[2] pet.js：拖动一定收尾');
  sceneStuckDrag();
  sceneClick();
  sceneDrag();
  sceneRightButton();
}

/* ==================== 入口 ==================== */

checkCss();
checkDrag();

console.log(`\n桌宠 UI 自检：${passCount} 通过 / ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
