'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const notes = require('./notes');
const archive = require('../qq/archive');
const { dbg } = require('../debug');

/**
 * 「记事 + 查聊天记录」。用户的原话是：帮我记事，后面我直接问就行。
 *
 * 两块数据源：
 *   1. notes.js   —— 他主动让我记的事（本地 .data/notes.jsonl）
 *   2. QQ 归档    —— 服务器上自动落盘的聊天流水（走 SSH 查，见 tools/remote-chatlog.py）
 *
 * 为什么要跨机器：消息是服务器上的 NapCat 收的，归档也在那边；
 * 桌宠跑在 Windows，中间没有通道，所以用 SSH 跑一条命令把结果取回来。
 * 不开端口、不额外起服务。
 */

const ROOT = path.join(__dirname, '../../..');

/** 找 python：配置里指定的 > PATH 里的 > 本机已知位置。找到就用，找不到给一句人话。 */
function resolvePython() {
  const configured = config.get('pythonPath');
  if (configured && fs.existsSync(configured)) return configured;

  const candidates = [
    process.env.PET_PYTHON,
    'python',
    'python3',
    'C:\\Users\\18535\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
  ].filter(Boolean);

  for (const c of candidates) {
    if (c.includes('\\') || c.includes('/')) {
      if (fs.existsSync(c)) return c;
    } else {
      return c; // 靠 PATH 找，跑失败会由调用处报出来
    }
  }
  return 'python';
}

/** 跑一次远端查询，返回解析好的对象。永远不抛，失败了给 {ok:false, reason}。 */
function remoteQuery(args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const py = resolvePython();
    const script = path.join(ROOT, 'tools', 'remote-chatlog.py');
    if (!fs.existsSync(script)) {
      resolve({ ok: false, reason: '找不到 tools/remote-chatlog.py' });
      return;
    }
    execFile(py, [script, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      if (!out) {
        dbg('[memory] 远端查询没输出:', err ? err.message : '', String(stderr || '').slice(0, 200));
        resolve({ ok: false, reason: err ? `查询失败：${err.message}` : '远端没有返回内容' });
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        dbg('[memory] 远端输出不是 JSON:', out.slice(0, 200));
        resolve({ ok: false, reason: '远端返回格式不对' });
      }
    });
  });
}

/** 记一件事 */
function remember(text, tags) {
  const r = notes.add(text, { tags });
  return r;
}

/* ------------------------------------------------------------------ */
/* 聊天归档：本地缓存优先，查不到才回服务器                               */
/* ------------------------------------------------------------------ */

const SYNC_PY = path.join(ROOT, 'tools', 'sync-archive.py');
let lastSyncAt = 0;
let syncing = null;

/** 同步一次服务器归档到本地。同一时间只跑一个，重复调用共用同一个 Promise。 */
function sync(maxAgeMs = 0) {
  if (maxAgeMs && Date.now() - lastSyncAt < maxAgeMs) return Promise.resolve({ ok: true, skipped: true });
  if (syncing) return syncing;

  syncing = new Promise((resolve) => {
    if (!fs.existsSync(SYNC_PY)) {
      resolve({ ok: false, reason: '找不到 tools/sync-archive.py' });
      return;
    }
    execFile(resolvePython(), [SYNC_PY, '--quiet'], { encoding: 'utf8', timeout: 60000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '').trim();
      let r;
      try {
        r = JSON.parse(out);
      } catch {
        r = { ok: false, reason: err ? err.message : '同步没有输出' };
      }
      if (r.ok) lastSyncAt = Date.now();
      else dbg('[memory] 归档同步失败:', r.reason);
      resolve(r);
    });
  }).finally(() => {
    syncing = null;
  });

  return syncing;
}

/** 查本地归档缓存。返回 archive.query 的行。 */
function localRows(opts) {
  try {
    return archive.query({
      who: opts.who,
      keyword: opts.q,
      from: opts.from,
      to: opts.to,
      type: opts.chatType,
      limit: opts.limit === 0 ? 0 : Number(opts.limit) || 100
    });
  } catch (err) {
    dbg('[memory] 查本地归档出错:', err.message);
    return [];
  }
}

