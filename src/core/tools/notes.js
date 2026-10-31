'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../paths');

/**
 * 记事本。用户说「记一下 xxx」就往这里存，以后问「我这周有什么事」再翻出来。
 *
 * 跟 QQ 聊天归档（src/core/qq/archive.js）是两套东西：
 *   - 这个是他**主动交代**要记住的事，一条一条，精而少
 *   - 那个是**自动落盘**的聊天流水，靠 grep 找
 * 查的时候两边一起查，但分开存 —— 混在一起会让「我让你记的事」淹在闲聊里。
 *
 * 存储：`.data/notes.jsonl`，一行一条，追加写。
 *   { id, t, text, tags, done }
 */

function file() {
  return path.join(dataDir(), 'notes.jsonl');
}

function readAll() {
  try {
    const p = file();
    if (!fs.existsSync(p)) return [];
    const out = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 半行跳过 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(list) {
  const p = file();
  fs.writeFileSync(p, list.map((x) => JSON.stringify(x)).join('\n') + (list.length ? '\n' : ''), 'utf8');
}

function nextId() {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 记一条。tags 可以是数组或「工作,急」这种字符串。 */
function add(text, opts = {}) {
  const body = String(text || '').trim();
  if (!body) throw new Error('要记什么？内容不能是空的');

  let tags = opts.tags || opts.tag || [];
  if (typeof tags === 'string') tags = tags.split(/[,，、\s]+/).filter(Boolean);

  const item = {
    id: nextId(),
    t: Math.floor(Date.now() / 1000),
    text: body,
    tags: [...new Set(tags.map((x) => String(x).trim()).filter(Boolean))].slice(0, 5),
    done: false
  };
  fs.appendFileSync(file(), JSON.stringify(item) + '\n');
  return { ok: true, message: `记住了：${body}`, data: item };
}

/** 把 'YYYY-MM-DD' 或 '3天前' 这种说法变成秒级时间戳 */
function parseWhen(v, isEnd = false) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    return Math.floor((d.getTime() + (isEnd ? 86399000 : 0)) / 1000);
  }
  const m = s.match(/^(\d+)\s*(天|日|周|月)前$/);
  if (m) {
    const n = Number(m[1]);
    const days = m[2] === '月' ? n * 30 : m[2] === '周' ? n * 7 : n;
    return Math.floor(Date.now() / 1000) - days * 86400;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

/**
 * 中文的「搜得到」比英文难：记事写的是「周五要把设计稿交上去」，
 * 用户问的是「交稿」，子串根本对不上。所以放两级宽松：
 *   - 原样子串命中：最准
 *   - 2 字词：任意一个字在就行（「交稿」→ 有「交」就算）
 *   - 3 字以上：拆成相邻两字的片段，命中一半以上算
 * 宁可多给几条让他自己挑，也别该命中的查不出来 —— 记事本条目本来就不多。
 */
function looseMatch(hay, word) {
  if (!word) return true;
  if (hay.includes(word)) return true;
  if (word.length === 2) return [...word].some((ch) => hay.includes(ch));
  if (word.length >= 3) {
    const grams = [];
    for (let i = 0; i < word.length - 1; i++) grams.push(word.slice(i, i + 2));
    const hit = grams.filter((g) => hay.includes(g)).length;
    return hit / grams.length >= 0.5;
  }
  return false;
}

/**
 * 查。
 *   q      关键词（多个空格分隔=都要命中）
 *   from/to 时间范围，支持 '2026-10-25' / '7天前'
 *   tag    按标签
 *   limit  默认 50
 */
function query(opts = {}) {
  const words = String(opts.q || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const from = parseWhen(opts.from, false);
  const to = parseWhen(opts.to, true);
  const tag = String(opts.tag || '').trim().toLowerCase();

  let rows = readAll();
  if (from) rows = rows.filter((r) => r.t >= from);
  if (to) rows = rows.filter((r) => r.t <= to);
  if (tag) rows = rows.filter((r) => (r.tags || []).some((x) => x.toLowerCase().includes(tag)));
  if (opts.undone) rows = rows.filter((r) => !r.done);
  if (words.length) {
    rows = rows.filter((r) => {
      const hay = `${r.text} ${(r.tags || []).join(' ')}`.toLowerCase();
      return words.every((w) => looseMatch(hay, w));
    });
  }
  rows.sort((a, b) => a.t - b.t);
  const limit = opts.limit === 0 ? 0 : Number(opts.limit) || 50;
  return limit && rows.length > limit ? rows.slice(-limit) : rows;
}

/** 标记完成（按 id 或关键词） */
function markDone(key) {
  const k = String(key || '').trim();
  if (!k) throw new Error('要标记哪条？');
  const list = readAll();
  const hit = list.find((x) => x.id === k) || list.filter((x) => x.text.includes(k)).pop();
  if (!hit) throw new Error(`没找到「${k}」`);
  hit.done = true;
  writeAll(list);
  return { ok: true, message: `标记完成：${hit.text}`, data: hit };
}

function remove(key) {
  const k = String(key || '').trim();
  if (!k) throw new Error('要删哪条？');
  const list = readAll();
  const hits = list.filter((x) => x.id === k || x.text.includes(k));
  if (!hits.length) throw new Error(`没找到「${k}」`);
  writeAll(list.filter((x) => !hits.includes(x)));
  return { ok: true, message: `删掉了 ${hits.length} 条：${hits.map((h) => h.text).join('、')}` };
}

/** 北京时间的 MM-DD HH:mm */
function fmt(ts) {
  const d = new Date((Number(ts) + 8 * 3600) * 1000);
  return d.toISOString().slice(5, 16).replace('T', ' ');
}

function render(rows) {
  return rows.map((r) => `${fmt(r.t)} ${r.done ? '[已办] ' : ''}${r.text}${r.tags && r.tags.length ? ` (${r.tags.join('/')})` : ''}`).join('\n');
}

module.exports = { add, query, readAll, markDone, remove, render, fmt, parseWhen, file };
