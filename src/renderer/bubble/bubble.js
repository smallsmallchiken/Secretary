'use strict';

const chat = document.getElementById('chat');
const input = document.getElementById('input');
const btnSend = document.getElementById('btn-send');
const chips = document.getElementById('chips');
const badge = document.getElementById('badge');

const viewChat = document.getElementById('view-chat');
const viewSettings = document.getElementById('view-settings');

const QUICK_CHIPS = [
  '打开网易云音乐',
  '暂停播放',
  '下一首',
  '10分钟后提醒我喝水',
  '现在几点',
  '截个屏'
];

let sending = false;
let chipsVisible = true;

/* ---------------- 消息渲染 ---------------- */

function pushMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  chat.appendChild(el);
  scrollBottom();
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
}

function setChipsVisible(visible) {
  chipsVisible = visible;
  chips.style.display = visible ? 'flex' : 'none';
}

function buildChips() {
  chips.innerHTML = '';
  for (const text of QUICK_CHIPS) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = text;
    btn.addEventListener('click', () => {
      input.value = text;
      send();
    });
    chips.appendChild(btn);
  }
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
  setChipsVisible(false);
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
  input.style.height = `${Math.min(input.scrollHeight, 108)}px`;
});

/* ---------------- 视图切换 ---------------- */

function showChat() {
  viewSettings.classList.add('hidden');
  viewChat.classList.remove('hidden');
  input.focus();
}

async function showSettings() {
  viewChat.classList.add('hidden');
  viewSettings.classList.remove('hidden');
  await loadSettings();
}

document.getElementById('btn-settings').addEventListener('click', showSettings);
document.getElementById('btn-back').addEventListener('click', showChat);
document.getElementById('btn-close').addEventListener('click', () => window.bubbleAPI.hide(true));

/* ---------------- 设置 ---------------- */

async function loadSettings() {
  const cfg = await window.bubbleAPI.getConfig();
  document.getElementById('llm-enabled').checked = !!(cfg.llm && cfg.llm.enabled);
  document.getElementById('llm-baseurl').value = (cfg.llm && cfg.llm.baseUrl) || '';
  document.getElementById('llm-apikey').value = (cfg.llm && cfg.llm.apiKey) || '';
  document.getElementById('llm-model').value = (cfg.llm && cfg.llm.model) || '';
  document.getElementById('auto-launch').checked = !!cfg.autoLaunch;
  document.getElementById('auto-idle').checked = !!(cfg.behavior && cfg.behavior.autoIdle);
  document.getElementById('shortcut').value = (cfg.shortcuts && cfg.shortcuts.toggle) || '';

  await loadReminders();

  const info = await window.bubbleAPI.appInfo();
  const path = await window.bubbleAPI.configPath();
  document.getElementById('footnote').textContent =
    `v${info.version} · Electron ${info.electron} · 配置文件：${path}`;
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
    shortcuts: { toggle: document.getElementById('shortcut').value.trim() || 'Control+Shift+Space' }
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

/* ---------------- 徽章 ---------------- */

function updateBadge(ready) {
  badge.textContent = ready ? '智能模式' : '本地模式';
  badge.classList.toggle('on', !!ready);
}

/* ---------------- 事件绑定 ---------------- */

window.bubbleAPI.onFocusInput(() => {
  showChat();
  input.focus();
  input.select();
});

window.bubbleAPI.onPush((payload) => {
  if (!payload) return;
  pushMessage(payload.role || 'assistant', payload.text || '');
  setChipsVisible(false);
});

window.bubbleAPI.onOpenSettings(() => showSettings());

/* ---------------- 启动 ---------------- */

async function boot() {
  buildChips();
  const info = await window.bubbleAPI.appInfo();
  updateBadge(info.llmReady);

  // 等一下，让主进程可能已经排队的消息（比如提醒推送）先落地，
  // 避免问候语插在提醒前面。
  await new Promise((r) => setTimeout(r, 200));

  if (chat.children.length > 0) {
    setChipsVisible(false);
    input.focus();
    return;
  }

  const hour = new Date().getHours();
  let greet = '在呢。';
  if (hour < 6) greet = '还没睡？说吧，要我干什么。';
  else if (hour < 11) greet = '早。要打开什么、放点歌，还是设个提醒？';
  else if (hour < 14) greet = '中午好。吃完饭要不要听点东西？';
  else if (hour < 18) greet = '下午好。有活儿直接说。';
  else if (hour < 23) greet = '晚上好。要我放首歌还是定个提醒？';
  else greet = '这么晚还在忙。要我帮你设个提醒早点睡吗？';

  pushMessage('assistant', greet);
  input.focus();
}

boot();
