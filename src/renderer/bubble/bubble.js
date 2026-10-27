'use strict';

const chat = document.getElementById('chat');
const input = document.getElementById('input');
const btnSend = document.getElementById('btn-send');

const viewChat = document.getElementById('view-chat');
const viewSettings = document.getElementById('view-settings');

let sending = false;
let heightReportPending = false;

/* ---------------- 云朵轮廓 ---------------- */

/**
 * 日漫云朵对话框的轮廓。
 *
 * 做法：沿内缩矩形的周长均匀摆一圈等半径圆（相邻圆互相吃掉一点），
 * 再把它们的**并集外边界**用圆弧连起来 —— 这就是手绘云朵那圈鼓包，
 * 不是正弦扰动出来的锯齿，也不是被拉伸变形的固定 path。
 *
 * R 是鼓包半径，step 是鼓包间距。step 越接近 2R，凹口越深（越"泡"）。
 */
function cloudPathD(w, h, R = 15, step = 26) {
  const inset = R; // 圆心内缩 R，凸起正好贴在画布边缘以内
  const left = inset;
  const right = w - inset;
  const top = inset;
  const bottom = h - inset;
  const bw = right - left;
  const bh = bottom - top;
  if (bw < 4 || bh < 4) return `M 0 0 H ${w} V ${h} H 0 Z`;

  const per = 2 * (bw + bh);
  const count = Math.max(8, Math.round(per / step));
  const gap = per / count;

  // 圆心：顺时针沿周长走一圈
  const centers = [];
  for (let i = 0; i < count; i += 1) {
    const d = i * gap;
    if (d < bw) centers.push([left + d, top]);
    else if (d < bw + bh) centers.push([right, top + (d - bw)]);
    else if (d < 2 * bw + bh) centers.push([right - (d - bw - bh), bottom]);
    else centers.push([left, bottom - (d - 2 * bw - bh)]);
  }

  // 相邻两圆的「外侧交点」= 两段圆弧的接缝
  const half = gap / 2;
  const bulge = Math.sqrt(Math.max(0, R * R - half * half));
  const cx = w / 2;
  const cy = h / 2;
  const seams = centers.map((c, i) => {
    const prev = centers[(i - 1 + count) % count];
    const mx = (c[0] + prev[0]) / 2;
    const my = (c[1] + prev[1]) / 2;
    // 外法线：从中心指向接缝，够近似了
    let nx = mx - cx;
    let ny = my - cy;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    return [mx + nx * bulge, my + ny * bulge];
  });

  const f = (v) => v.toFixed(1);
  let d = `M ${f(seams[0][0])} ${f(seams[0][1])}`;
  for (let i = 0; i < count; i += 1) {
    const end = seams[(i + 1) % count];
    d += ` A ${f(R)} ${f(R)} 0 0 1 ${f(end[0])} ${f(end[1])}`;
  }
  return `${d} Z`;
}

const cloudSvg = document.querySelector('.cloud');
const cloudPath = document.querySelector('.cloud-path');

function drawCloud() {
  if (!cloudSvg || !cloudPath) return;
  const w = Math.round(cloudSvg.clientWidth);
  const h = Math.round(cloudSvg.clientHeight);
  if (w < 8 || h < 8) return;
  cloudSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  cloudPath.setAttribute('d', cloudPathD(w, h));
}

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => drawCloud()).observe(cloudSvg);
}
window.addEventListener('resize', drawCloud);

/* ---------------- 高度回传（贴头气泡按内容定高） ---------------- */

/**
 * 消息区里真正的内容高度。
 * 不能读 chat.scrollHeight —— 它是 flex:1 的滚动容器，空着时
 * scrollHeight 也等于 clientHeight，气泡只会撑大、永远缩不回去。
 * 所以按子元素逐个累加（含 flex gap）。
 */
function chatContentHeight() {
  const kids = chat.children;
  if (!kids.length) return 0;
  const gap = parseFloat(getComputedStyle(chat).rowGap) || 0;
  let h = 0;
  for (let i = 0; i < kids.length; i += 1) h += kids[i].offsetHeight;
  return h + gap * (kids.length - 1);
}

/**
 * 量出聊天态「自然高度」并回传主进程改窗口尺寸。
 * 内边距 + 消息内容 + 输入行 + 句号带 + body padding。
 * rAF 包一层，避免同一帧内多次触发布局抖动。
 */
