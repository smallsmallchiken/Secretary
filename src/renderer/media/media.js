'use strict';

/* 素材库面板：数据来自主进程 media:list（读服务器产出的 library.jsonl） */

const listEl = document.getElementById('list');
const tabsEl = document.getElementById('tabs');
const countEl = document.getElementById('count');
const qEl = document.getElementById('q');
const emptyEl = document.getElementById('empty');
const viewer = document.getElementById('viewer');
const viewerImg = document.getElementById('viewer-img');
const viewerInfo = document.getElementById('viewer-info');
const btnRefresh = document.getElementById('btn-refresh');
const btnDir = document.getElementById('btn-dir');

const KIND_ICON = {
  voice: '🎙', video: '🎬', file: '📄', other: '📦'
};
const KIND_TITLE = {
  sticker: '表情包', image: '图片', voice: '语音',
  video: '视频', file: '文件', other: '其他'
};

let state = { kind: 'all', q: '', items: [], stats: { total: 0, parts: [] }, matched: 0 };
let searchTimer = null;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderTabs() {
  tabsEl.innerHTML = '';
  const parts = state.stats.parts || [];
  const mk = (kind, label, n) => {
    const b = el('div', 'tab' + (state.kind === kind ? ' on' : ''));
    b.appendChild(document.createTextNode(label));
    if (n) b.appendChild(el('span', 'n', String(n)));
    b.addEventListener('click', () => {
      if (state.kind === kind) return;
      state.kind = kind;
      load();
    });
    return b;
  };
  tabsEl.appendChild(mk('all', '全部', state.stats.total));
  for (const p of parts) tabsEl.appendChild(mk(p.kind, p.label, p.count));
}

function renderCount() {
  const s = state.stats || {};
  const bits = (s.parts || []).map((p) => `${p.label} ${p.count}`);
  const tail = state.q ? ` ｜ 搜到 ${state.matched}` : '';
  countEl.textContent = `共 ${s.total || 0}${bits.length ? ' · ' + bits.join(' · ') : ''}${tail}`;
}

/** 图片/表情格子 */
function cellFor(it) {
  const c = el('div', 'cell');
  if (!it.local) {
    c.classList.add('missing');
    c.textContent = `未同步\n${it.sizeText}`;
    c.title = `${it.desc || it.name || it.file}\n本地还没有这个文件，点「同步」拉取`;
    return c;
  }
  const img = document.createElement('img');
  img.src = it.url;
  img.alt = it.desc || it.name || '';
  img.loading = 'lazy';
  c.appendChild(img);
  if (it.kind === 'sticker') {
    c.appendChild(el('div', 'badge', '表情'));
  } else if (it.msgkind) {
    c.appendChild(el('div', 'badge', (KIND_TITLE[it.msgkind] || '') + '截图'));
  }
  const cap = it.desc || it.name || it.chat || '';
  if (cap) c.appendChild(el('div', 'cap', cap));
  c.title = [it.desc, (it.tags || []).join(' / '), it.chat, it.time].filter(Boolean).join('\n');
  c.addEventListener('click', () => openViewer(it));
  return c;
}

/** 语音/视频/文件行 */
function rowFor(it) {
  const r = el('div', 'row');
  r.appendChild(el('div', 'ico', KIND_ICON[it.kind] || '📄'));
  const body = el('div', 'body');

  const l1 = el('div', 'line1');
  const title = it.name || it.desc || (KIND_TITLE[it.kind] || '素材');
  l1.appendChild(el('span', 'name', title));
  l1.appendChild(el('span', 'sz', it.sizeText));
  body.appendChild(l1);

  // 语音显示转写、文件显示正文摘要：这就是「能理解」的部分，
  // 只给一个文件名的清单没法用。
  const txt = it.text || it.desc || '';
  if (txt) {
    const t = el('div', 'txt', txt);
    body.appendChild(t);
  } else if (it.note) {
    body.appendChild(el('div', 'txt', it.note));
  }

  if (it.tags && it.tags.length) {
    const tg = el('div', 'tags');
    for (const t of it.tags.slice(0, 6)) tg.appendChild(el('span', 'tag', t));
    body.appendChild(tg);
  }

  const meta = [it.platform, it.chat, it.time].filter(Boolean).join(' · ');
  if (meta) body.appendChild(el('div', 'meta', meta));

  r.appendChild(body);
  return r;
}

