'use strict';

/**
 * 共享媒体库：QQ 机器人（Node）和微信机器人（Python）共用同一个素材池。
 *
 * 之前两套各管各的：QQ 收集表情到 `.data/memes/`，微信从 `wechat-bot/stickers/` 取，
 * 语音也是各合成各的、缓存各存各的。同一个「晚安」两边要各调一次 TTS 付费接口，
 * 表情包更是互相看不见 —— 池子永远长不大。
 *
 * 现在统一到 `.data/media/`：
 *
 *   media/
 *     pics/          所有图片（表情包、梗图、照片）
 *     voice/         所有音频（预置片段 + TTS 缓存）
 *     library.json   统一索引（两边进程都读写这一份）
 *
 * 索引只是一个「补充信息表」：目录里的文件才是真相。手工往 pics/ 里丢图也会被
 * 自动补录（`syncFromDisk`），所以用户想加素材直接拷文件就行，不用改 JSON。
 *
 * 并发：Node 和 Python 两个进程都会写这一份 JSON。这里用「改之前强制重读 + 临时
 * 文件原子 rename」把冲突窗口压到最小。丢一次计数不影响任何功能，丢一条新素材才是
 * 事故 —— 所以新增条目总是先落图片文件、再写索引，宁可索引有孤儿也不丢文件。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('../paths');
const { dbg } = require('../debug');

const PIC_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const MAX_PICS = 500; // 超过就淘汰最久没被用过的
const MAX_VOICE = 400; // 预置片段永不被淘汰
const MIN_PIC_BYTES = 1200; // 太小的多半是头像占位图 / 坏图
const SCAN_THROTTLE_MS = 5000;

function root() {
  return path.join(dataDir(), 'media');
}

function picsDir() {
  const d = path.join(root(), 'pics');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function voiceDir() {
  const d = path.join(root(), 'voice');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function indexFile() {
  return path.join(root(), 'library.json');
}

/** 旧版 QQ 表情库目录。首次运行时把里面的图搬进 pics/。 */
function legacyMemeDir() {
  return path.join(dataDir(), 'memes');
}

let cache = null; // { stamp, data }
let lastScanAt = 0;

function emptyIndex() {
  return { version: 2, seq: 0, pics: [], voice: [] };
}

function stampOf(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

function loadIndex(force = false) {
  const file = indexFile();
  const stamp = stampOf(file);
  if (!force && cache && cache.stamp === stamp) return cache.data;
  let data = emptyIndex();
  if (stamp !== 'none') {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      data = { ...data, ...raw };
      if (!Array.isArray(data.pics)) data.pics = [];
      if (!Array.isArray(data.voice)) data.voice = [];
    } catch (err) {
      dbg('[media] library.json 损坏，按空库继续：', err.message);
    }
  }
  cache = { stamp, data };
  return data;
}

