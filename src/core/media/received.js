'use strict';
/**
 * 「收到的素材库」数据层——读服务器 media_lib.py 产出的 library.jsonl。
 *
 * 和同目录的 library.js 是两件事，别混：
 *   library.js   media/pics/  主动挑选**发出去**用的表情包（388 张现成素材）
 *   received.js  media/received/  从 QQ/微信**收进来**的媒体存档 + 内容理解
 *
 * 服务器端负责去重、分类、视觉描述、语音转写、文件正文提取；这里只做读和筛选。
 * 本地没有对应文件时（大文件没同步、或还没同步过）也要能列出条目，
 * 面板显示占位，不能整条消失——「收到过一个 60MB 视频」本身就是信息。
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { dataDir } = require('../paths');

const KIND_LABEL = {
  image: '图片', sticker: '表情包', voice: '语音',
  video: '视频', file: '文件', other: '其他'
};
const KIND_ORDER = ['sticker', 'image', 'voice', 'video', 'file', 'other'];

function root() {
  return path.join(dataDir(), 'media', 'received');
}

function indexFile() {
  return path.join(root(), 'library.jsonl');
}

function mdFile() {
  return path.join(root(), '素材库.md');
}

/** 读索引。进程内加个短缓存：翻页/搜索时不用反复解析几千行。 */
let cache = null;
let cacheAt = 0;
const CACHE_MS = 3000;

function load(force = false) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_MS) return cache;
  const rows = [];
  try {
    const txt = fs.readFileSync(indexFile(), 'utf8');
    for (const line of txt.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        rows.push(JSON.parse(s));
      } catch {
        /* 半行跳过：进程被杀时常见 */
      }
    }
  } catch {
    /* 还没有索引 = 空库，不是错误 */
  }
  cache = rows;
  cacheAt = now;
  return rows;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date((Number(ts) + 8 * 3600) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function human(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 搜索命中范围：描述、标签、正文、文件名、会话名、来源人 */
function haystack(r) {
  return [
    r.desc, (r.tags || []).join(' '), r.text, r.name, r.chat, r.why,
    KIND_LABEL[r.kind] || '', r.msgkind ? KIND_LABEL[r.msgkind] || '' : ''
  ].filter(Boolean).join(' ').toLowerCase();
}

function view(r) {
  const abs = path.join(root(), String(r.file || '').replace(/\//g, path.sep));
  let local = false;
  let url = '';
  try {
    local = fs.existsSync(abs);
  } catch {
    local = false;
  }
  if (local) url = pathToFileURL(abs).href;
  return {
    sha: r.sha,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind] || r.kind || '其他',
    file: r.file,
    size: r.size,
    sizeText: human(r.size),
    local,
    url,
    t: r.t || 0,
    time: fmtTime(r.t),
    platform: r.platform || '',
    chat: r.chat || '',
    name: r.name || '',
    msgkind: r.msgkind || '',
    desc: r.desc || '',
    tags: Array.isArray(r.tags) ? r.tags : [],
    text: String(r.text || '').slice(0, 800),
    note: r.note || '',
    why: r.why || '',
    sources: (r.users || []).length
  };
}

function stats() {
  const rows = load();
  const counts = {};
  for (const r of rows) counts[r.kind || 'other'] = (counts[r.kind || 'other'] || 0) + 1;
  return {
    total: rows.length,
    counts,
    parts: KIND_ORDER.filter((k) => counts[k]).map((k) => ({
      kind: k, label: KIND_LABEL[k], count: counts[k]
    }))
  };
}

/**
 * 列素材。kind='all' 或空 = 全部；q 为关键词（描述/标签/正文/来源）。
 * 默认按时间倒序——最近收到的排在前面最符合直觉。
 */
function list(opts = {}) {
  const rows = load();
  const kind = String(opts.kind || 'all');
  const q = String(opts.q || '').trim().toLowerCase();
  let out = rows;
  if (kind !== 'all') out = out.filter((r) => (r.kind || 'other') === kind);
  if (q) {
    const parts = q.split(/\s+/).filter(Boolean);
    out = out.filter((r) => {
      const h = haystack(r);
      return parts.every((p) => h.includes(p));
    });
  }
  out = out.slice().sort((a, b) => (b.t || 0) - (a.t || 0));
  const limit = Math.max(1, Math.min(Number(opts.limit) || 400, 2000));
  return {
    stats: stats(),
    matched: out.length,
    items: out.slice(0, limit).map(view)
  };
}

/** 素材库根目录，给「打开文件夹」用 */
function dir() {
  return root();
}

module.exports = {
  list, stats, load, view, dir, mdFile, indexFile, KIND_LABEL, KIND_ORDER, fmtTime
};
