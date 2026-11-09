'use strict';

/* 备忘录面板渲染：条目来自主进程 memo:list，勾选立即回写并重画 */

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const cardEl = document.getElementById('card');

let state = { items: [], stats: { total: 0, done: 0, open: 0 } };

function esc(s) {
  return String(s == null ? '' : s);
}

function render() {
  const items = state.items || [];
  listEl.innerHTML = '';

  // 未完成在前（新的在上），已完成沉底——勾完立刻消失会让人以为点错了
  const open = items.filter((x) => !x.done);
  const done = items.filter((x) => x.done);
  const ordered = open.concat(done);

  for (const it of ordered) {
    const row = document.createElement('div');
    row.className = 'item' + (it.done ? ' done' : '');
    row.dataset.id = it.id;

    const box = document.createElement('div');
    box.className = 'box';
    row.appendChild(box);

    const body = document.createElement('div');
    body.className = 'body';

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = esc(it.text);
    body.appendChild(text);

    const bits = [];
    if (it.src) bits.push(it.src);
    if (it.chat) bits.push(it.chat);
    if (it.day) bits.push(it.day + (it.hm ? ' ' + it.hm : ''));
    if (bits.length) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = bits.join(' · ');
      body.appendChild(meta);
    }

    if (it.quote) {
      const q = document.createElement('div');
      q.className = 'quote';
      q.textContent = '原话：' + esc(it.quote);
      body.appendChild(q);
    }

    row.appendChild(body);
    row.addEventListener('click', () => onToggle(it.id));
    listEl.appendChild(row);
  }

  const s = state.stats || { total: 0, done: 0, open: 0 };
  countEl.textContent = s.total ? `待办 ${s.open} · 已完成 ${s.done}` : '';
  document.body.classList.toggle('is-empty', s.total === 0);
}

async function reload() {
  try {
    state = await window.memoAPI.list();
  } catch (err) {
    state = { items: [], stats: { total: 0, done: 0, open: 0 } };
  }
  render();
}

async function onToggle(id) {
  try {
    const r = await window.memoAPI.toggle(id);
    if (r && r.ok) {
      // 只改本地这条，不整表重取——避免滚动位置跳掉
      const it = state.items.find((x) => x.id === id);
      if (it) {
        it.done = r.item.done;
        it.doneAt = r.item.doneAt;
      }
      state.stats = r.stats || state.stats;
      render();
    }
  } catch {
    /* 点失败了就当没点，不弹错误——桌宠不该用弹窗打断人 */
  }
}

document.getElementById('btn-refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = '同步中…';
  btn.disabled = true;
  try {
    await window.memoAPI.refresh();
    await reload();
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
});

document.getElementById('btn-db').addEventListener('click', () => {
  window.memoAPI.openDatabase();
});

document.getElementById('btn-clear').addEventListener('click', async () => {
  await window.memoAPI.clearDone();
  await reload();
});

document.getElementById('close').addEventListener('click', () => {
  window.memoAPI.close();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.memoAPI.close();
});

// 先渲染一次缓存，再异步取最新（打开即有内容，不用等 IPC 往返）
reload();
