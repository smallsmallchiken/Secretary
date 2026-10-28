'use strict';

const { screen } = require('electron');

const config = require('../core/config');
const windows = require('./windows');
const { dbg } = require('../core/debug');

/**
 * 自主漫游。
 *
 * 桌宠窗口是 180x196 的透明窗口，真正"走路"必须由主进程挪窗口，
 * 渲染器只负责播对应的行走帧（walk_r / walk_l）。
 * 渲染器自己不会动，所以这里同时承担"什么时候走、走多久、撞边掉头"。
 */

const SPEED_PX = 2; // 每 tick 位移，2px/40ms ≈ 50px/s
const TICK_MS = 40;
const GAP_MS = [25000, 55000]; // 两次溜达之间的随机间隔
const DURATION_MS = [2500, 6500]; // 单次溜达时长
const MIN_ROOM = 120; // 左右空间不足这么多就不走，免得原地抽搐

let ticker = null;
let scheduler = null;
let direction = 1; // 1 = 右，-1 = 左
let budgetMs = 0;
let busy = false;
let holdUntil = 0;

function allowed() {
  return config.get('behavior.allowWander', true) !== false;
}

function petWin() {
  const win = windows.getPetWindow();
  if (!win || win.isDestroyed() || !win.isVisible()) return null;
  return win;
}

function bubbleOpen() {
  const bw = windows.getBubbleWindow();
  return !!(bw && !bw.isDestroyed() && bw.isVisible());
}

function workAreaFor(bounds) {
  const display = screen.getDisplayMatching(bounds);
  return display.workArea;
}

function schedule(delay) {
  clearTimeout(scheduler);
  scheduler = null;
  if (!allowed()) return;
  const [lo, hi] = GAP_MS;
  const wait = delay != null ? delay : lo + Math.random() * (hi - lo);
  scheduler = setTimeout(tryStart, wait);
  if (scheduler.unref) scheduler.unref();
}

function tryStart() {
  scheduler = null;
  if (!allowed()) return;

  const win = petWin();
  if (!win) {
    schedule();
    return;
  }
  if (busy || Date.now() < holdUntil || bubbleOpen()) {
    schedule(9000);
    return;
  }

  const b = win.getBounds();
  const wa = workAreaFor(b);
  const roomLeft = b.x - wa.x;
  const roomRight = wa.x + wa.width - (b.x + b.width);

  if (Math.max(roomLeft, roomRight) < MIN_ROOM) {
    // 用户在屏幕边缘把它挤住了，不硬走
    schedule();
    return;
  }

  direction = roomRight >= roomLeft ? 1 : -1;
  budgetMs = DURATION_MS[0] + Math.random() * (DURATION_MS[1] - DURATION_MS[0]);
  busy = true;

  windows.sendToPet('pet:wander', { active: true, dir: direction > 0 ? 'right' : 'left' });
  dbg('[wander] 开始', direction > 0 ? '→' : '←');

  clearInterval(ticker);
  ticker = setInterval(step, TICK_MS);
  if (ticker.unref) ticker.unref();
}

function step() {
  const win = petWin();
  if (!win) {
    stop();
    return;
  }
  // 对话中 / 被拖住时暂停，但不结束本次溜达
  if (Date.now() < holdUntil || bubbleOpen()) return;

  budgetMs -= TICK_MS;
  if (budgetMs <= 0) {
    stop();
    return;
  }

  const b = win.getBounds();
  const wa = workAreaFor(b);
  const minX = wa.x;
  const maxX = wa.x + wa.width - b.width;
  let nx = b.x + direction * SPEED_PX;

  if (nx <= minX) {
    nx = minX;
    direction = 1;
    windows.sendToPet('pet:wander', { active: true, dir: 'right' });
  } else if (nx >= maxX) {
    nx = maxX;
    direction = -1;
    windows.sendToPet('pet:wander', { active: true, dir: 'left' });
  }

  // 走 movePet 而不是 setPosition：后者在非 100% 缩放下会让窗口越移越大
  windows.movePet(nx, b.y);
}

function stop() {
  clearInterval(ticker);
  ticker = null;
  const wasBusy = busy;
  busy = false;
  if (wasBusy) {
    windows.sendToPet('pet:wander', { active: false });
    dbg('[wander] 结束');
  }
  schedule();
}

/** 临时按住：拖动、手动操作之后让它消停一会儿 */
function hold(ms = 6000) {
  holdUntil = Date.now() + ms;
  if (busy) stop();
}

function start() {
  schedule(12000);
}

/** 立刻走一趟（右键菜单「走两步」用） */
function nudge() {
  holdUntil = 0;
  if (busy) return false;
  clearTimeout(scheduler);
  scheduler = null;
  tryStart();
  return true;
}

function stopAll() {
  clearInterval(ticker);
  clearTimeout(scheduler);
  ticker = null;
  scheduler = null;
  if (busy) windows.sendToPet('pet:wander', { active: false });
  busy = false;
}

/** 配置变更后重新评估是否允许漫游 */
function refresh() {
  if (!allowed()) {
    stopAll();
  } else if (!scheduler && !busy) {
    schedule();
  }
}

module.exports = { start, stop: stopAll, hold, refresh, nudge, isBusy: () => busy };