function saveIndex(data) {
  const file = indexFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    cache = { stamp: stampOf(file), data };
    return true;
  } catch (err) {
    dbg('[media] 写 library.json 失败：', err.message);
    cache = null;
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** 按文件头猜扩展名，不看 url / 文件名（QQ 给的图经常没有可信后缀） */
function sniffExt(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf.length > 4 && buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
  if (buf.length > 4 && buf.slice(0, 4).toString('latin1') === 'RIFF') return '.webp';
  if (buf.length > 3 && buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp';
  return '.jpg';
}

/** 文件 id 只允许纯文件名，拦住 `../` 这类路径穿越 */
function safeName(name) {
  const s = String(name || '');
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) return null;
  return s;
}

function picPath(id) {
  const n = safeName(id);
  if (!n) return null;
  return path.join(picsDir(), n);
}

/**
 * 把目录里还没进索引的图片补录进来（用户手工拷素材就是这么生效的）。
 * 节流：每次调用最多 5 秒扫一次，避免每条消息都 readdir。
 */
function syncFromDisk(force = false) {
  const now = Date.now();
  if (!force && now - lastScanAt < SCAN_THROTTLE_MS) return 0;
  lastScanAt = now;
  let added = 0;
  try {
    const dir = picsDir();
    const idx = loadIndex(true);
    const known = new Set(idx.pics.map((x) => x.id));
    for (const f of fs.readdirSync(dir)) {
      if (!PIC_EXTS.includes(path.extname(f).toLowerCase())) continue;
      if (known.has(f)) continue;
      let st;
      try {
        st = fs.statSync(path.join(dir, f));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      idx.pics.push({
        id: f,
        hash: '',
        kind: guessKind(f),
        desc: '',
        from: 'manual',
        addedAt: st.mtimeMs || Date.now(),
        uses: 0,
        lastUsedAt: 0
      });
      added += 1;
    }
    if (added) {
      saveIndex(idx);
      dbg('[media] 补录手工素材', added, '个');
    }
  } catch (err) {
    dbg('[media] 扫描 pics 失败：', err.message);
  }
  return added;
}

/** 目录名/文件名里带这些词，多半就是表情包；其余当普通图片 */
function guessKind(name) {
  return /meme|sticker|表情|梗|doge|gif$/i.test(name) ? 'sticker' : 'pic';
}

/** 把旧版 `.data/memes/` 整体搬进共享池。搬完把旧目录改名，避免下次重复搬。 */
function migrateLegacy() {
  const old = legacyMemeDir();
  try {
    if (!fs.existsSync(old)) return 0;
    const files = fs.readdirSync(old).filter((f) => PIC_EXTS.includes(path.extname(f).toLowerCase()));
    if (!files.length) {
      // 只剩一个 catalog.json / 空目录，直接收掉
      fs.rmSync(old, { recursive: true, force: true });
      return 0;
    }
    const dir = picsDir();
    let moved = 0;
    for (const f of files) {
      const dst = path.join(dir, f);
      if (fs.existsSync(dst)) continue;
      try {
        fs.renameSync(path.join(old, f), dst);
        moved += 1;
      } catch (err) {
        dbg('[media] 迁移表情失败：', f, err.message);
      }
    }
    // 旧目录里可能还有 catalog.json，里面的 desc 是有价值的，尝试合并
    mergeLegacyCatalog(old, files);
    fs.rmSync(old, { recursive: true, force: true });
    if (moved) dbg('[media] 从旧表情库迁移', moved, '张');
    lastScanAt = 0;
    syncFromDisk(true);
    return moved;
  } catch (err) {
    dbg('[media] 迁移旧表情库失败：', err.message);
    return 0;
  }
}

function mergeLegacyCatalog(oldDir, files) {
  try {
    const p = path.join(oldDir, 'catalog.json');
    if (!fs.existsSync(p)) return;
    const cat = JSON.parse(fs.readFileSync(p, 'utf8'));
    const items = Array.isArray(cat.items) ? cat.items : [];
    if (!items.length) return;
    const idx = loadIndex(true);
    let touched = false;
    for (const old of items) {
      if (!files.includes(old.name)) continue;
      const hit = idx.pics.find((x) => x.id === old.name);
      if (hit && !hit.desc && old.desc) {
        hit.desc = old.desc;
        hit.hash = old.hash || hit.hash;
        touched = true;
      }
    }
    if (touched) saveIndex(idx);
  } catch (err) {
    dbg('[media] 合并旧 catalog 失败：', err.message);
  }
}

/**
 * 收一张图进池。重复（md5 相同）直接返回已有条目。
 * @returns 条目对象，或 null（图太小 / 写盘失败）
 */
function addPic(buf, opts = {}) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < MIN_PIC_BYTES) return null;
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    const idx = loadIndex(true); // 强制重读：另一个进程可能刚写过
    const dup = idx.pics.find((x) => x.hash === hash);
    if (dup && fs.existsSync(path.join(picsDir(), dup.id))) return dup;

    const ext = sniffExt(buf);
    const seq = (Number(idx.seq) || 0) + 1;
    idx.seq = seq;
    const id = safeName(opts.name) || `meme-${seq}${ext}`;
    const file = path.join(picsDir(), id);
    fs.writeFileSync(file, buf); // 先落文件再写索引：宁可有孤儿文件，也别丢图
    const item = {
      id,
      hash,
      kind: opts.kind || 'sticker',
      desc: String(opts.desc || '').slice(0, 40),
      from: opts.from || '',
      addedAt: Date.now(),
      uses: 0,
      lastUsedAt: 0
    };
    idx.pics.push(item);
    prune(idx);
    saveIndex(idx);
    return item;
  } catch (err) {
    dbg('[media] 收图失败：', err.message);
    return null;
  }
}