function render() {
  renderTabs();
  renderCount();
  listEl.innerHTML = '';

  const items = state.items || [];
  if (!items.length) {
    emptyEl.classList.add('show');
    listEl.style.display = 'none';
    return;
  }
  emptyEl.classList.remove('show');
  listEl.style.display = '';

  // 按类别分组，图片类走网格、其余走行——混排会让看图很难受
  const groups = {};
  for (const it of items) {
    (groups[it.kind] = groups[it.kind] || []).push(it);
  }
  const order = ['sticker', 'image', 'voice', 'video', 'file', 'other'];
  for (const k of order) {
    const arr = groups[k];
    if (!arr || !arr.length) continue;
    if (state.kind === 'all') {
      const h = el('div', 'sec');
      h.style.cssText = 'font-size:11px;color:#7c8399;margin:10px 0 6px;letter-spacing:.4px';
      h.textContent = `${KIND_TITLE[k] || k} · ${arr.length}`;
      listEl.appendChild(h);
    }
    if (k === 'image' || k === 'sticker') {
      const g = el('div', 'grid');
      for (const it of arr) g.appendChild(cellFor(it));
      listEl.appendChild(g);
    } else {
      const wrap = el('div', 'rows');
      for (const it of arr) wrap.appendChild(rowFor(it));
      listEl.appendChild(wrap);
    }
  }
}

function openViewer(it) {
  if (!it.local) return;
  viewerImg.src = it.url;
  const bits = [];
  if (it.desc) bits.push(it.desc);
  if (it.name && it.name !== it.desc) bits.push(it.name);
  if (it.tags && it.tags.length) bits.push('标签：' + it.tags.join('、'));
  bits.push([it.platform, it.chat, it.time, it.sizeText].filter(Boolean).join(' · '));
  if (it.why) bits.push(it.why);
  viewerInfo.textContent = bits.filter(Boolean).join('\n');
  viewerInfo.style.whiteSpace = 'pre-line';
  viewer.hidden = false;
}

function closeViewer() {
  viewer.hidden = true;
  viewerImg.src = '';
}

async function load() {
  try {
    const d = await window.mediaAPI.list({ kind: state.kind, q: state.q });
    state.items = d.items || [];
    state.stats = d.stats || { total: 0, parts: [] };
    state.matched = d.matched || 0;
    render();
  } catch (err) {
    listEl.innerHTML = '';
    emptyEl.classList.add('show');
    emptyEl.querySelector('.tip').textContent = '读素材库失败';
    emptyEl.querySelector('.sub').textContent = String(err && err.message ? err.message : err);
  }
}

/* ---------- 事件 ---------- */
qEl.addEventListener('input', () => {
  state.q = qEl.value;
  clearTimeout(searchTimer);
  // 每敲一个字都读盘没必要，停顿一下再查
  searchTimer = setTimeout(load, 180);
});

btnRefresh.addEventListener('click', async () => {
  const old = btnRefresh.textContent;
  btnRefresh.disabled = true;
  btnRefresh.textContent = '同步中…';
  try {
    const r = await window.mediaAPI.sync();
    await load();
    if (r && r.message) countEl.textContent = r.message;
  } catch (err) {
    countEl.textContent = '同步失败：' + (err && err.message ? err.message : err);
  } finally {
    btnRefresh.disabled = false;
    btnRefresh.textContent = old;
  }
});

btnDir.addEventListener('click', () => window.mediaAPI.openDir());
document.getElementById('close').addEventListener('click', () => window.mediaAPI.close());
viewer.addEventListener('click', closeViewer);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!viewer.hidden) {
      closeViewer();
      return;
    }
    window.mediaAPI.close();
  }
});

load();
