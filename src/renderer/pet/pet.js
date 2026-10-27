'use strict';

/* ------------------------------------------------------------------
 * 比格多栋 · 动画引擎
 * 雪碧图 1536x1872，8 列 x 9 行，单帧 192x208。
 * 每行动画帧数不同；row2 是 row1 的水平镜像（同帧数），
 * 用来做朝左行走，所以两张都要用。
 * ------------------------------------------------------------------ */

const FW = 192;
const FH = 208;
const COLS = 8;
const SPRITE = '../../../pets/duodong/spritesheet.webp';

const ANIM = {
  idle:   { row: 0, frames: 6, fps: 7,  loop: true },
  walk_r: { row: 1, frames: 8, fps: 12, loop: true },
  walk_l: { row: 2, frames: 8, fps: 12, loop: true },
  sleep:  { row: 3, frames: 4, fps: 3.5, loop: true },
  sit:    { row: 4, frames: 5, fps: 5,  loop: true },
  sad:    { row: 5, frames: 8, fps: 9,  loop: true },
  stand:  { row: 6, frames: 6, fps: 5,  loop: true },
  think:  { row: 7, frames: 6, fps: 8,  loop: true },
  happy:  { row: 8, frames: 6, fps: 13, loop: false }
};

// 兼容旧调用名
ANIM.walk = ANIM.walk_r;

const stage = document.getElementById('stage');
const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d', { alpha: true });

const img = new Image();
let imgReady = false;

let currentName = 'idle';
let frameIndex = 0;
let elapsed = 0;
let lastTs = 0;
let locked = false; // 一次性动画播放中，屏蔽自动行为
let roaming = false; // 主进程正在驱动走路，此时不接受本地状态切换
let autoTimer = null;
let hoverTimer = null;

// 行为开关，来自主进程配置
let behavior = { autoIdle: true, allowWander: true };

/* ---------------- 渲染 ---------------- */

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const scale = Math.min(w / FW, h / FH);

  canvas.style.width = `${FW * scale}px`;
  canvas.style.height = `${FH * scale}px`;
  canvas.width = Math.round(FW * scale * dpr);
  canvas.height = Math.round(FH * scale * dpr);
  render();
}

function render() {
  if (!imgReady) return;
  const anim = ANIM[currentName] || ANIM.idle;
  const sx = Math.min(frameIndex, anim.frames - 1) * FW;
  const sy = anim.row * FH;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, FW, FH, 0, 0, canvas.width, canvas.height);
}

function tick(ts) {
  if (!lastTs) lastTs = ts;
  const dt = ts - lastTs;
  lastTs = ts;

  const anim = ANIM[currentName] || ANIM.idle;
  elapsed += dt;

  const frameDuration = 1000 / anim.fps;
  if (elapsed >= frameDuration) {
    elapsed = 0;
    frameIndex += 1;
    if (frameIndex >= anim.frames) {
      if (anim.loop) {
        frameIndex = 0;
      } else {
        // 一次性动画结束，回到 idle
        frameIndex = anim.frames - 1;
        render();
        locked = false;
        applyState('idle');
        return;
      }
    }
    render();
  }

  requestAnimationFrame(tick);
}

/* ---------------- 状态控制 ---------------- */

function applyState(name) {
  if (!ANIM[name]) name = 'idle';
  currentName = name;
  frameIndex = 0;
  elapsed = 0;
  render();
}

function setState(name, { force = false } = {}) {
  if ((locked || roaming) && !force) return;
  if (name === currentName && !force) return;

  const anim = ANIM[name];
  if (!anim) return;

  if (!anim.loop) locked = true;
  applyState(name);

  if (name === 'happy') bounce();
  scheduleAutoBehavior();
}

function bounce() {
  stage.classList.remove('bounce');
  // 强制重排以重启动画
  void stage.offsetWidth;
  stage.classList.add('bounce');
  setTimeout(() => stage.classList.remove('bounce'), 600);
}

/* ---------------- 自动小动作 ---------------- */

// 走路交给主进程驱动窗口位移，这里只放原地能做的小动作
const IDLE_MOVES = ['sit', 'sleep', 'stand'];