function reportHeight() {
  if (heightReportPending || (viewSettings && !viewSettings.classList.contains('hidden'))) return;
  heightReportPending = true;
  requestAnimationFrame(() => {
    heightReportPending = false;
    if (!viewSettings.classList.contains('hidden')) return; // 设置态不回传
    const inner = document.querySelector('.cloud-inner');
    const composer = viewChat.querySelector('.composer');
    const cs = inner ? getComputedStyle(inner) : null;
    const innerPad = cs ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) : 38;
    const h =
      innerPad +
      chatContentHeight() +
      (composer ? composer.offsetHeight : 0) +
      18 + // #view-chat 的句号带（below 态改成 padding-top，高度一样）
      12 + // body padding 上下 6+6
      2; // 取整留白，否则最后一条消息的圆角会被输入行切掉
    window.bubbleAPI.resize(h).then(() => scrollBottom());
  });
}

/* ---------------- 消息渲染 ---------------- */

function pushMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  chat.appendChild(el);
  scrollBottom();
  reportHeight();
  return el;
}

function scrollBottom() {
  requestAnimationFrame(() => {
    chat.scrollTop = chat.scrollHeight;
  });
}

function showTyping() {
  const el = document.createElement('div');
  el.className = 'msg assistant typing';
  el.innerHTML = '<span></span><span></span><span></span>';
  el.id = 'typing';
  chat.appendChild(el);
  scrollBottom();
  return el;
}

function hideTyping() {
  const el = document.getElementById('typing');
  if (el) el.remove();
  reportHeight();
}

/* ---------------- 发送 ---------------- */

async function send(rawText) {
  const text = (rawText != null ? rawText : input.value).trim();
  if (!text || sending) return;

  sending = true;
  btnSend.disabled = true;
  input.value = '';
  input.style.height = 'auto';

  pushMessage('user', text);
  showTyping();

  try {
    const res = await window.bubbleAPI.send(text);
    hideTyping();

    if (res && res.type === 'error') {
      pushMessage('error', res.message || '出错了');
    } else if (res && res.message) {
      pushMessage('assistant', res.message);
    } else {
      pushMessage('assistant', '……');
    }
  } catch (err) {
    hideTyping();
    pushMessage('error', err.message || '请求失败');
  } finally {
    sending = false;
    btnSend.disabled = false;
    input.focus();
  }
}

