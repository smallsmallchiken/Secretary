'use strict';
/**
 * 备忘录 + 消息数据库。
 *
 * 两块数据，同一个模块管：
 *   1) 备忘录 .data/memo.json
 *      从每日清单（.data/daily/<日期>/daily.md）里把「需要我处理的待办」抽成条目，
 *      每条带勾选状态。用户右键桌宠 → 备忘录 → 打勾，状态立刻落盘。
 *      **不改 daily.md 本身**：那是当天的原始产物，勾选属于「我的进度」，
 *      混写进去会让重跑清单把已完成状态覆盖掉。
 *
 *   2) 消息数据库 .data/memo/消息数据库.md
 *      把 QQ / 微信全量归档按「会话」聚合渲染成一份可读的 Markdown，
 *      按天分段、按时间正序，媒体消息标出类型与本地文件。
 *      这是用户要的「收集所有信息（含所有群聊）整理成一个 md 保存为数据库」。
 *
 * 为什么以 daily.md 为待办来源而不是直接扫归档：归档是原始流水，
 * 「哪句是要我去做的事」需要语义判断，服务器上的清单生成器已经用模型做过一遍，
 * 这里再用药规则重判一遍只会更差。所以这里只做解析与状态管理。
 *
 * 重要：daily.md 的待办行格式与 server/daily_report.py 的 render_markdown() 强耦合：
 *   - [ ] **把设计稿发给G** ｜ QQ · G · 13:56
 *         - 原话：发给我看看（n11）
 * 改那边的格式必须同步改 parseDaily()，否则桌宠会一条都抽不出来。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./paths');

const DB_DIRNAME = 'memo';
const DB_FILENAME = '消息数据库.md';

function memoFile() {
  return path.join(dataDir(), 'memo.json');
}
function dailyDir() {
  return path.join(dataDir(), 'daily');
}
function dbDir() {
  const d = path.join(dataDir(), DB_DIRNAME);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function dbFile() {
  return path.join(dbDir(), DB_FILENAME);
}

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(memoFile(), 'utf8'));
    if (d && Array.isArray(d.items)) return d;
  } catch {
    /* 文件不存在或损坏都当空库，后面会重建 */
  }
  return { version: 1, updatedAt: 0, items: [] };
}

function save(d) {
  d.updatedAt = Math.floor(Date.now() / 1000);
  const file = memoFile();
  // 原子写：面板可能正开着，写到一半被读到会得到半截 JSON
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    require('./debug').dbg('[memo] 保存失败:', err.message);
  }
  return d;
}

function idOf(text, day) {
  return 'm_' + crypto.createHash('sha1').update(day + '|' + text).digest('hex').slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* 从每日清单抽待办                                                     */
/* ------------------------------------------------------------------ */

/** 列出 .data/daily 下所有日期目录（升序） */
function dailyDays() {
  try {
    return fs
      .readdirSync(dailyDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 解析 daily.md 的待办段。
 * 只看「## 一、」到下一个「## 」之间，避免把全量流水里的 `- ` 也当待办。
 */
function parseDaily(md, day) {
  const items = [];
  const lines = String(md).split(/\r?\n/);
  let inTodo = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s*一、/.test(line)) {
      inTodo = true;
      continue;
    }
    if (/^##\s/.test(line)) {
      inTodo = false;
      continue;
    }
    if (!inTodo) continue;

    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
    if (!m) continue;

    let body = m[2].trim();
    const meta = { platform: '', chat: '', hm: '' };
    // 分隔符是全角竖线，正文里也可能出现，所以从右往左找最后一条
    const cut = body.lastIndexOf('｜');
    if (cut > 0) {
      const tail = body.slice(cut + 1).trim();
      body = body.slice(0, cut).trim();
      const parts = tail.split('·').map((s) => s.trim());
      if (parts[0]) meta.platform = parts[0];
      if (parts[1]) meta.chat = parts[1];
      if (parts[2]) meta.hm = parts[2];
    }
    const text = body.replace(/^\*\*|\*\*$/g, '').trim();
    if (!text) continue;

    // 下一行的「原话」
    let quote = '';
    const next = lines[i + 1] || '';
    const qm = next.match(/原话：(.+?)(?:（n\d+）)?\s*$/);
    if (qm) quote = qm[1].trim();

    items.push({ text, quote, ...meta });
  }
  return items;
}

/**
 * 把每日清单里的待办合并进备忘录。
 * 已经存在的条目**保留用户勾选状态**，只补新增的——
 * 否则每小时重跑一次清单，用户早上勾完的下午又变回未完成。
 */
function syncFromDaily() {
  const d = load();
  const seen = new Set(d.items.map((x) => x.id));
  let added = 0;
  const days = dailyDays();
  for (const day of days) {
    let md = '';
    try {
      md = fs.readFileSync(path.join(dailyDir(), day, 'daily.md'), 'utf8');
    } catch {
      continue;
    }
    for (const t of parseDaily(md, day)) {
      const id = idOf(t.text, day);
      if (seen.has(id)) continue;
      seen.add(id);
      d.items.push({
        id,
        text: t.text,
        quote: t.quote,
        chat: t.chat,
        src: t.platform,
        day,
        hm: t.hm,
        done: false,
        doneAt: 0,
        created: Math.floor(Date.now() / 1000)
      });
      added += 1;
    }
  }
  // 新的排前面：同一天里按时间倒序更像「待办列表」
  d.items.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? 1 : -1;
    return String(a.hm) < String(b.hm) ? 1 : -1;
  });
  save(d);
  require('./debug').dbg('[memo] 同步待办：新增', added, '条，共', d.items.length, '条');
  return { added, total: d.items.length, days: days.length };
}

