'use strict';

/**
 * 窗口层离线验证：桌宠显隐（Alt+Q 的逻辑）与自绘菜单窗口能否正常创建。
 * 不启动真实 Electron。
 *
 * 用法：node tools/test-windows.js
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

const windows = require(path.join(ROOT, 'src/main/windows.js'));

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (期望 ${expected})`}`);
}

console.log('桌宠显隐：');
check('初始无窗口', windows.isPetVisible(), false);

const v1 = windows.togglePet(); // 首次调用会创建窗口
console.log(`  首次 togglePet -> ${v1}（创建窗口，等 ready-to-show 才显示）`);
check('已存在窗口', !!windows.getPetWindow(), true);

const v2 = windows.togglePet();
check('第二次切换后可见', windows.isPetVisible(), true);
check('返回值与可见性一致', v2, true);

const v3 = windows.togglePet();
check('第三次切换后隐藏', windows.isPetVisible(), false);
check('返回值与可见性一致', v3, false);

console.log('\n缩放（Alt+↑ / Alt+↓ 的逻辑）：');
const base = windows.sizeForScale(0.85);
check('scale 0.85 对应默认 180x196', `${base.width}x${base.height}`, '180x196');

windows.togglePet(); // 确保可见
const b0 = windows.getPetWindow().getBounds();

windows.applyPetScale(1.2765); // 放大一档多点
const b1 = windows.getPetWindow().getBounds();
check('放大后宽度', b1.width, Math.round(base.width * (1.2765 / 0.85)));
check('放大后高度', b1.height, Math.round(base.height * (1.2765 / 0.85)));
check('底部锚点不变（视觉上原地长大）', b1.y + b1.height, b0.y + b0.height);

windows.applyPetScale(0.45);
const b2 = windows.getPetWindow().getBounds();
check('缩到最小时宽度', b2.width, Math.round(base.width * (0.45 / 0.85)));

windows.applyPetScale(9); // 越界会被夹住
const b3 = windows.getPetWindow().getBounds();
check('超上限被夹到 2.0', b3.width, Math.round(base.width * (2.0 / 0.85)));

windows.applyPetScale(0.85); // 还原，避免影响后续断言

console.log('\n自绘菜单：');
const items = [
  { id: 'chat', label: '说点什么…', hint: 'Alt+W' },
  { sep: true },
  { id: 'toggle_pet', label: '隐藏桌宠', hint: 'Alt+Q' },
  { id: 'quit', label: '退出', danger: true }
];

windows.showContextMenu(items);
const menu = windows.getMenuWindow();
check('菜单窗口已创建', !!menu, true);
check('菜单可见', menu && menu.isVisible(), true);

const before = menu.getBounds();
windows.resizeContextMenu({ width: 240, height: 160 });
const after = menu.getBounds();
check('尺寸已按渲染结果调整', after.height, 160);

windows.hideContextMenu();
check('菜单已隐藏', menu.isVisible(), false);

console.log(`\n初始窗口位置 ${JSON.stringify(before)}`);

if (failed) {
  console.log(`\n${failed} 项未通过`);
  process.exit(1);
}
console.log('\n窗口层逻辑正常 ✓');
