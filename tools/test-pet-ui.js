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

/* ============ 第 3 组：移动桌宠不许改尺寸（主进程） ============ */

/**
 * 真实症状：Windows 上以 125% 缩放拖动 / 漫游桌宠时，窗口每移动一次就大一点
 * （实测：漫游 150 秒从 954x548 长到 1462x732，用户那只长到 1082x548）。
 * 所以桌宠只能通过 windows.movePet 移动——它每次都会把目标尺寸一起写回去。
 *
 * 替身里 setPosition 会模拟这个漂移（每次 +1px），setBounds 则精确写入，
 * 也就是 movePet 的修复思路：目标尺寸来自 config，不来自已经漂了的当前 bounds。
 */
function checkMoveKeepsSize() {
  console.log('\n[3] 主进程：移动桌宠不改尺寸');

  const Module = require('module');
  const STUB = path.join(__dirname, 'electron-stub.js');
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return STUB;
    return originalResolve.call(this, request, ...rest);
  };

  const electron = require(STUB);
  const windows = require(path.join(ROOT, 'src/main/windows.js'));
  const win = windows.createPetWindow();
  const before = win.getBounds();

  // 先证明模拟出来的漂移确实是这个问题：裸 setPosition 连续移动会越来越大
  electron.BrowserWindow.simulateMoveDrift = true;
  for (let i = 0; i < 200; i += 1) win.setPosition(100 + i, 200);
  const drifted = win.getBounds();
  check(
    '裸 setPosition 连移 200 次会变大（复现真实症状）',
    drifted.width > before.width && drifted.height > before.height,
    `尺寸 ${before.width}x${before.height} -> ${drifted.width}x${drifted.height}`
  );

  // movePet：每次移动都把目标尺寸写回去，200 次之后尺寸必须原样
  for (let i = 0; i < 200; i += 1) windows.movePet(100 + i, 200);
  const after = win.getBounds();
  check('movePet 移动 200 次后宽度不变', after.width === before.width, `width ${before.width} -> ${after.width}`);
  check('movePet 移动 200 次后高度不变', after.height === before.height, `height ${before.height} -> ${after.height}`);
  check('movePet 确实移动了窗口', after.x === 299 && after.y === 200, `位置 ${after.x},${after.y}`);

  // 已经被漂大的窗口，movePet 要能把它修回来
  win.setBounds({ x: 500, y: 500, width: before.width + 300, height: before.height + 200 });
  windows.movePet(500, 500);
  const healed = win.getBounds();
  check(
    '已经漂大的窗口，movePet 会修回目标尺寸',
    healed.width === before.width && healed.height === before.height,
    `尺寸 ${healed.width}x${healed.height}，期望 ${before.width}x${before.height}`
  );

  electron.BrowserWindow.simulateMoveDrift = false;
  Module._resolveFilename = originalResolve;
}

/* ============ 第 4 组：尺寸兜底 snapPetSize ============ */

/**
 * 光靠 movePet 不够——show/hide、跨屏、系统缩放变化这些路径不经过它，
 * 桌宠照样会被改大。所以窗口尺寸一变就要把它钉回去（windows.js 里挂在
 * 'resize' 事件上）。这里验 snapPetSize 本身的行为：
 *   - 被改大 -> 钉回目标尺寸
 *   - 只差 1px（125% 缩放下的稳态误差）-> 不动，否则会和 resize 事件死循环
 */
function checkSnapPetSize() {
  console.log('\n[4] 主进程：snapPetSize 把尺寸钉回去');

  const Module = require('module');
  const STUB = path.join(__dirname, 'electron-stub.js');
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return STUB;
    return originalResolve.call(this, request, ...rest);
  };

  const windows = require(path.join(ROOT, 'src/main/windows.js'));
  const win = windows.createPetWindow();
  const target = windows.sizeForScale(windows.petScale());

  // 被改大：钉回目标尺寸。
  // 注意这个进程和真桌宠进程共用 .data/debug.log，下面这次「改大」会在日志里
  // 留下一条 [snap] 尺寸被改动 ...x... -> 目标，是自检故意造的，不是真漂移。
  win.setBounds({ x: 200, y: 200, width: target.width + 240, height: target.height + 180 });
  const restored = windows.snapPetSize();
  const after = win.getBounds();
  check('被改大后 snapPetSize 会钉回目标尺寸', restored === true, `snapPetSize 返回 ${restored}`);
  check(
    '钉回后尺寸等于目标',
    after.width === target.width && after.height === target.height,
    `${after.width}x${after.height}，期望 ${target.width}x${target.height}`
  );
  check('钉回时不改位置', after.x === 200 && after.y === 200, `位置 ${after.x},${after.y}`);

  // 稳态 1px 误差：不能反复触发 setBounds，否则和 resize 事件互相打死循环
  win.setBounds({ x: 200, y: 200, width: target.width + 1, height: target.height + 1 });
  const noopSnap = windows.snapPetSize();
  check('只差 1px 时不折腾（否则 resize 事件死循环）', noopSnap === false, `snapPetSize 返回 ${noopSnap}`);

  // 事件确实挂上了（替身里 on() 是空实现，只能回到源码上断言）
  const src = fs.readFileSync(path.join(ROOT, 'src/main/windows.js'), 'utf8');
  check(
    "petWin 上挂了 resize -> snapPetSize",
    /petWin\.on\(\s*'resize'\s*,\s*snapPetSize\s*\)/.test(src),
    'windows.js 里找不到 resize 监听'
  );

  Module._resolveFilename = originalResolve;
}

/* ==================== 入口 ==================== */

checkCss();
checkDrag();
checkMoveKeepsSize();
checkSnapPetSize();

console.log(`\n桌宠 UI 自检：${passCount} 通过 / ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
