#!/usr/bin/env node
'use strict';
/**
 * 从 NapCat 回捞历史消息，灌进本地归档。
 *
 * 用途：NapCat 只在「它在线并且这个会话被打开过」时才缓存消息，
 * 容器重启、或者某个好友很久没聊，那段就是我们没存到的洞。
 * 这个脚本把所有好友 + 所有群能拿到的那部分拉一遍，补进 .data/archive/。
 *
 *   node tools/qq-backfill.js              # 全量补
 *   node tools/qq-backfill.js --dry        # 只看能捞到多少，不写盘
 *   node tools/qq-backfill.js --count 200  # 每个会话最多拉多少（默认 500，实际给多少看 NapCat）
 *
 * 注意：NapCat 给的历史深度很有限（实测私聊只回 34 条、群聊 20 条，
 * 拿最早那条的 seq 往前翻会直接「消息不存在」），所以这个只能补近几天的洞，
 * 不是「下载全部历史」。真正的长期记录靠的是在线时的实时落盘。
 */

const path = require('path');
const fs = require('fs');
const WebSocket = require('../node_modules/ws');
const archive = require('../src/core/qq/archive');
const config = require('../src/core/config');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const COUNT = (() => {
  const i = argv.indexOf('--count');
  return i >= 0 ? Number(argv[i + 1]) || 500 : 500;
})();

const cfg = config.get('qq', {}) || {};
const url = cfg.wsUrl || 'ws://127.0.0.1:3001';
const token = cfg.token || '';
const selfId = String(cfg.selfId || '');

const ws = new WebSocket(url, token ? { headers: { Authorization: 'Bearer ' + token } } : {});
let seq = 0;
const pending = new Map();

function call(action, params = {}, timeout = 20000) {
  return new Promise((resolve) => {
    const echo = String(++seq);
    pending.set(echo, resolve);
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.has(echo)) {
        pending.delete(echo);
        resolve({ status: 'timeout', data: null });
      }
    }, timeout);
  });
}

ws.on('message', (buf) => {
  let m;
  try {
    m = JSON.parse(buf.toString());
  } catch {
    return;
  }
  if (m.echo && pending.has(String(m.echo))) {
    pending.get(String(m.echo))(m);
    pending.delete(String(m.echo));
  }
});

/** 已经存过的 mid，回捞时跳过 */
function knownMids() {
  const set = new Set();
  for (const day of archive.days()) {
    let raw = '';
    try {
      raw = fs.readFileSync(archive.fileOf(day), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.mid) set.add(`${r.c}:${r.id}:${r.mid}`);
      } catch {
        /* 半行忽略 */
      }
    }
  }
  return set;
}

function normalize(msg, kind, chat) {
  // 把 NapCat 返回的一条消息改写成归档记录的形状（跟 fromEvent 保持一致）
  const sender = msg.sender || {};
  let text = '';
  const kinds = [];
  if (Array.isArray(msg.message)) {
    for (const seg of msg.message) {
      if (!seg || !seg.type) continue;
      if (seg.type === 'text') text += (seg.data && seg.data.text) || '';
      else if (seg.type === 'at') text += `@${(seg.data && seg.data.qq) || ''}`;
      else kinds.push(seg.type);
    }
  }
  if (!text && typeof msg.raw_message === 'string') text = msg.raw_message.replace(/\[CQ:[^\]]*\]/g, '').trim();
  return {
    t: Number(msg.time) || Math.floor(Date.now() / 1000),
    c: kind,
    id: String(chat.id),
    n: String(chat.name || '').slice(0, 40),
    s: String(msg.user_id || ''),
    sn: String(sender.card || sender.nickname || '').slice(0, 40),
    me: String(msg.user_id) === selfId || !!msg.self_id && String(msg.user_id) === String(msg.self_id),
    x: text.slice(0, 1000),
    k: kinds.length ? kinds.join('+') : 'text',
    mid: Number(msg.message_seq || msg.message_id || 0)
  };
}

async function pull(kind, chat) {
  const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
  const params = kind === 'group' ? { group_id: chat.id, count: COUNT } : { user_id: chat.id, count: COUNT };
  const r = await call(action, params);
  const msgs = (r && r.data && r.data.messages) || [];
  return msgs;
}

ws.on('open', async () => {
  const seen = knownMids();
  const login = await call('get_login_info');
  const me = login && login.data && login.data.user_id ? String(login.data.user_id) : selfId;
  console.log(`已连接 ${url}，登录 ${me}；已知归档 ${seen.size} 条，回捞上限 ${COUNT} 条/会话${DRY ? '（试跑，不写盘）' : ''}\n`);

  const friends = ((await call('get_friend_list')).data || []).map((f) => ({
    id: f.user_id,
    name: f.remark || f.nickname || String(f.user_id)
  }));
  const groups = ((await call('get_group_list')).data || []).map((g) => ({
    id: g.group_id,
    name: g.group_name || String(g.group_id)
  }));

  console.log(`好友 ${friends.length} 个，群 ${groups.length} 个\n`);

  let added = 0;
  let scanned = 0;
  const rows = [];

  for (const [kind, list] of [['private', friends], ['group', groups]]) {
    for (const chat of list) {
      const msgs = await pull(kind, chat);
      scanned += msgs.length;
      let n = 0;
      for (const msg of msgs) {
        const rec = normalize(msg, kind, chat);
        const key = `${rec.c}:${rec.id}:${rec.mid}`;
        if (rec.mid && seen.has(key)) continue;
        if (rec.mid) seen.add(key);
        if (!DRY) archive.append(rec);
        n += 1;
      }
      if (n) {
        added += n;
        rows.push(`  ${kind === 'group' ? '群' : '私'} ${chat.name}(${chat.id}) +${n} 条`);
      }
      // 别把 NapCat 打爆：每个会话之间歇一下
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  console.log(rows.slice(0, 40).join('\n'));
  if (rows.length > 40) console.log(`  …… 另外 ${rows.length - 40} 个会话也有新增`);
  console.log(`\n扫描 ${scanned} 条，新归档 ${added} 条${DRY ? '（未写盘）' : ''}`);
  const all = archive.query({ limit: 0 });
  console.log(`归档现在共 ${all.length} 条，覆盖 ${archive.days().join(', ') || '（空）'}`);
  ws.close();
  process.exit(0);
});

ws.on('error', (e) => {
  console.error('连不上 NapCat：', e.message);
  console.error('确认 NapCat 在跑、qq.wsUrl / qq.token 对不对（本地跑要连服务器的 3001，那端口对外是关的）。');
  process.exit(1);
});

setTimeout(() => {
  console.error('超时退出');
  process.exit(1);
}, 10 * 60 * 1000);