function toggle(id) {
  const d = load();
  const it = d.items.find((x) => x.id === id);
  if (!it) return { ok: false, error: '没有这条待办' };
  it.done = !it.done;
  it.doneAt = it.done ? Math.floor(Date.now() / 1000) : 0;
  save(d);
  return { ok: true, item: it, stats: statsOf(d) };
}

function remove(id) {
  const d = load();
  const before = d.items.length;
  d.items = d.items.filter((x) => x.id !== id);
  save(d);
  return { ok: d.items.length !== before, stats: statsOf(d) };
}

/** 清掉所有已完成的条目（用户想「眼不见」时用） */
function clearDone() {
  const d = load();
  const before = d.items.length;
  d.items = d.items.filter((x) => !x.done);
  save(d);
  return { ok: true, removed: before - d.items.length, stats: statsOf(d) };
}

function statsOf(d) {
  const total = d.items.length;
  const done = d.items.filter((x) => x.done).length;
  return { total, done, open: total - done };
}

function list() {
  const d = load();
  return {
    items: d.items,
    stats: statsOf(d),
    updatedAt: d.updatedAt,
    dbPath: dbFile()
  };
}

function stats() {
  return statsOf(load());
}

/* ------------------------------------------------------------------ */
/* 消息数据库                                                          */
/* ------------------------------------------------------------------ */

/** 读所有 QQ 归档：.data/archive/YYYY-MM-DD.jsonl */
function readQQ() {
  const dir = path.join(dataDir(), 'archive');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const day = f.slice(0, 10);
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        out.push({ ...r, day: day, platform: 'QQ' });
      } catch {
        /* 坏行跳过，一行坏了不能拖垮整库 */
      }
    }
  }
  return out;
}

/** 读所有微信归档：.data/archive/wechat/wx-YYYY-MM-DD.jsonl */
function readWX() {
  const dir = path.join(dataDir(), 'archive', 'wechat');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^wx-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const day = f.slice(3, 13);
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        out.push({ ...r, day: day, platform: '微信' });
      } catch {
        /* 同上 */
      }
    }
  }
  return out;
}

const KIND_LABEL = {
  image: '图片',
  record: '语音',
  video: '视频',
  file: '文件',
  mface: '表情',
  face: '表情',
  bface: '表情',
  sface: '表情',
  json: '卡片',
  xml: '卡片',
  share: '分享',
  contact: '名片',
  location: '位置',
  music: '音乐',
  poke: '戳一戳',
  sticker: '表情',
  media: '媒体',
  voice: '语音'
};

