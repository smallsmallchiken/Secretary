'use strict';
/**
 * 未读消息红点。
 *
 * 用户要求：桌宠右上角要出现红点提醒「有几条新消息」，点一下消失。
 *
 * 数据源 = 本地归档（QQ .data/archive/*.jsonl + 微信 .data/archive/wechat/*.jsonl）。
 * 归档只收私聊（群聊在服务器上就被过滤了），所以红点数就是「新私聊消息数」。
 *
 * 「已看到」的记号是 .data/unread.json 的 lastSeen（已看过的最新消息时间戳）：
 *   - 点红点 → lastSeen 推到最新 → 数出来是 0，红点消失；
 *   - 之后服务器又来新消息 → 归档多出新行 → 数出来 >0 → 红点再亮。
 *
 * 为什么数归档而不数清单待办：待办是模型提炼过的语义结果，一天几条；
 * 红点要的是「有消息来了」的原始信号，数归档行最直接、也最不容易漏。
 *
 * 首次启用（unread.json 不存在）时做一次基线：把 lastSeen 设为本地归档里
 * 最新一条的时间，否则装机第一天历史消息会全部算成未读。
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');
const { dbg } = require('./debug');

function stateFile() {
  return path.join(dataDir(), 'unread.json');
}

function loadState() {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (d && typeof d.lastSeen === 'number') return d;
  } catch {
    /* 不存在/损坏都当首次启用 */
  }
  return { lastSeen: 0 };
}

function saveState(st) {
  const f = stateFile();
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, f);
}

/** 归档行里的最大时间戳（本地时间是 epoch 秒） */
function newestOf(rows) {
  let m = 0;
  for (const r of rows) {
    const t = Number(r && r.t) || 0;
    if (t > m) m = t;
  }
  return m;
}

function allRows() {
  const memo = require('./memo'); // 延迟 require，避免启动顺序耦合
  return memo.readQQ().concat(memo.readWX());
}

/** 统计 lastSeen 之后新进来的消息（不含我自己发的），上限 99 */
function countUnread() {
  const st = loadState();
  const cut = st.lastSeen || 0;
  let n = 0;
  let newest = 0;
  for (const r of allRows()) {
    const t = Number(r.t) || 0;
    if (t > newest) newest = t;
    if (t > cut && !r.me) n += 1;
  }
  return { count: Math.min(n, 99), total: n, newest, lastSeen: cut };
}

/** 首次启用：把 lastSeen 设为本地归档最新一条，历史消息不算未读 */
function baselineIfEmpty() {
  const st = loadState();
  if (st.lastSeen) return false;
  const newest = newestOf(allRows());
  if (newest) {
    saveState({ lastSeen: newest, updatedAt: Math.floor(Date.now() / 1000) });
    dbg('[unread] 基线：lastSeen =', newest);
  }
  return true;
}

/** 点红点：lastSeen 推到现在，红点归零 */
function markSeen() {
  const st = loadState();
  const newest = Math.max(newestOf(allRows()), Math.floor(Date.now() / 1000));
  st.lastSeen = newest;
  st.updatedAt = Math.floor(Date.now() / 1000);
  saveState(st);
  dbg('[unread] 已查看，lastSeen =', newest);
  return { count: 0, lastSeen: st.lastSeen };
}

/**
 * 拉一次服务器归档 + 每日清单（都拉成功与否不影响统计，拉失败用本地数据算）。
 * 复用 memory.sync() 的单飞 Promise，避免和聊天查询抢同一个 SSH 同步。
 */
function syncRemote() {
  const memory = require('./tools/memory');
  const { execFile } = require('child_process');
  const root = path.join(__dirname, '..', '..');

  const pArchive = memory.sync(); // sync-archive.py，已有单飞
  const pDaily = new Promise((resolve) => {
    const script = path.join(root, 'tools', 'sync-daily.py');
    if (!fs.existsSync(script)) {
      resolve({ ok: false, reason: '缺少 tools/sync-daily.py' });
      return;
    }
    execFile(memory.resolvePython(), [script], { encoding: 'utf8', timeout: 60000, windowsHide: true }, (err) => {
      resolve(err ? { ok: false, reason: err.message } : { ok: true });
    });
  });
  return Promise.all([pArchive, pDaily]).then(([a, d]) => {
    if (!a.ok) dbg('[unread] 归档同步失败:', a.reason || '');
    if (!d.ok) dbg('[unread] 清单同步失败:', d.reason || '');
    return a.ok || d.ok;
  });
}

module.exports = { countUnread, markSeen, baselineIfEmpty, syncRemote };
