'use strict';

/* 自绘右键菜单：接收主进程推来的条目，渲染成半透明卡片 */

const card = document.getElementById('card');

let rows = [];
let activeIndex = -1;

function clearActive() {
  for (const el of card.querySelectorAll('.item.active')) el.classList.remove('active');
}

function setActive(index) {
  clearActive();
  if (!rows.length) return;
  activeIndex = (index + rows.length) % rows.length;
  rows[activeIndex].classList.add('active');
}

function build(items) {
  card.innerHTML = '';
  rows = [];
  activeIndex = -1;

  for (const it of items || []) {
    if (it.sep) {
      const line = document.createElement('div');
      line.className = 'sep';
      card.appendChild(line);
      continue;
    }

    const row = document.createElement('div');
    row.className = 'item' + (it.danger ? ' danger' : '');
    row.dataset.id = it.id;
    row.setAttribute('role', 'menuitem');

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = it.label;
    row.appendChild(label);

    if (it.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = it.hint;
      row.appendChild(hint);
    }

    row.addEventListener('click', () => pick(it.id));
    row.addEventListener('mouseenter', () => {
      activeIndex = rows.indexOf(row);
      clearActive();
      row.classList.add('active');
    });

    card.appendChild(row);
    rows.push(row);
  }

  reportSize();
}

function pick(id) {
  if (!id) return;
  window.menuAPI.pick(id);
}

function reportSize() {
  const rect = card.getBoundingClientRect();
  // card 有 8px 外边距，窗口要比卡片大 16px 才能容纳阴影
  window.menuAPI.resize(Math.ceil(rect.width) + 16, Math.ceil(rect.height) + 16);
}

window.menuAPI.onRender((items) => build(items));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.menuAPI.close();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActive(activeIndex + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive(activeIndex - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (rows[activeIndex]) pick(rows[activeIndex].dataset.id);
  }
});

// 点击卡片外的透明区域也关掉
window.addEventListener('mousedown', (e) => {
  if (!card.contains(e.target)) window.menuAPI.close();
});

window.addEventListener('blur', () => window.menuAPI.close());
