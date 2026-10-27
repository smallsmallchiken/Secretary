'use strict';

const fs = require('fs');
const path = require('path');
const { app, Notification } = require('electron');

/**
 * 本地提醒。持久化到 .data/reminders.json，重启不丢。
 */

let filePath = null;
let timers = new Map();
let onFire = null;
let seq = 1;

function resolvePath() {
  if (filePath) return filePath;
  const base = app.isPackaged ? app.getPath('userData') : path.join(app.getAppPath(), '.data');
  fs.mkdirSync(base, { recursive: true });
  filePath = path.join(base, 'reminders.json');
  return filePath;
}

function readAll() {
  try {
    const p = resolvePath();
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(list) {
  fs.writeFileSync(resolvePath(), JSON.stringify(list, null, 2), 'utf8');
}

const MAX_DELAY = 2147483647; // Node setTimeout 上限，约 24.8 天

function schedule(item) {
  const existing = timers.get(item.id);
  if (existing) clearTimeout(existing);
  timers.delete(item.id);

  const delay = new Date(item.at).getTime() - Date.now();
  if (delay <= 0) {
    fire(item.id);
    return;
  }
  // 超过上限就分段等待，到点前再确认一次，避免被截断成立即触发
  const timer = setTimeout(() => {
    if (new Date(item.at).getTime() - Date.now() > 1000) schedule(item);
    else fire(item.id);
  }, Math.min(delay, MAX_DELAY));
  timers.set(item.id, timer);
}

function fire(id) {
  const list = readAll();
  const item = list.find((x) => x.id === id);
  timers.delete(id);
  if (!item) return;

  // 从存储里移除
  writeAll(list.filter((x) => x.id !== id));
  console.log('[reminder] 触发：', item.text);

  try {
    if (Notification.isSupported()) {
      new Notification({ title: '⏰ 提醒', body: item.text, timeoutType: 'never' }).show();
    }
  } catch (err) {
    console.warn('[reminder] 系统通知发不出去：', err.message);
  }

  if (typeof onFire === 'function') {
    try {
      onFire(item);
    } catch (err) {
      console.error('[reminder] 回调失败：', err.stack || err.message);
    }
  }
}

const CATCH_UP_MS = 24 * 3600 * 1000; // 逾期不到 24 小时的提醒，启动时补发一次

/**
 * 补发一条已经过了时间的提醒。
 * 它这时已经从存储里移除了（所以不会重复补发），这里只负责通知和回调。
 */
function fireMissed(item) {
  console.log('[reminder] 补发逾期提醒：', item.text);

  try {
    if (Notification.isSupported()) {
      new Notification({
        title: '⏰ 提醒（已经过了时间）',
        body: item.text,
        timeoutType: 'never'
      }).show();
    }
  } catch (err) {
    console.warn('[reminder] 系统通知发不出去：', err.message);
  }

  if (typeof onFire === 'function') {
    try {
      // text 上带个标记：气泡面板不用改也能看出这条是补发的
      onFire({ ...item, missed: true, text: `${item.text}（已经过了时间）` });
    } catch (err) {
      console.error('[reminder] 回调失败：', err.stack || err.message);
    }
  }
}

function init(callback) {
  onFire = callback;
  const list = readAll();
  const now = Date.now();
  const alive = [];
  const missed = [];
  for (const item of list) {
    const at = new Date(item.at).getTime();
    if (at > now) {
      alive.push(item);
      schedule(item);
    } else if (now - at <= CATCH_UP_MS) {
      // 到点时桌宠没开着：补发一次，而不是静默丢掉
      missed.push(item);
    }
    // 逾期超过 24 小时的直接丢弃
  }
  if (alive.length !== list.length) writeAll(alive);
  for (const item of missed) fireMissed(item);
  return alive;
}

function add(text, at) {
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) throw new Error('时间格式不对');
  if (when.getTime() <= Date.now()) throw new Error('这个时间已经过去了');

  const id = String(seq++) + '-' + Date.now();
  const item = { id, text: String(text), at: when.toISOString(), createdAt: new Date().toISOString() };
  const list = readAll();
  list.push(item);
  writeAll(list);
  schedule(item);

  return { ok: true, message: `好的，${formatWhen(when)}提醒你${text}`, data: item };
}

function formatWhen(d) {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm} `;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm} `;
}

function list() {
  return readAll().map((x) => ({ ...x, local: formatWhen(new Date(x.at)) }));
}

function cancel(id) {
  const list = readAll();
  const item = list.find((x) => x.id === id);
  if (!item) throw new Error('没有这条提醒');
  if (timers.has(id)) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }
  writeAll(list.filter((x) => x.id !== id));
  return { ok: true, message: `已取消提醒：${item.text}` };
}

function cancelByText(text) {
  const key = String(text || '').trim();
  if (!key) throw new Error('要取消哪条提醒？');
  const list = readAll();
  const hits = list.filter((x) => String(x.text).includes(key));
  if (!hits.length) throw new Error(`没有找到包含「${key}」的提醒`);
  for (const item of hits) {
    if (timers.has(item.id)) {
      clearTimeout(timers.get(item.id));
      timers.delete(item.id);
    }
  }
  writeAll(list.filter((x) => !hits.some((h) => h.id === x.id)));
  return { ok: true, message: `已取消 ${hits.length} 条提醒：${hits.map((h) => h.text).join('、')}` };
}

function clearAll() {
  const n = readAll().length;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  writeAll([]);
  return { ok: true, message: `已清空 ${n} 条提醒` };
}

module.exports = { init, add, list, cancel, cancelByText, clearAll, formatWhen };