function scheduleAutoBehavior() {
  clearTimeout(autoTimer);
  if (!behavior.autoIdle) return;
  autoTimer = setTimeout(() => {
    if (locked || roaming || isDragging) return;
    if (!behavior.autoIdle) return;

    // 只在待机时自己玩
    if (currentName !== 'idle') {
      setState('idle', { force: true });
      scheduleAutoBehavior();
      return;
    }

    const pick = IDLE_MOVES[Math.floor(Math.random() * IDLE_MOVES.length)];
    setState(pick);

    const back = 4000 + Math.random() * 6000;
    setTimeout(() => {
      if (!locked && !isDragging && currentName === pick) setState('idle', { force: true });
    }, back);
  }, 7000 + Math.random() * 8000);
}

/* ---------------- 鼠标交互 ---------------- */

let isDragging = false;
let moved = false;
let startX = 0;
let startY = 0;

stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  isDragging = true;
  moved = false;
  startX = e.screenX;
  startY = e.screenY;
  stage.classList.add('dragging');
  window.petAPI.dragStart();
  // 拖动期间暂停自动行为
  clearTimeout(autoTimer);
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  if (Math.abs(e.screenX - startX) > 4 || Math.abs(e.screenY - startY) > 4) {
    moved = true;
  }
  if (moved) window.petAPI.dragMove();
});

window.addEventListener('mouseup', (e) => {
  if (!isDragging || e.button !== 0) return;
  isDragging = false;
  stage.classList.remove('dragging');
  window.petAPI.dragEnd();

  if (!moved) {
    window.petAPI.click();
    if (!roaming) setState('happy', { force: true });
  }
  scheduleAutoBehavior();
});

// 右键菜单
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petAPI.contextMenu();
});

// 悬停时更精神一点
stage.addEventListener('mouseenter', () => {
  if (isDragging || locked) return;
  if (currentName === 'idle' || currentName === 'sleep' || currentName === 'sit') {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!isDragging && !locked) setState('stand');
    }, 180);
  }
});

stage.addEventListener('mouseleave', () => {
  clearTimeout(hoverTimer);
  if (!isDragging && !locked && !roaming && ['stand', 'walk', 'walk_r', 'walk_l'].includes(currentName)) {
    setState('idle', { force: true });
  }
});

// 鼠标穿透优化：只有指针在宠物像素上时才接收事件
let ignoring = false;
function updateHitTest(e) {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return false;
  return true;
}

/* ---------------- 初始化 ---------------- */

img.onload = () => {
  imgReady = true;
  resize();
  render();
  requestAnimationFrame(tick);
  scheduleAutoBehavior();
};

img.onerror = () => {
  console.error('雪碧图加载失败：', SPRITE);
  ctx.fillStyle = '#c8a06a';
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) * 0.4, 0, Math.PI * 2);
  ctx.fill();
};

img.src = SPRITE;

window.addEventListener('resize', resize);

// 主进程推来的状态变更
window.petAPI.onState((payload) => {
  if (!payload) return;
  const state = typeof payload === 'string' ? payload : payload.state;
  if (state === 'happy') {
    setState('happy', { force: true });
    setTimeout(() => setState('idle', { force: true }), 900);
  } else {
    setState(state, { force: state === 'think' || state === 'sad' });
  }
});

// 主进程驱动漫游：只负责播对朝向的行走帧
window.petAPI.onWander((payload) => {
  if (!payload) return;
  if (payload.active) {
    roaming = true;
    clearTimeout(autoTimer);
    locked = false;
    applyState(payload.dir === 'left' ? 'walk_l' : 'walk_r');
  } else {
    roaming = false;
    if (currentName === 'walk_l' || currentName === 'walk_r' || currentName === 'walk') {
      applyState('idle');
    }
    scheduleAutoBehavior();
  }
});

function applyBehavior(cfg) {
  if (cfg && cfg.behavior) {
    behavior = {
      autoIdle: cfg.behavior.autoIdle !== false,
      allowWander: cfg.behavior.allowWander !== false
    };
    if (behavior.autoIdle) scheduleAutoBehavior();
    else clearTimeout(autoTimer);
  }
}

window.petAPI.onConfig((cfg) => {
  if (!cfg) return;
  // 主进程可能只推 pet 段，只有带 behavior 时才更新行为开关
  if (cfg.behavior) applyBehavior(cfg);
  resize();
});

// 启动时拉一次配置，让 autoIdle / allowWander 一开始就生效
if (window.petAPI.getConfig) {
  window.petAPI
    .getConfig()
    .then((cfg) => applyBehavior(cfg))
    .catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  document.body.addEventListener('dragstart', (e) => e.preventDefault());
});