function kindText(r) {
  const labels = [];
  for (const m of r.m || []) {
    const t = String(m && m.t || '');
    if (!t || t === 'text' || t === 'at' || t === 'reply') continue;
    const label = KIND_LABEL[t] || t;
    if (!labels.includes(label)) labels.push(label);
  }
  if (!labels.length) {
    for (const k of String(r.k || '').split('+')) {
      if (!k || k === 'text') continue;
      const label = KIND_LABEL[k] || k;
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return labels.join('/');
}

function hmOf(ts) {
  const d = new Date((Number(ts) || 0) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function escCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim();
}

/**
 * 重建消息数据库 MD。
 *
 * 结构：按会话（平台 + 会话名/号）分组，组内再按天分小节。
 * 目录放在最前面，方便在编辑器里跳转；条数多的会话排前面。
 */
function buildDatabase() {
  const all = readQQ().concat(readWX());
  const chats = new Map();
  for (const r of all) {
    const key = r.platform + '::' + String(r.id || r.n || '未知');
    if (!chats.has(key)) {
      chats.set(key, {
        platform: r.platform,
        id: String(r.id || ''),
        name: String(r.n || r.id || '未知会话'),
        rows: []
      });
    }
    chats.get(key).rows.push(r);
  }

  const list_ = [...chats.values()].sort((a, b) => b.rows.length - a.rows.length);
  const days = new Set(all.map((r) => r.day));
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;

  const L = [];
  L.push('# 消息数据库');
  L.push('');
  L.push(`> 由桌宠自动汇总 QQ / 微信全量归档（含所有群聊）。`);
  L.push(`> 共 **${all.length}** 条消息、**${list_.length}** 个会话、**${days.size}** 天。`);
  L.push(`> 最后更新：${stamp}`);
  L.push('');
  L.push('## 目录');
  L.push('');
  for (const c of list_) {
    L.push(`- ${c.platform} · ${c.name}（${c.rows.length} 条）`);
  }
  L.push('');

  for (const c of list_) {
    L.push(`## ${c.platform} · ${c.name}`);
    L.push('');
    if (c.id) L.push(`会话号：\`${c.id}\``);
    L.push('');

    // 组内按天分节，天内按时间正序
    const byDay = new Map();
    for (const r of c.rows) {
      if (!byDay.has(r.day)) byDay.set(r.day, []);
      byDay.get(r.day).push(r);
    }
    for (const day of [...byDay.keys()].sort()) {
      const rows = byDay.get(day).sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
      L.push(`### ${day}（${rows.length} 条）`);
      L.push('');
      for (const r of rows) {
        const who = r.me ? '我' : (r.sn || r.s || '对方');
        let body = String(r.x || '').trim();
        const kind = kindText(r);
        if (!body && kind) body = `（无文字）\`${kind}\``;
        else if (kind) body += ` \`${kind}\``;
        if (!body) body = '（空消息）';
        const lines = body.split(/\r?\n/).filter(Boolean);
        L.push(`- \`${hmOf(r.t)}\` **${who}**：${escCell(lines[0] || '')}`);
        for (const extra of lines.slice(1)) L.push(`  ${escCell(extra)}`);
        if (r.shot) L.push(`  - [截图](media/${escCell(r.shot)})`);
      }
      L.push('');
    }
  }

  const md = L.join('\n');
  const file = dbFile();
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, md, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    require('./debug').dbg('[memo] 写数据库失败:', err.message);
    return { ok: false, error: err.message };
  }
  require('./debug').dbg('[memo] 数据库已重建:', all.length, '条 ->', file);
  return {
    ok: true,
    path: file,
    messages: all.length,
    chats: list_.length,
    days: days.size,
    bytes: Buffer.byteLength(md, 'utf8')
  };
}

/** 一次做完：同步待办 + 重建数据库（面板上的「刷新」按钮 / 启动时调用） */
function refresh() {
  const sync = syncFromDaily();
  const db = buildDatabase();
  return { sync, db, ...list() };
}

module.exports = {
  list, stats, toggle, remove, clearDone,
  syncFromDaily, buildDatabase, refresh,
  parseDaily,
  memoFile, dbFile, dailyDays
};