/**
 * 查聊天记录。
 * 顺序：本地缓存 → 查不到就同步一次再查 → 还不行才 SSH 实时查（慢，但能拿到最新的）。
 * 绝大多数问题本地就能答，毫秒级；只有「刚发的消息」或者本地压根没同步过才会走慢路径。
 */
async function chatLog(opts = {}) {
  // 后台刷新：不 await。这次先用本地现有数据回答，下次查就是新的。
  // 等它反而把毫秒级的查询拖回五六秒，用户只会觉得「问个事卡半天」。
  if (Date.now() - lastSyncAt > 10 * 60 * 1000) sync().catch(() => {});

  let rows = localRows(opts);
  let via = 'local';

  if (!rows.length) {
    const s = await sync();
    if (s.ok && !s.skipped) {
      rows = localRows(opts);
      via = 'local-after-sync';
    }
    if (!rows.length) {
      // 本地确实没有：可能是缓存太旧、或者条件太刁钻，回服务器实时查一遍
      const args = ['--limit', String(opts.limit || 30)];
      if (opts.q) args.push('--q', String(opts.q));
      if (opts.who) args.push('--who', String(opts.who));
      if (opts.from) args.push('--from', String(opts.from));
      if (opts.to) args.push('--to', String(opts.to));
      if (opts.chatType) args.push('--type', String(opts.chatType));

      const r = await remoteQuery(args);
      if (r.ok) return { ok: true, count: r.count || 0, text: r.text || '', range: r.range || '', via: 'remote' };
      return { ok: false, reason: r.reason, via: 'remote' };
    }
  }

  const text = archive.render(rows);
  const range = rows.length ? `${archive.fmtTime(rows[0].t)} ~ ${archive.fmtTime(rows[rows.length - 1].t)}` : '';
  return { ok: true, count: rows.length, text, range, via };
}

/**
 * 查。scope: 'notes' 只查记事本 / 'chat' 只查聊天记录 / 'all' 两边都查（默认）
 * 返回 { ok, message, data: { notes: [...], chat: {...} } }
 */
async function recall(opts = {}) {
  const scope = opts.scope || 'all';
  const q = String(opts.q || '').trim();
  const limit = Math.min(Number(opts.limit) || 30, 100);
  const out = { ok: true, data: { notes: [], chat: null } };
  const parts = [];

  if (scope === 'notes' || scope === 'all') {
    try {
      const rows = notes.query({ q, from: opts.from, to: opts.to, tag: opts.tag, limit });
      out.data.notes = rows;
      if (rows.length) {
        parts.push(`【我让你记的事】\n${notes.render(rows)}`);
      } else if (scope === 'notes') {
        parts.push('记事本里没有符合条件的记录。');
      }
    } catch (err) {
      parts.push(`查记事本出错：${err.message}`);
    }
  }

  if (scope === 'chat' || scope === 'all') {
    const r = await chatLog({ q, who: opts.who, from: opts.from, to: opts.to, chatType: opts.chatType, limit });
    out.data.chat = r;
    if (r.ok && r.count) {
      parts.push(`【QQ 聊天记录】${r.range}\n${r.text}`);
    } else if (r.ok) {
      if (scope === 'chat') parts.push('聊天记录里没搜到。');
    } else {
      // 查不到要说清楚原因，别让用户以为「就是没有」
      parts.push(`（聊天记录没能查到：${r.reason || '未知原因'}）`);
    }
  }

  const text = parts.filter(Boolean).join('\n\n');
  out.message = text || '没查到相关记录。';
  return out;
}

/** 归档统计：多少条、覆盖哪些天、跟谁聊得多 */
async function stats() {
  const r = await remoteQuery(['--mode', 'stats'], 25000);
  if (!r.ok) return { ok: false, message: `查不了归档：${r.reason || '未知原因'}` };
  return { ok: true, message: r.text, data: r.text };
}

module.exports = { remember, recall, chatLog, stats, sync, remoteQuery, resolvePython };
