'use strict';
/**
 * QQ 聊天记录归档。
 *
 * 为什么要有这个：NapCat 的 get_friend_msg_history 只能翻到它自己在线期间的缓存
 * （实测 count 给 10/50/100/500 回的都是同样 34 条，拿最早那条的 seq 往前翻直接
 * 「消息不存在」），所以「回头去读完整历史」这条路是断的。唯一可靠的办法是
 * **收到消息的那一刻就落盘**，自己攒库。
 *
 * 存储：JSONL 按北京时区分天（`.data/archive/2026-10-31.jsonl`），零依赖
 * （容器里是 node 20，没有 node:sqlite）。一行一条，字段压成单字母：
 *
 *   t   时间戳（秒）        c   private / group
 *   id  会话 ID（好友QQ/群号） n  会话名（好友昵称/群名）
 *   s   发送者 ID           sn 发送者名
 *   me  是不是我发的        x  正文
 *   k   text/image/record/face/mface   mid 消息 ID（去重用）
 *
 * 查询见 tools/qq-archive.js，或者直接 query() 传条件。
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../paths');

const TZ_OFFSET = 8 * 3600; // 北京时间，分片按本地日期算，别用 UTC

function archiveDir() {
  const d = path.join(dataDir(), 'archive');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 时间戳 -> 北京时区的 YYYY-MM-DD */
function dayOf(tsSec) {
  const d = new Date((tsSec + TZ_OFFSET) * 1000);
  return d.toISOString().slice(0, 10);
}

function fileOf(day) {
  return path.join(archiveDir(), `${day}.jsonl`);
}

/** 记一条。失败一律吞掉：归档不能影响收发主链路。 */
function append(rec) {
  try {
    if (!rec || !rec.t) rec = Object.assign({ t: Math.floor(Date.now() / 1000) }, rec);
    const line = JSON.stringify(rec);
    fs.appendFileSync(fileOf(dayOf(rec.t)), line + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 OneBot 事件里抽一条归档记录。收消息和发消息共用，避免两处字段写歪。
 * who 省略时按消息类型自己推断。
 */
function fromEvent(event, opts = {}) {
  if (!event) return null;
  const isGroup = event.message_type === 'group';
  const chatId = String(isGroup ? event.group_id : event.user_id || '');
  const sender = event.sender || {};
  const selfId = String(opts.selfId || event.self_id || '');

  // 正文：文字直接拼；图片/语音/表情只留一个类型标记，正文太占地方且查不出东西
  let text = '';
  const kinds = [];
  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (!seg || !seg.type) continue;
      if (seg.type === 'text') text += (seg.data && seg.data.text) || '';
      else if (seg.type === 'at') text += `@${(seg.data && (seg.data.qq || '')) || ''}`;
      else kinds.push(seg.type);
    }
  }
  if (!text && !kinds.length && typeof event.raw_message === 'string') {
    text = event.raw_message.replace(/\[CQ:[^\]]*\]/g, '').trim();
  }

  return {
    t: Number(event.time) || Math.floor(Date.now() / 1000),
    c: isGroup ? 'group' : 'private',
    id: chatId,
    n: String(isGroup ? (event.group_name || opts.chatName || '') : sender.card || sender.nickname || opts.chatName || '').slice(0, 40),
    s: String(event.user_id || ''),
    sn: String(sender.card || sender.nickname || '').slice(0, 40),
    me: !!(selfId && String(event.user_id) === selfId),
    x: text.slice(0, 1000),
    k: kinds.length ? kinds.join('+') : 'text',
    mid: event.message_id || 0
  };
}

/** 列出归档里有哪些天（升序） */
function days() {
  try {
    return fs
      .readdirSync(archiveDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 查。全部条件都是可选的，AND 关系。
 *   from/to    北京日期 'YYYY-MM-DD'（含首含尾；to 省略=今天）
 *   who        会话 ID 或会话名，包含匹配
 *   keyword    正文关键词（不区分大小写），多个用空格分隔=都要命中
 *   type       'private' | 'group'
 *   me         true 只要我发的 / false 只要别人发的
 *   limit      最多返回多少条（默认 200，从新往旧截取后翻回正序）
 *   since/until 秒级时间戳，比 from/to 更精确
 */
function query(opts = {}) {
  const all = days();
  let list = all;
  if (opts.from) list = list.filter((d) => d >= opts.from);
  if (opts.to) list = list.filter((d) => d <= opts.to);
  if (!list.length && (opts.from || opts.to)) return [];

  const who = (opts.who || '').toString().trim().toLowerCase();
  const words = (opts.keyword || '')
    .toString()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  const seen = new Set();

  for (const day of list) {
    let raw;
    try {
      raw = fs.readFileSync(fileOf(day), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // 半行（进程被杀时写了一半）跳过，不要让整个查询失败
      }
      if (opts.since && r.t < opts.since) continue;
      if (opts.until && r.t > opts.until) continue;
      if (opts.type && r.c !== opts.type) continue;
      if (opts.me !== undefined && !!r.me !== !!opts.me) continue;
      if (who && !(String(r.id).includes(who) || String(r.n || '').toLowerCase().includes(who))) continue;
      if (words.length) {
        const hay = String(r.x || '').toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      if (r.mid) {
        const key = `${r.c}:${r.id}:${r.mid}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(r);
    }
  }

  out.sort((a, b) => a.t - b.t);
  const limit = opts.limit === 0 ? 0 : Number(opts.limit) || 200;
  return limit && out.length > limit ? out.slice(-limit) : out;
}

/** 汇总：每个会话最后一条是什么时候、聊了多少句。给「我和谁最近常聊」这类问题用。 */
function overview(opts = {}) {
  const rows = query(Object.assign({ limit: 0 }, opts));
  const map = new Map();
  for (const r of rows) {
    const key = `${r.c}:${r.id}`;
    let v = map.get(key);
    if (!v) {
      v = { type: r.c, id: r.id, name: r.n || '', first: r.t, last: r.t, count: 0, mine: 0 };
      map.set(key, v);
    }
    v.count += 1;
    if (r.me) v.mine += 1;
    if (r.t < v.first) v.first = r.t;
    if (r.t > v.last) {
      v.last = r.t;
      if (r.n) v.name = r.n; // 用最近一次看到的名字，改过昵称也能跟上
    }
  }
  return [...map.values()].sort((a, b) => b.last - a.last);
}

/** 给人看的时间：北京时间 MM-DD HH:mm */
function fmtTime(tsSec) {
  const d = new Date((Number(tsSec) + TZ_OFFSET) * 1000);
  return d.toISOString().slice(5, 16).replace('T', ' ');
}

/** 一批记录 -> 便于阅读的纯文本（我/他 标记，群聊带名字） */
function render(rows) {
  return rows
    .map((r) => {
      const stamp = fmtTime(r.t);
      const who = r.me ? '我' : r.c === 'group' ? r.sn || r.s || '?' : r.n || r.s || '对方';
      const body = r.x || (r.k && r.k !== 'text' ? `[${r.k}]` : '');
      return `${stamp} ${who}: ${body}`;
    })
    .join('\n');
}

module.exports = { append, fromEvent, query, overview, days, render, fmtTime, dayOf, fileOf, archiveDir };
