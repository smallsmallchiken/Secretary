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

function schedule(item) {
  const delay = new Date(item.at).getTime() - Date.now();
  if (delay <= 0) return;
  const timer = setTimeout(() => fire(item.id), delay);
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

function init(callback) {
  onFire = callback;
  const list = readAll();
  const now = Date.now();
  const alive = [];
  for (const item of list) {
    if (new Date(item.at).getTime() > now) {
      alive.push(item);
      schedule(item);
    }
  }
  if (alive.length !== list.length) writeAll(alive);
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

function clearAll() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  writeAll([]);
  return { ok: true, message: '已清空所有提醒' };
}

module.exports = { init, add, list, cancel, clearAll, formatWhen };
