'use strict';
/**
 * 只收不发（observe-only）模式的接收器。
 *
 * 目标：代理账号**只接收**，把当天所有消息——文字、图片/表情包、语音、视频、
 * 文件、链接卡片——连同媒体原文件一起落盘，供每日清单整理；账号一条消息都不发。
 *
 * 为什么单独一个模块：archive.js 只负责纯文本流水（给「上周跟谁聊了啥」用），
 * 不该被塞进网络下载。这里做两件 archive 不做的事：
 *   1) 从 OneBot 事件里保留**完整 segment**（不只是文字和类型标记），
 *      让归档能回答「他发的是哪张图 / 哪段语音」；
 *   2) 异步把媒体原文件下载到 .data/inbox/<日期>/qq/，失败也不影响接收。
 *
 * 媒体 URL 由 NapCat 提供，可能是 http(s) 外链、file:// 本地路径或缓存文件名，
 * 有时效性（QQ 图片链接会过期），所以必须**收到即下载**，不能等生成清单再补。
 *
 * 落盘路径写**独立的 media-index.jsonl**，不塞进聊天归档：归档是给「查聊天记录」
 * 用的，混进 patch 行会让 query 多出没有正文的空记录。清单生成器读两个文件再关联。
 *
 * 归档记录沿用 archive.js 的单字母字段，另外多两个可选字段：
 *   src  'qq'，合并两个平台时用来区分
 *   m    [{t 类型, u 原始URL, n 名称/描述}]（不含落盘路径，见 media-index）
 * 老记录没有这两个字段，query/render 都做了兼容。
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../paths');
const archive = require('./archive');

const MEDIA_SEGMENTS = new Set([
  'image', 'record', 'video', 'file', 'mface', 'face', 'bface', 'sface',
  'json', 'xml', 'share', 'contact', 'location', 'music', 'poke'
]);

/** 当天媒体收件箱。QQ 与微信各一个子目录，避免同名互相覆盖。 */
function inboxDir(tsSec, platform = 'qq') {
  const day = archive.dayOf(tsSec || Math.floor(Date.now() / 1000));
  const d = path.join(dataDir(), 'inbox', day, platform);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function indexFile(tsSec, platform = 'qq') {
  return path.join(inboxDir(tsSec, platform), 'media-index.jsonl');
}

/**
 * 群名缓存：OneBot 的群消息事件里**没有 group_name**，只有 group_id，
 * 归档的 n 会空着，素材库就变成「谁发的不明」。连上后拉一次群列表补上。
 * get_group_list 是只读 API，不受 observeOnly 闸门影响。
 */
let groupNames = {};

function primeGroups(client) {
  if (!client || typeof client.callApi !== 'function') return Promise.resolve(groupNames);
  return client
    .callApi('get_group_list', {})
    .then((list) => {
      for (const g of Array.isArray(list) ? list : []) {
        if (g && g.group_id != null) groupNames[String(g.group_id)] = String(g.group_name || '');
      }
      return groupNames;
    })
    .catch(() => groupNames);
}

/** 从 segment.data 里挑一个能下载的 URL / 本地路径 */
function mediaUrlOf(seg) {
  const d = (seg && seg.data) || {};
  for (const k of ['url', 'file', 'path', 'file_id']) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 人的可读描述：表情名、文件名、卡片标题、语音时长等 */
function mediaNameOf(seg) {
  const d = (seg && seg.data) || {};
  for (const k of ['summary', 'name', 'filename', 'title', 'desc', 'content', 'text']) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
  }
  return d.id != null ? `id=${d.id}` : '';
}

/**
 * 媒体段的附加属性。素材库要分清「照片」和「表情包」，
 * 光看 type=image 不够——QQ 的图片段里 sub_type / summary 才是判据：
 *   summary   "[动画表情]" 之类的现成标签，最可靠
 *   sub_type  NapCat 里 1=普通图片、6/7 常见于表情与商城表情
 *   emoji_id  商城表情才有，有它就一定是表情包
 * 字节数留着给素材库判断「是不是表情小图」和去重成本。
 */
function mediaAttrsOf(seg) {
  const d = (seg && seg.data) || {};
  const out = {};
  if (d.sub_type != null) out.st = Number(d.sub_type) || 0;
  if (d.file_size != null) out.sz = Number(d.file_size) || 0;
  const em = d.emoji_id || d.emoji_package_id;
  if (em) out.em = String(em).slice(0, 40);
  if (d.md5) out.md5 = String(d.md5).slice(0, 40);
  return out;
}

/**
 * 把 OneBot 事件转成「完整」归档记录。
 * 文字仍拼进 x；所有段都进 m，连 at / reply 这类非媒体段也记下来，
 * 清单才能看出「谁 @ 了我」「引用了哪条」。
 */
function fullRecord(event, opts = {}) {
  const rec = archive.fromEvent(event, opts);
  if (!rec) return null;
  rec.src = 'qq';
  const media = [];
  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (!seg || !seg.type) continue;
      media.push(Object.assign(
        { t: seg.type, u: mediaUrlOf(seg), n: mediaNameOf(seg) },
        mediaAttrsOf(seg)
      ));
    }
  } else if (typeof event.message === 'string') {
    media.push({ t: 'text', u: '', n: event.message.slice(0, 1000) });
  }
  if (media.length) rec.m = media;
  return rec;
}