btnSend.addEventListener('click', () => send());

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    window.bubbleAPI.hide(true);
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 84)}px`;
  reportHeight();
});

/* ---------------- 视图切换 ---------------- */

function showChat() {
  viewSettings.classList.add('hidden');
  viewChat.classList.remove('hidden');
  input.focus();
  window.bubbleAPI.setMode('chat');
}

async function showSettings() {
  viewChat.classList.add('hidden');
  viewSettings.classList.remove('hidden');
  await loadSettings();
  await window.bubbleAPI.setMode('settings');
}

// 对话框保持干净：不放任何按钮/提示词，右键出菜单（菜单里有设置、隐藏、退出）
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.bubbleAPI.contextMenu();
});
document.getElementById('btn-back').addEventListener('click', showChat);

// 主进程要求打开设置页（右键菜单的「设置」、托盘菜单走的都是这条）
window.bubbleAPI.onOpenSettings(() => showSettings());
document.getElementById('btn-settings-close').addEventListener('click', () =>
  window.bubbleAPI.hide(true)
);

// Esc 收起：设置在输入框上时焦点可能在别处，所以挂在 document 上
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.isComposing) {
    e.preventDefault();
    window.bubbleAPI.hide(true);
  }
});

/* ---------------- 设置 ---------------- */

// 与 src/core/persona.js 的 PRESETS / LENGTHS 保持一致
const PERSONA_PRESETS = ['黏人', '利落', '损友', '元气'];
const PERSONA_LENGTHS = [
  { key: 'short', label: '很短' },
  { key: 'normal', label: '适中' },
  { key: 'detailed', label: '可长一点' }
];

let personaState = { preset: '黏人', length: 'short', custom: '' };

function renderPersonaOptions() {
  const pbox = document.getElementById('persona-presets');
  pbox.innerHTML = '';
  for (const key of PERSONA_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'persona-opt' + (personaState.preset === key ? ' on' : '');
    b.textContent = key;
    b.addEventListener('click', () => {
      personaState.preset = key;
      renderPersonaOptions();
    });
    pbox.appendChild(b);
  }

  const lbox = document.getElementById('persona-lengths');
  lbox.innerHTML = '';
  for (const item of PERSONA_LENGTHS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'persona-opt' + (personaState.length === item.key ? ' on' : '');
    b.textContent = item.label;
    b.addEventListener('click', () => {
      personaState.length = item.key;
      renderPersonaOptions();
    });
    lbox.appendChild(b);
  }
}

async function loadSettings() {
  const cfg = await window.bubbleAPI.getConfig();
  document.getElementById('llm-enabled').checked = !!(cfg.llm && cfg.llm.enabled);
  document.getElementById('llm-baseurl').value = (cfg.llm && cfg.llm.baseUrl) || '';
  document.getElementById('llm-apikey').value = (cfg.llm && cfg.llm.apiKey) || '';
  document.getElementById('llm-model').value = (cfg.llm && cfg.llm.model) || '';
  document.getElementById('auto-launch').checked = !!cfg.autoLaunch;
  document.getElementById('auto-idle').checked = !!(cfg.behavior && cfg.behavior.autoIdle);
  document.getElementById('shortcut').value = (cfg.shortcuts && cfg.shortcuts.toggle) || '';
  const petShortcut = document.getElementById('pet-shortcut');
  if (petShortcut) {
    petShortcut.value = (cfg.shortcuts && cfg.shortcuts.petToggle) || '';
  }

  const p = cfg.persona || {};
  personaState = {
    preset: p.preset || '黏人',
    length: p.length || 'short',
    custom: p.custom || ''
  };
  renderPersonaOptions();
  document.getElementById('persona-emoji').checked = !!p.emoji;
  document.getElementById('persona-name').value = p.name || '';
  document.getElementById('persona-signature').value = p.signature || '';

  await loadReminders();
}

async function loadReminders() {
  const box = document.getElementById('reminder-list');
  const items = await window.bubbleAPI.listReminders();
  box.innerHTML = '';
  if (!items || !items.length) {
    const empty = document.createElement('div');
    empty.style.color = 'var(--text-faint)';
    empty.textContent = '没有待办提醒';
    box.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'reminder-item';

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = item.local;

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = item.text;

    const del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      await window.bubbleAPI.cancelReminder(item.id);
      await loadReminders();
    });

    row.append(when, text, del);
    box.appendChild(row);
  }
}

document.getElementById('btn-save').addEventListener('click', async () => {
  const patch = {
    llm: {
      enabled: document.getElementById('llm-enabled').checked,
      baseUrl: document.getElementById('llm-baseurl').value.trim() || 'https://api.deepseek.com',
      apiKey: document.getElementById('llm-apikey').value.trim(),
      model: document.getElementById('llm-model').value.trim() || 'deepseek-chat'
    },
    autoLaunch: document.getElementById('auto-launch').checked,
    behavior: { autoIdle: document.getElementById('auto-idle').checked },
    shortcuts: {
      toggle: document.getElementById('shortcut').value.trim() || 'Alt+W',
      petToggle:
        (document.getElementById('pet-shortcut') &&
          document.getElementById('pet-shortcut').value.trim()) ||
        'Alt+Q'
    },
    persona: {
      preset: personaState.preset,
      length: personaState.length,
      emoji: document.getElementById('persona-emoji').checked,
      name: document.getElementById('persona-name').value.trim() || '比格多栋',
      signature: document.getElementById('persona-signature').value.trim(),
      custom: personaState.custom
    }
  };

  await window.bubbleAPI.setConfig(patch);
  updateBadge(patch.llm.enabled && !!patch.llm.apiKey);

  const btn = document.getElementById('btn-save');
  const original = btn.textContent;
  btn.textContent = '已保存';
  setTimeout(() => (btn.textContent = original), 1200);
});

document.getElementById('btn-quit').addEventListener('click', () => {
  window.bubbleAPI.quit();
});

/* ---------------- 徽章（设置页不再显示，保留空实现以兼容调用点） ---------------- */

function updateBadge() {}

/* ---------------- 事件绑定 ---------------- */

window.bubbleAPI.onFocusInput(() => {
  showChat();
  input.focus();
  input.select();
});

window.bubbleAPI.onPush((payload) => {
  if (!payload) return;
  pushMessage(payload.role || 'assistant', payload.text || '');
});

// 主进程算好的贴头布局：side = 气泡在宠物哪一侧
// （'left' = 气泡在宠物左边 → 尾巴在气泡右边缘；'below' = 上方放不下，翻到脑袋下方）
window.bubbleAPI.onLayout((payload) => {
  if (!payload) return;
  document.body.dataset.side = payload.side === 'right' ? 'right' : 'left';
  if (payload.below) document.body.dataset.below = '1';
  else delete document.body.dataset.below;
});

/* ---------------- 启动 ---------------- */

async function boot() {
  drawCloud();
  const info = await window.bubbleAPI.appInfo();
  updateBadge(info.llmReady);

  // 等一下，让主进程可能已经排队的消息（比如提醒推送）先落地。
  await new Promise((r) => setTimeout(r, 200));

  // 对话框保持干净：空态没有任何问候语、没有占位文案，就是一片安静的云。
  reportHeight();
  input.focus();
}

boot();
