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

console.log('\n贴头气泡定位：');
// 只验「结构对不对」，不断言具体像素偏移：云朵/句号/尾巴的锚点常量是
// windows.js 和 bubble.css 两边共用的，改样式就会变，写死在测试里只会
// 让每次调 UI 都红一片。真正要防的回归是：挂错边、压到桌宠、跑出屏幕、
// 高度不夹取、设置态尺寸不对、顶边不翻面。
// 替身工作区 1920x1040，dockPosition 把桌宠放右下角（右半边）→ 气泡应挂左侧
windows.showBubble(); // 确保气泡窗口已创建（chat 态）
windows.setBubbleMode('chat');
windows.resizeBubbleChat(200);
windows.positionBubble();

const lay = windows.getBubbleLayout();
const pet = windows.getPetWindow(); // 窗口对象，供下面挪位置用
const petBox = pet.getBounds(); // 停靠位快照
const bub = windows.getBubbleWindow().getBounds();

check('气泡挂宠物左侧（桌宠在工作区右半边）', lay && lay.side, 'left');
check('气泡整体在脑袋上方（往上长，不盖住桌宠身体）', bub.y + bub.height <= petBox.y + petBox.height, true);
check('气泡不越出工作区左沿', bub.x >= 0, true);
check('气泡不越出工作区右沿', bub.x + bub.width <= 1920, true);
check('气泡与宠物不重叠', bub.x + bub.width <= petBox.x, true);
check('气泡不越出工作区上下沿', bub.y >= 0 && bub.y + bub.height <= 1040, true);

const hMin = windows.resizeBubbleChat(5);
check('高度夹取下限 BUBBLE_CHAT_MIN_H', hMin.height, 96);
const hMax = windows.resizeBubbleChat(9999);
check('高度夹取上限 BUBBLE_CHAT_MAX_H', hMax.height, 380);
const hMid = windows.resizeBubbleChat(200);
check('高度按渲染回传值', hMid.height, 200);

// 桌宠被拖到屏幕顶边时，上方放不下 → 翻到脑袋下方（below 标记给渲染器翻尾巴）
pet.setPosition(petBox.x, 0);
windows.resizeBubbleChat(200);
const layTop = windows.getBubbleLayout();
check('顶边时翻到脑袋下方', layTop && layTop.below, true);
check('below 态气泡仍留在工作区内', layTop.y >= 0 && layTop.y + 200 <= 1040, true);
pet.setPosition(petBox.x, petBox.y); // 还原 dockPosition 的停靠位

windows.setBubbleMode('settings');
const bubSettings = windows.getBubbleWindow().getBounds();
check('设置态窗口尺寸 400x560', `${bubSettings.width}x${bubSettings.height}`, '400x560');
check('设置态不越出工作区', bubSettings.y >= 0 && bubSettings.y + bubSettings.height <= 1040, true);
windows.setBubbleMode('chat'); // 还原，避免影响后续断言

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