/** URL -> 文件名后缀。取不到就空，后面按 content-type 补。 */
function extOf(url) {
  let p = String(url);
  try {
    p = new URL(url).pathname;
  } catch {
    /* 本地路径直接用 */
  }
  const m = p.match(/\.(jpg|jpeg|png|gif|webp|bmp|mp3|wav|amr|silk|ogg|mp4|avi|mkv|mov|json|xml)$/i);
  return m ? '.' + m[1].toLowerCase() : '';
}

const EXT_BY_TYPE = {
  image: '.jpg', mface: '.gif', bface: '.png', sface: '.png',
  record: '.mp3', video: '.mp4', json: '.json', xml: '.xml'
};
const EXT_BY_MIME = {
  'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/jpeg': '.jpg', 'audio/mpeg': '.mp3', 'audio/wav': '.wav',
  'video/mp4': '.mp4', 'application/json': '.json'
};

/** 下载一个媒体段。返回相对 dataDir 的路径，失败返回 ''。 */
async function saveOne(raw, type, base, tsSec) {
  let buf = null;
  let extraExt = '';
  try {
    if (/^file:\/\//i.test(raw) || (raw.startsWith('/') && !raw.startsWith('//'))) {
      const local = raw.replace(/^file:\/\/\/?/i, '');
      if (fs.existsSync(local)) buf = fs.readFileSync(local);
    } else if (/^https?:\/\//i.test(raw)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(raw, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
        const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
        extraExt = EXT_BY_MIME[ct] || '';
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    return '';
  }
  if (!buf || !buf.length) return '';

  const ext = extOf(raw) || extraExt || EXT_BY_TYPE[type] || '.bin';
  const name = `${base}${ext}`.replace(/[^\w.\-]/g, '_');
  try {
    fs.writeFileSync(path.join(inboxDir(tsSec, 'qq'), name), buf);
  } catch {
    return '';
  }
  return path.relative(dataDir(), path.join(inboxDir(tsSec, 'qq'), name)).replace(/\\/g, '/');
}

/**
 * 接收一条消息：写全量归档 + 后台下载媒体 + 写媒体索引。
 * 下载是 fire-and-forget，绝不阻塞接收主链路（NapCat 事件堆积会掉消息）。
 */
function capture(event, opts = {}) {
  const isGroup = event && event.message_type === 'group';
  // 只收私聊：群消息不归档、不下载媒体。bot.js 的 onMessage 已经拦过一次，
  // 这里是给「别处直接调 capture」留的兜底，两道闸门都不放开群。
  if (isGroup) return null;
  const rec = fullRecord(event, Object.assign({}, opts, {
    chatName: opts.chatName || ''
  }));
  if (!rec) return null;
  try {
    archive.append(rec);
  } catch {
    /* 归档失败也要继续尝试下载 */
  }
  const list = rec.m || [];
  const jobs = list
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => MEDIA_SEGMENTS.has(m.t) && m.u);
  if (!jobs.length) return rec;

  Promise.all(
    jobs.map(({ m, i }) => saveOne(m.u, m.t, `${rec.mid || 'n'}_${i}`, rec.t))
  )
    .then((files) => {
      const rows = [];
      files.forEach((f, k) => {
        if (!f) return;
        const { m, i } = jobs[k];
        rows.push({
          t: rec.t, src: 'qq', mid: rec.mid, id: rec.id, n: rec.n,
          i, type: m.t, name: m.n, url: m.u, file: f,
          // 素材库判类要用：sub_type / 字节数 / 商城表情 id
          st: m.st || 0, sz: m.sz || 0, em: m.em || ''
        });
      });
      if (!rows.length) return;
      try {
        fs.appendFileSync(
          indexFile(rec.t, 'qq'),
          rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
        );
      } catch {
        /* 索引写失败不影响已下载的文件 */
      }
    })
    .catch(() => {});
  return rec;
}

module.exports = {
  capture, fullRecord, inboxDir, indexFile, primeGroups,
  mediaUrlOf, mediaNameOf, mediaAttrsOf, MEDIA_SEGMENTS
};