/** 超量时淘汰最久没被用过的：先按 uses 少、再按 lastUsedAt 旧 */
function prune(idx) {
  if (idx.pics.length <= MAX_PICS) return;
  const victims = [...idx.pics]
    .sort((a, b) => (a.uses || 0) - (b.uses || 0) || (a.lastUsedAt || 0) - (b.lastUsedAt || 0))
    .slice(0, idx.pics.length - MAX_PICS);
  const dead = new Set(victims.map((x) => x.id));
  idx.pics = idx.pics.filter((x) => !dead.has(x.id));
  for (const v of victims) {
    try {
      fs.unlinkSync(path.join(picsDir(), v.id));
    } catch {
      /* ignore */
    }
  }
  dbg('[media] 池满，淘汰', victims.length, '张');
}

/** 列图片。kind 传 'sticker' / 'pic'，不传=全部 */
function listPics(opts = {}) {
  syncFromDisk();
  const idx = loadIndex();
  const want = opts.kind;
  return idx.pics.filter((x) => {
    if (want && x.kind !== want) return false;
    if (opts.withDesc && !x.desc) return false;
    const p = path.join(picsDir(), x.id);
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function findPic(id) {
  const n = safeName(id);
  if (!n) return null;
  const idx = loadIndex();
  const hit = idx.pics.find((x) => x.id === n);
  const p = path.join(picsDir(), n);
  if (!fs.existsSync(p)) return null;
  return hit ? { ...hit, path: p } : { id: n, path: p, kind: guessKind(n), desc: '' };
}

/** 视觉模型打完标后回写用途描述 */
function setPicDesc(id, desc) {
  const n = safeName(id);
  if (!n) return false;
  const idx = loadIndex(true);
  const hit = idx.pics.find((x) => x.id === n);
  if (!hit) return false;
  hit.desc = String(desc || '').slice(0, 40);
  return saveIndex(idx);
}

/** 随机挑一张。exclude 传刚发过的 id，避免连着发同一张 */
function pickPic(opts = {}) {  const pool = listPics(opts);
  if (!pool.length) return null;
  const excl = new Set(opts.exclude || []);
  const fresh = pool.filter((x) => !excl.has(x.id));
  const use = fresh.length ? fresh : pool;
  const item = use[Math.floor(Math.random() * use.length)];
  notePicUsed(item.id);
  return { ...item, path: path.join(picsDir(), item.id) };
}

/** 记账（内存里累加 + 落盘节流），淘汰时靠它区分冷热 */
let dirtyPics = 0;
function notePicUsed(id) {
  const idx = loadIndex();
  const hit = idx.pics.find((x) => x.id === id);
  if (!hit) return;
  hit.uses = (hit.uses || 0) + 1;
  hit.lastUsedAt = Date.now();
  dirtyPics += 1;
  if (dirtyPics >= 8) {
    dirtyPics = 0;
    saveIndex(idx);
  }
}

/* ------------------------------------------------------------------ */
/* 语音库：预置片段 + TTS 合成缓存                                      */
/* ------------------------------------------------------------------ */

/** 同一句话 + 同一音色 + 同一模型 -> 同一个缓存键 */
function voiceHash(text, voice, model) {
  return crypto
    .createHash('md5')
    .update(`${model || ''}|${voice || ''}|${String(text || '').trim()}`)
    .digest('hex');
}

/**
 * 找现成音频。优先级：人工预置片段 > 同文本的合成缓存。
 * @returns 文件绝对路径，没有就 null
 */
function findVoice(text, voice, model) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const idx = loadIndex();
  const hit = idx.voice.find((x) => x.text === clean && x.kind === 'preset');
  if (hit && voiceFileExists(hit.id)) return path.join(voiceDir(), hit.id);
  const key = voiceHash(clean, voice, model);
  const tts = idx.voice.find((x) => x.hash === key);
  if (tts && voiceFileExists(tts.id)) {
    noteVoiceUsed(tts.id);
    return path.join(voiceDir(), tts.id);
  }
  return null;
}

/** 按 id（不带目录）取音频，供 [语音:xxx] 标记使用 */
function voiceById(id) {
  const n = safeName(id);
  if (!n) return null;
  const p = path.join(voiceDir(), n);
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/** 按文字找预置片段：先精确，再包含（模型多半会多带一两个字） */
function findPreset(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const idx = loadIndex();
  const presets = idx.voice.filter((x) => x.kind === 'preset' && voiceFileExists(x.id));
  const exact = presets.find((x) => x.text === clean);
  if (exact) return { ...exact, path: path.join(voiceDir(), exact.id) };
  const loose = presets.find((x) => x.text.includes(clean) || clean.includes(x.text));
  return loose ? { ...loose, path: path.join(voiceDir(), loose.id) } : null;
}

function listPresets() {
  const idx = loadIndex();
  return idx.voice.filter((x) => x.kind === 'preset' && voiceFileExists(x.id));
}

function voiceFileExists(id) {
  try {
    return fs.statSync(path.join(voiceDir(), id)).isFile();
  } catch {
    return false;
  }
}

/**
 * 存一段音频进语音池。
 * @param buf  mp3/wav 内容
 * @param meta { text, voice, model, kind: 'tts'|'preset', id? }
 * @returns 文件绝对路径，失败 null
 */
function putVoice(buf, meta = {}) {
  try {
    if (!Buffer.isBuffer(buf) || !buf.length) return null;
    const text = String(meta.text || '').trim();
    const kind = meta.kind || 'tts';
    const hash = voiceHash(text, meta.voice, meta.model);
    const idx = loadIndex(true);
    const exist = idx.voice.find((x) => x.hash === hash && x.kind === kind);
    if (exist && voiceFileExists(exist.id)) {
      if (meta.desc && !exist.desc) {
        exist.desc = String(meta.desc).slice(0, 30);
        saveIndex(idx);
      }
      return path.join(voiceDir(), exist.id);
    }
    const id = safeName(meta.id) || `v-${hash.slice(0, 10)}.mp3`;
    fs.writeFileSync(path.join(voiceDir(), id), buf);
    idx.voice.push({
      id,
      hash,
      text,
      kind,
      desc: String(meta.desc || '').slice(0, 30),
      voice: meta.voice || '',
      model: meta.model || '',
      from: meta.from || '',
      addedAt: Date.now(),
      uses: 0,
      lastUsedAt: 0
    });
    pruneVoice(idx);
    saveIndex(idx);
    return path.join(voiceDir(), id);
  } catch (err) {
    dbg('[media] 存语音失败：', err.message);
    return null;
  }
}

function pruneVoice(idx) {
  if (idx.voice.length <= MAX_VOICE) return;
  const victims = idx.voice
    .filter((x) => x.kind !== 'preset')
    .sort((a, b) => (a.uses || 0) - (b.uses || 0) || (a.lastUsedAt || 0) - (b.lastUsedAt || 0))
    .slice(0, Math.max(0, idx.voice.length - MAX_VOICE));
  const dead = new Set(victims.map((x) => x.id));
  idx.voice = idx.voice.filter((x) => !dead.has(x.id));
  for (const v of victims) {
    try {
      fs.unlinkSync(path.join(voiceDir(), v.id));
    } catch {
      /* ignore */
    }
  }
}

let dirtyVoice = 0;
function noteVoiceUsed(id) {
  const idx = loadIndex();
  const hit = idx.voice.find((x) => x.id === id);
  if (!hit) return;
  hit.uses = (hit.uses || 0) + 1;
  hit.lastUsedAt = Date.now();
  dirtyVoice += 1;
  if (dirtyVoice >= 8) {
    dirtyVoice = 0;
    saveIndex(idx);
  }
}

/** 提示词里给模型看的素材清单：[图:id] = 用途 */
function picListText(opts = {}) {
  const max = opts.max || 25;
  const list = listPics({ kind: opts.kind || 'sticker', withDesc: true })
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .slice(0, max);
  return list.map((x) => `[图:${x.id}] = ${x.desc}`).join('\n');
}

/** 提示词里给模型看的预置语音清单：[语音:文字] */
function presetListText(max = 20) {
  const list = listPresets()
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .slice(0, max);
  return list.map((x) => `[语音:${x.text}]`).join('、');
}

function stats() {
  const idx = loadIndex();
  return {
    root: root(),
    pics: idx.pics.length,
    stickers: idx.pics.filter((x) => x.kind === 'sticker').length,
    voice: idx.voice.length,
    presets: idx.voice.filter((x) => x.kind === 'preset').length
  };
}

module.exports = {
  root,
  picsDir,
  voiceDir,
  indexFile,
  loadIndex,
  saveIndex,
  addPic,
  listPics,
  findPic,
  pickPic,
  setPicDesc,
  picPath,
  guessKind,
  syncFromDisk,
  migrateLegacy,
  voiceHash,
  findVoice,
  voiceById,
  findPreset,
  listPresets,
  putVoice,
  picListText,
  presetListText,
  stats
};
