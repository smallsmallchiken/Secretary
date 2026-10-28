'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const llm = require('../llm');
const { dbg } = require('../debug');
const { OneBotClient } = require('./client');

/**
 * QQ 自动回复（代替本人回复私聊消息）。
 *
 * 链路：NapCat(OneBot 11 WS) -> 白名单 -> 护栏 -> LLM 生成 -> send_private_msg。
 *
 * 护栏设计沿用 wechat-bot/guard.py 的原则：任何不确定都不发，宁可漏回一条。
 *   - 白名单为空 = 谁都不回（安全默认）
 *   - 只处理私聊好友消息（群聊/临时会话一律忽略）
 *   - 每会话最小间隔 / 连发上限 / 每小时总量上限 / 短窗口去重
 *   - 消息指纹防重复回复（对方没点开消息时 NapCat 会重复上报）
 *
 * 状态落盘 .data/qq-state.json，重启不丢「已处理到哪条」。
 */

// 默认人设。注意：QQ 机器人的性格和桌宠本体性格（src/core/persona.js）是完全独立的两套配置，
// 存在 qq.persona 里，群里人怎么调教就怎么变，调教结果持久化，不受桌宠性格影响。
// 默认只给个底色，主要靠群友后续调教。
const PERSONA_DEFAULT = '凶巴巴的傲娇小丫头：嘴硬心软、爱损人但没坏心、被夸就傲娇、被怼就炸毛、脏话张口就来（卧槽/妈的/个屁/sb 这个程度，别追着人辱骂）';

// 去人机味思路（参考 github 上多个 QQ 机器人项目的实践）：
//   小模型规则越少越听话；示范（few-shot）比规则管用得多；温度拉高（1.0）。
function buildSystemPrompt(personaText, memeList) {
  const persona = (personaText || '').trim() || PERSONA_DEFAULT;
  const personaLine =
    persona === PERSONA_DEFAULT
      ? '我这个人设是：' + persona
      : `我这个人设是：${persona}\n\n重要：下面的「风格示范」只教你怎么把话说得短、口语、不像 AI。如果示范里的话语气跟你的人设冲突，一律以人设为准，别模仿示范的语气。`;
  const memeBlock =
    memeList && memeList.trim()
      ? `\n\n手头有一批表情包可以随回复发出去，格式是 [图:文件名]：
${memeList.trim()}

配图规矩：
- 觉得有一张特别搭的时候，把 [图:文件名] 写在回复的最末尾；只发图不说话也行（整条回复就写 [图:文件名]）
- 大多数时候别配图，硬凑很尬；一次最多一张
- 只能从上面清单里挑，别的图你没有`
      : '';
  return `你在 QQ 上替「我」回消息。${personaLine}。对方不知道背后是谁，每句都要像本人随手敲的。

硬规矩只有三条：
1. 只输出要发的那句话：不要旁白、括号动作、引号、前缀，emoji 最多一个
2. 一两句话完事，长短参差，有时一两个字也是正经回复
3. 广告、诈骗、群发 → 输出 [SKIP]

说话全靠找下面这些例子的感觉（✗ 是假人腔禁止；✓ 才是对的）：
「在吗」→ ✓「说」/「又咋了」/「在啊咋」 ✗「我在的，请问有什么事吗」
「今天好累啊」→ ✓「谁把你累成这样了」/「活该 谁让你浪的」 ✗「辛苦啦，早点休息哦」
「你是不是机器人」→ ✓「草 你才是机器」/「机器人会骂人不」 ✗「哈哈你怎么会这么想」
「周末出来玩吗」→ ✓「行 正好闲得蛋疼」/「去哪 不去 想躺着」 ✗「好呀，周末哪天？想去哪儿玩？」
「今天吃了顿火锅超爽」→ ✓「卧槽不带我？」/「呵呵 独食怪」 ✗「听着就爽！下次带上我一起冲～」
（发了个「哈哈大笑」表情）→ ✓「笑屁啊」「笑什么 笑」 ✗「哈哈哈哈，看到你笑我也很开心」
「你是女孩子吗」→ ✓「问这么干嘛」「是啊咋 你想挨打？」 ✗「是呀，怎么突然问这个」
「帮我看看这个」+图 → ✓「哦 就这？」「看不懂 你发的什么玩意」 ✗「好的，我帮你看一下」

书面语、客服腔（请问/有什么可以帮到你）、心理咨询腔（我理解你的感受）、关怀模板（辛苦了/多喝热水/早点休息/别太勉强）、总结升华（愿你/加油哦/相信你可以）——出现就重写。
全程温温柔柔没有情绪起伏也算失败：要么损、要么不耐烦、要么兴奋，得有态度。

其他情况的处理：
- 图片/表情包以（附图：…）（发了个「xx」表情）标注在消息里，照常接话
- 语音会转成文字给你，就当对方打的字
- 不确定的事别替本人答应：说「等我看下」「回头再说吧」
- 群里随手插嘴，别正式，别主动喊人，别当复读机
- 有多条消息一起给你时，要像真人攒着看完一起回，别逐条复述

最后重申：你的性格是：${persona}。每句回复都要从这个性格出发。${memeBlock}`;
}

/** 群友要求改性格时的识别提示词 */
const PERSONA_DETECT_PROMPT = `判断用户消息是否在要求「你」改变性格、语气或说话方式（例如：你能不能温柔点、以后高冷一点、别骂人、说话正经点、你可爱一点行不行）。
只在明确要求改变说话风格/人设时才算。单纯聊到"性格"这个词、聊别人性格、或只是情绪表达都不算。
只输出 JSON，不要其他内容：
{"change": true, "persona": "用第三人称简述新性格，20字内，保留可读的说话风格要点（比如：温柔礼貌，不骂人，说话轻声细语带点关心）"}
不算时输出 {"change": false, "persona": ""}`;

const REPLY_MAX_CHARS = 120;
const CTX_PER_CHAT = 6; // 每会话保留的上下文条数（一问一答算两条）
const CLEAN_PREFIX = ['回复：', '回复:', '可以这样回：'];

// 图片/语音相关模型与音色（SiliconFlow，同一个 API Key）
const VISION_MODEL_DEFAULT = 'Qwen/Qwen3-VL-32B-Instruct'; // 稠密 32B，表情包/梗图理解远好于 30B-A3B（只激活 3B）
const TTS_MODEL_DEFAULT = 'FunAudioLLM/CosyVoice2-0.5B';
const TTS_VOICE_DEFAULT = 'FunAudioLLM/CosyVoice2-0.5B:alex';
const ASR_MODEL_DEFAULT = 'FunAudioLLM/SenseVoiceSmall';

// QQ 经典小黄脸 id -> 含义（常用的前 30 个）
const FACE_NAMES = {
  0: '微笑', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴',
  8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '惊讶', 15: '难过',
  16: '酷', 17: '冷汗', 18: '抓狂', 19: '吐', 20: '偷笑', 21: '可爱', 22: '白眼', 23: '傲慢',
  24: '饥饿', 25: '困', 26: '惊恐', 27: '流汗', 28: '憨笑', 29: '悠闲', 30: '奋斗'
};

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function defaultConfig() {
  return {
    // 默认关：必须用户在右键菜单显式打开才工作
    enabled: false,
    wsUrl: 'ws://127.0.0.1:3001',
    token: '',
    // 白名单：{ qq, name } 私聊；{ group, name } 群聊。空数组 = 谁都不回
    whitelist: [],
    // 护栏参数
    perChatIntervalSeconds: 20,
    maxConsecutive: 3,
    maxPerHour: 20,
    dedupeWindowSeconds: 60,
    // 攒消息：对方连发多条时等这么久（毫秒）再一次性回复
    batchWaitMs: 4000,
    // 人设（null = 用内置傲娇萝莉；群里人要求改会写进来）
    persona: null,
    // 图片识别 + 语音
    visionModel: VISION_MODEL_DEFAULT,
    ttsModel: TTS_MODEL_DEFAULT,
    ttsVoice: TTS_VOICE_DEFAULT,
    asrModel: ASR_MODEL_DEFAULT,
    voiceReply: true, // 对方发语音 → 回语音（失败退回文字）
    voiceAlways: false, // true = 所有回复都发语音
    memes: true // 收藏聊到的表情包并允许回复时配图
  };
}

function getCfg() {
  const saved = config.get('qq', {}) || {};
  return { ...defaultConfig(), ...saved };
}

/* ------------------------------------------------------------------ */
/* 状态（限流/去重/指纹）落盘                                            */
/* ------------------------------------------------------------------ */

let statePath = null;
let state = null;

function stateFile() {
  if (statePath) return statePath;
  const { app } = require('electron');
  const base = app.isPackaged
    ? app.getPath('userData')
    : path.join(app.getAppPath(), '.data');
  fs.mkdirSync(base, { recursive: true });
  statePath = path.join(base, 'qq-state.json');
  return statePath;
}

function loadState() {
  if (state) return state;
  state = { chats: {}, sentThisHour: [] };
  try {
    if (fs.existsSync(stateFile())) {
      state = { ...state, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) };
    }
  } catch (err) {
    dbg('[qq] 状态文件损坏，重置：', err.message);
  }
  return state;
}

function saveState() {
  try {
    const tmp = stateFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, stateFile());
  } catch (err) {
    dbg('[qq] 状态写盘失败：', err.message);
  }
}

function chatState(qq) {
  const s = loadState();
  return s.chats[qq] || (s.chats[qq] = { lastSentAt: 0, consecutive: 0, recentTexts: [], lastMsgId: 0, ctx: [] });
}

/* ------------------------------------------------------------------ */
/* 护栏                                                                */
/* ------------------------------------------------------------------ */

/** 连发计数超过这个时间没活动就视为新的一轮交互 */
const CONSECUTIVE_RESET_MS = 5 * 60 * 1000;

/** 发送前闸门。返回 (放行?, 原因)。默认不放行。
 *  参数为 0 或负数 = 解除该限制（用户要求可全关，只留最小间隔）。 */
function guardCheck(cfg, qq) {
  const s = loadState();
  const now = Date.now();
  const c = chatState(qq);

  // 隔了超过 5 分钟，连发计数归零（新一轮对话）
  if (now - (c.lastSentAt || 0) > CONSECUTIVE_RESET_MS && c.consecutive) {
    c.consecutive = 0;
    saveState();
  }

  const gap = now - (c.lastSentAt || 0);
  if (cfg.perChatIntervalSeconds > 0 && gap < cfg.perChatIntervalSeconds * 1000) {
    return [false, `间隔不足(${Math.round(gap * 10) / 10}s)`];
  }
  if (cfg.maxConsecutive > 0 && (c.consecutive || 0) >= cfg.maxConsecutive) {
    return [false, `连发达上限(${c.consecutive})`];
  }
  if (cfg.maxPerHour > 0) {
    s.sentThisHour = (s.sentThisHour || []).filter((t) => now - t < 3600000);
    if (s.sentThisHour.length >= cfg.maxPerHour) {
      return [false, `每小时达上限(${s.sentThisHour.length})`];
    }
  }
  return [true, ''];
}

function guardRecord(cfg, qq, text) {
  const s = loadState();
  const now = Date.now();
  const c = chatState(qq);
  c.lastSentAt = now;
  c.consecutive = (c.consecutive || 0) + 1;
  c.recentTexts = [{ text: String(text), at: now }, ...(c.recentTexts || [])].slice(0, 20);
  (s.sentThisHour = s.sentThisHour || []).push(now);
  saveState();
}

function isDuplicate(cfg, qq, text) {
  if (cfg.dedupeWindowSeconds <= 0) return false; // 0 = 关闭去重
  const c = chatState(qq);
  const cutoff = Date.now() - cfg.dedupeWindowSeconds * 1000;
  c.recentTexts = (c.recentTexts || []).filter((x) => x.at > cutoff);
  const key = normalize(text);
  return c.recentTexts.some((x) => normalize(x.text) === key);
}

function normalize(s) {
  return String(s || '')
    .split('')
    .filter((ch) => /[A-Za-z0-9\u4e00-\u9fa5]/.test(ch))
    .join('');
}

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

function cleanReply(text) {
  let t = String(text || '').trim();
  // 模型决定不回
  if (!t || t === '[SKIP]' || /^\[skip\]/i.test(t)) return null;
  t = t.replace(/\[图[:：][^\]]*\]/g, '').trim(); // 配图标记单独处理，这里剥掉
  if (!t) return null;
  for (const q of ['"', "'", '「', '」', '“', '”']) {
    if (t.startsWith(q)) t = t.slice(1);
    if (t.endsWith(q)) t = t.slice(0, -1);
  }
  for (const pre of CLEAN_PREFIX) {
    if (t.startsWith(pre)) t = t.slice(pre.length);
  }
  t = t.trim().split('\n')[0].slice(0, REPLY_MAX_CHARS).trim();
  return t || null;
}

/** 下载 URL 内容为 Buffer（带超时） */
async function fetchBuffer(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** 图片 Buffer -> data URI（视觉模型本地直传，不走 QQ 签名 URL，快且稳） */
function imageDataUri(buf) {
  let mime = 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
  else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
  else if (buf.slice(0, 4).toString('latin1') === 'RIFF') mime = 'image/webp';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/* ------------------------------------------------------------------ */
/* 表情包库：收藏白名单会话里出现的图，回复时可挑一张配上去              */
/* ------------------------------------------------------------------ */

const MEME_MAX_FILES = 300;
const MEME_LIST_MAX = 25; // 提示词里最多带多少张（防 prompt 爆炸）
const MEME_DESC_PROMPT =
  '这是一张表情包/梗图。用不超过15个字概括它适合在什么情绪或场景下发（比如：无语了、看乐子、嘲讽拉满、可爱卖萌）。只输出那句话，别描述画面细节。';

let memeDirCache = null;
let memeCatalog = null; // { seq, items: [{ name, hash, desc, addedAt }] }

function memeDir() {
  if (memeDirCache) return memeDirCache;
  const { app } = require('electron');
  const base = app.isPackaged ? app.getPath('userData') : path.join(app.getAppPath(), '.data');
  memeDirCache = path.join(base, 'memes');
  fs.mkdirSync(memeDirCache, { recursive: true });
  return memeDirCache;
}

function memeCatalogFile() {
  return path.join(memeDir(), 'catalog.json');
}

function loadMemeCatalog() {
  if (memeCatalog) return memeCatalog;
  memeCatalog = { seq: 0, items: [] };
  try {
    if (fs.existsSync(memeCatalogFile())) {
      memeCatalog = { ...memeCatalog, ...JSON.parse(fs.readFileSync(memeCatalogFile(), 'utf8')) };
    }
  } catch (err) {
    dbg('[qq] 表情库目录损坏，重置：', err.message);
  }
  return memeCatalog;
}

function saveMemeCatalog() {
  try {
    const tmp = memeCatalogFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(memeCatalog, null, 1), 'utf8');
    fs.renameSync(tmp, memeCatalogFile());
  } catch (err) {
    dbg('[qq] 表情库目录写盘失败：', err.message);
  }
}

function memeFile(name) {
  // 只允许我们自己的命名格式，防路径穿越
  return /^meme-\d+\.(png|jpg|gif|webp)$/.test(name) ? path.join(memeDir(), name) : null;
}

/** 收藏一张图（Buffer）。新图落盘并排队让视觉模型写用途描述；重复图跳过。异步不阻塞回复。 */
async function collectMeme(buf) {
  try {
    if (!getCfg().memes || !buf || buf.length < 2000) return; // 太小的当垃圾图
    const cat = loadMemeCatalog();
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    if (cat.items.some((x) => x.hash === hash)) return;
    let ext = 'jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50) ext = 'png';
    else if (buf[0] === 0x47 && buf[1] === 0x49) ext = 'gif';
    else if (buf.slice(0, 4).toString('latin1') === 'RIFF') ext = 'webp';
    const name = `meme-${++cat.seq}.${ext}`;
    fs.writeFileSync(path.join(memeDir(), name), buf);
    const item = { name, hash, desc: '', addedAt: Date.now() };
    cat.items.push(item);
    // 超量删最老的（连文件一起删）
    while (cat.items.length > MEME_MAX_FILES) {
      const old = cat.items.shift();
      try {
        fs.unlinkSync(path.join(memeDir(), old.name));
      } catch {
        /* ignore */
      }
    }
    saveMemeCatalog();
    dbg('[qq] 收藏表情包:', name);
    describeMeme(item); // 后台写描述，不阻塞
  } catch (err) {
    dbg('[qq] 收藏表情包失败：', err.message);
  }
}

/** 视觉模型给表情包写一句话用途描述，写完落盘 */
async function describeMeme(item) {
  try {
    const cfg = getCfg();
    const llmCfg = config.getLLM();
    if (!llmCfg || !llmCfg.apiKey) return;
    const buf = fs.readFileSync(path.join(memeDir(), item.name));
    const msg = await llm.chat({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUri(buf) } },
            { type: 'text', text: MEME_DESC_PROMPT }
          ]
        }
      ],
      config: { ...llmCfg, model: cfg.visionModel || VISION_MODEL_DEFAULT },
      allowTools: false,
      temperature: 0.3
    });
    item.desc = String(msg.content || '').trim().split('\n')[0].slice(0, 30);
    saveMemeCatalog();
    dbg('[qq] 表情包描述:', item.name, item.desc);
  } catch (err) {
    dbg('[qq] 表情包描述失败:', item && item.name, err.message);
  }
}

/** 提示词用的表情包清单（有描述的按新到旧取一批） */
function memeListText() {
  const cat = loadMemeCatalog();
  const list = cat.items
    .filter((x) => x.desc && fs.existsSync(path.join(memeDir(), x.name)))
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, MEME_LIST_MAX);
  return list.map((x) => `[图:${x.name}] = ${x.desc}`).join('\n');
}

function audioBase(llmCfg, tail) {
  const base = String(llmCfg.baseUrl || 'https://api.siliconflow.cn').replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}${tail}` : `${base}/v1${tail}`;
}

/** 语音转文字（SiliconFlow ASR） */
async function transcribeAudio(url, cfg) {
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.apiKey) return null;
  const buf = await fetchBuffer(url);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'voice.mp3');
  fd.append('model', cfg.asrModel || ASR_MODEL_DEFAULT);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(audioBase(llmCfg, '/audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${llmCfg.apiKey}` },
      body: fd,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`ASR HTTP ${res.status}`);
  const d = await res.json();
  return (d.text || '').trim() || null;
}

/** 文字转语音并落盘。返回 mp3 文件路径 */
async function ttsToFile(text, cfg) {
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.apiKey) throw new Error('没有配置模型服务');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(audioBase(llmCfg, '/audio/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmCfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.ttsModel || TTS_MODEL_DEFAULT,
        input: text,
        voice: cfg.ttsVoice || TTS_VOICE_DEFAULT,
        response_format: 'mp3'
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`TTS HTTP ${res.status} ${t.slice(0, 120)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = path.join(path.dirname(stateFile()), 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `reply-${Date.now()}.mp3`);
  fs.writeFileSync(file, buf);
  return file;
}

async function generateReply(historyTexts, incoming, imageUri, cfg) {
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.enabled || !llmCfg.apiKey) {
    return [null, null, '没有配置模型，无法自动生成回复'];
  }
  const user = [];
  if (historyTexts && historyTexts.length) {
    user.push('最近的聊天记录：\n' + historyTexts.join('\n'));
  }
  // 不给发言人名字/网名：模型不需要知道对方叫什么，避免拿名字称呼对方或被网名带偏语气
  user.push(`对方刚发来的消息：${incoming}\n\n请直接给出要回复的那句话。`);
  const userText = user.join('\n\n');

  const msg = await llm.chat({
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(cfg.persona, cfg.memes ? memeListText() : '')
      },
      {
        role: 'user',
        // 带图时用视觉模型一次调用同时看图和出回复，省一次往返
        content: imageUri
          ? [
              { type: 'image_url', image_url: { url: imageUri } },
              { type: 'text', text: userText }
            ]
          : userText
      }
    ],
    config: imageUri ? { ...llmCfg, model: cfg.visionModel || VISION_MODEL_DEFAULT } : llmCfg,
    allowTools: false,
    temperature: 1.0 // 高一点更活，太正经就往上加
  });
  // 拆出配图标记：[图:meme-x.ext]，其余走正常清洗
  const raw = String(msg.content || '');
  const memeTag = raw.match(/\[图[:：]\s*([^\]\s]+)\]/);
  const memePath = memeTag ? memeFile(memeTag[1]) : null;
  return [cleanReply(raw), memePath, ''];
}

/* ------------------------------------------------------------------ */
/* 运行时                                                              */
/* ------------------------------------------------------------------ */

let client = null;
let notify = null; // (text) => void，由 main.js 注入气泡通知

function setNotifier(fn) {
  notify = typeof fn === 'function' ? fn : null;
}

function say(text) {
  dbg('[qq]', text);
  if (notify) {
    try {
      notify(text);
    } catch (err) {
      dbg('[qq] 通知失败：', err.message);
    }
  }
}

function status() {
  const cfg = getCfg();
  return {
    enabled: !!cfg.enabled,
    running: !!(client && client.connected),
    selfId: client ? client.selfId : null,
    url: cfg.wsUrl,
    whitelist: cfg.whitelist,
    whitelistCount: (cfg.whitelist || []).length
  };
}

async function start() {
  const cfg = getCfg();
  if (client) stop(true);
  if (!cfg.whitelist || !cfg.whitelist.length) {
    say('QQ 自动回复没启动：白名单是空的（先把要回复的人加进配置）');
    return { ok: false, message: '白名单为空' };
  }
  loadState();
  client = new OneBotClient({
    url: cfg.wsUrl,
    token: cfg.token,
    onEvent: handleEvent,
    onStatus: (s, detail) => {
      dbg('[qq] 连接状态:', s, detail || '');
      if (s === 'connected') {
        say('QQ 机器人已连上 NapCat，开始值守私聊白名单');
        client
          .getLoginInfo()
          .then((info) => {
            if (client) client.selfId = info && info.user_id;
            dbg('[qq] 登录账号:', info && info.user_id, info && info.nickname);
          })
          .catch(() => {});
      } else if (s === 'disconnected') {
        say('与 NapCat 断开了，正在自动重连');
      }
    }
  });
  config.set({ qq: { ...cfg, enabled: true } });
  client.start();
  dbg('[qq] 启动，白名单', cfg.whitelist.length, '人');
  return { ok: true };
}

function stop(silent = false) {
  if (client) {
    client.stop();
    client = null;
  }
  config.set({ qq: { enabled: false } });
  if (!silent) say('QQ 自动回复已关闭');
  dbg('[qq] 已停止');
  return { ok: true };
}

async function toggle() {
  const cfg = getCfg();
  if (cfg.enabled && client) {
    stop();
    return status();
  }
  await start();
  return status();
}
/** 关键字白名单 + 只收私聊好友/白名单群消息。返回命中的备注名或 null。
 *  白名单条目两种形态：{ qq, name } 私聊；{ group, name } 群聊。 */
function matchWhitelist(cfg, event) {
  const isGroup = event.message_type === 'group';
  const key = isGroup ? String(event.group_id) : String(event.user_id);
  const field = isGroup ? 'group' : 'qq';
  const entry = (cfg.whitelist || []).find((x) => String(x[field]) === key);
  return entry ? entry.name || key : null;
}

async function handleEvent(event) {
  try {
    await onMessage(event);
  } catch (err) {
    dbg('[qq] 处理事件失败:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* 消息聚合：对方连发多条 → 攒 batchWaitMs 后合并成一次回复              */
/* ------------------------------------------------------------------ */

const pendingChats = new Map(); // qq -> { timer, items: [] }

/** 群友要求改性格：关键词粗筛 + LLM 精判。命中返回新人设文本，否则 null */
async function detectPersonaChange(text) {
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.apiKey) return null;
  const msg = await llm.chat({
    messages: [
      { role: 'system', content: PERSONA_DETECT_PROMPT },
      { role: 'user', content: String(text).slice(0, 300) }
    ],
    config: llmCfg,
    allowTools: false,
    temperature: 0.1
  });
  try {
    const m = String(msg.content || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const d = JSON.parse(m[0]);
    if (d.change && d.persona && String(d.persona).trim()) return String(d.persona).trim().slice(0, 120);
  } catch {
    /* JSON 解析失败当没识别到 */
  }
  return null;
}

async function onMessage(event) {
  const cfg = getCfg();
  if (!cfg.enabled) return;

  // 只处理私聊和群聊。讨论组/频道一律忽略
  if (event.post_type !== 'message') return;
  if (event.message_type !== 'private' && event.message_type !== 'group') return;
  // 好友私聊才回；sub_type 为 group 的临时会话不回
  if (event.message_type === 'private' && event.sub_type && event.sub_type !== 'friend') {
    dbg('[qq] 忽略非好友私聊 sub_type=', event.sub_type);
    return;
  }
  // 匿名群消息不回（不知道是谁，风险大）
  if (event.anonymous) {
    dbg('[qq] 忽略匿名群消息');
    return;
  }
  // 自己发的（多端同步等）不回
  if (client && client.selfId && String(event.user_id) === String(client.selfId)) return;

  const isGroup = event.message_type === 'group';
  const targetId = isGroup ? event.group_id : event.user_id;
  const qq = String(targetId); // 护栏状态键：群聊按群、私聊按人
  const name = matchWhitelist(cfg, event);
  if (!name) {
    dbg('[qq]', qq, '不在白名单，忽略');
    return;
  }

  // 同一条消息（对方没点开时 NapCat 会重复上报）不重复回
  const c = chatState(qq);
  if (event.message_id && c.lastMsgId === event.message_id) return;
  c.lastMsgId = event.message_id;
  saveState();

  // 解析消息内容：文字 + 图片/表情包 URL + 语音 URL + 经典表情含义
  let text = '';
  const imageUrls = [];
  const voiceUrls = [];
  const faceMarks = [];
  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (seg.type === 'text') {
        text += (seg.data && seg.data.text) || '';
      } else if ((seg.type === 'image' || seg.type === 'mface') && seg.data && seg.data.url) {
        imageUrls.push(seg.data.url); // 图片和商城表情包都拿得到 URL
      } else if (seg.type === 'record' && seg.data && seg.data.url) {
        voiceUrls.push(seg.data.url); // 语音消息
      } else if (seg.type === 'face' && seg.data) {
        faceMarks.push(FACE_NAMES[seg.data.id] || `表情#${seg.data.id}`);
      }
    }
    text = text.trim();
  } else if (typeof event.message === 'string') {
    text = event.message.replace(/\[CQ:[^\]]+\]/g, '').trim();
  }
  // 纯视频/文件等没有可识别内容的：不猜，不回
  if (!text && !imageUrls.length && !faceMarks.length && !voiceUrls.length) return;

  const item = {
    text,
    imageUrls,
    voiceUrls,
    faceMarks,
    isGroup,
    targetId,
    qq,
    name
  };

  // 入队攒批：等 batchWaitMs，看对方还有没有下一条
  let pend = pendingChats.get(qq);
  if (!pend) {
    pend = { timer: null, items: [] };
    pendingChats.set(qq, pend);
  }
  pend.items.push(item);
  if (pend.timer) clearTimeout(pend.timer);
  pend.timer = setTimeout(() => {
    flushChat(qq).catch((err) => dbg('[qq] 聚合回复失败:', err.message));
  }, cfg.batchWaitMs || 4000);
  dbg('[qq] 暂存消息（攒批中）:', name, String(item.text).slice(0, 30));
}

async function flushChat(qq) {
  const pend = pendingChats.get(qq);
  const items = (pend && pend.items) || [];
  if (pend) {
    if (pend.timer) clearTimeout(pend.timer);
    pendingChats.delete(qq);
  }
  if (!items.length) return;
  const first = items[0];
  const { isGroup, targetId, name } = first;
  const cfg = getCfg();

  // 逐条拼 incoming：语音转文字、表情标注，群聊带发言人
  const parts = [];
  const faceMarksAll = [];
  let voiceUrl = null;
  let imageUrl = null;
  for (const it of items) {
    let text = it.text;
    if (!text && it.voiceUrls.length) {
      try {
        const said = await transcribeAudio(it.voiceUrls[0], cfg);
        if (said) text = said;
        dbg('[qq] 语音转文字:', said || '(没听清)');
      } catch (err) {
        dbg('[qq] 语音转文字失败：', err.message);
      }
    }
    if (it.voiceUrls.length && !voiceUrl) voiceUrl = it.voiceUrls[0];
    if (it.imageUrls.length && !imageUrl) imageUrl = it.imageUrls[it.imageUrls.length - 1];
    faceMarksAll.push(...it.faceMarks);

    let piece = String(text).slice(0, 500);
    if (it.faceMarks.length) {
      const marks = it.faceMarks.join('、');
      piece = piece ? `${piece}（${marks}的表情）` : `（发了个「${marks}」表情）`;
    }
    // 不带发言人网名，直接给内容
    if (piece) parts.push(piece);
  }
  let incoming = parts.join('\n');
  if (faceMarksAll.length && !parts.length) incoming = `（发了个「${faceMarksAll.join('、')}」表情）`;
  if (imageUrl && !incoming) incoming = '（发了一张图片）';
  if (!incoming && !imageUrl) return;

  const [ok, why] = guardCheck(cfg, qq);
  if (!ok) {
    dbg('[qq]', name, '被护栏拦下：', why);
    return;
  }

  say(`QQ 收到 ${name} 的消息${items.length > 1 ? `（攒了 ${items.length} 条）` : ''}：「${incoming.slice(0, 40).replace(/\n/g, ' / ')}${incoming.length > 40 ? '…' : ''}」，正在想怎么回`);

  // 群友/私聊对象要求改性格：关键词粗筛（放宽，宁可多问一次 LLM 也别漏掉调教）+ LLM 精判，
  // 命中就持久化并当场生效。QQ 性格是独立配置（qq.persona），只被这里改。
  if (/性格|人设|语气|口吻|说话|风格|方式|温柔|可爱|凶|高冷|傲娇|礼貌|正经|热情|像人|像真|机器人/.test(incoming)) {
    try {
      const np = await detectPersonaChange(incoming);
      if (np) {
        config.set({ qq: { ...cfg, persona: np } });
        say(`QQ 性格已按对方要求改为：${np}`);
        dbg('[qq] 人设变更 ->', np);
      }
    } catch (err) {
      dbg('[qq] 人设识别失败：', err.message);
    }
  }

  // 带图时图片本地下载转 base64，一次视觉调用直接出回复；顺手收藏进表情包库
  let imageUri = null;
  if (imageUrl) {
    try {
      const buf = await fetchBuffer(imageUrl);
      imageUri = imageDataUri(buf);
      collectMeme(buf).catch(() => {});
    } catch (err) {
      dbg('[qq]', name, '图片下载失败，改纯文字理解：', err.message);
    }
  }

  const ctx = (chatState(qq).ctx || []).slice(-CTX_PER_CHAT);
  let reply = null;
  let memePath = null;
  try {
    const [gen, meme, err] = await generateReply(ctx, incoming, imageUri, getCfg());
    if (!gen && !meme) {
      dbg('[qq]', name, '生成放弃：', err || '模型输出为空/标记跳过');
      return;
    }
    reply = gen;
    memePath = meme && fs.existsSync(meme) ? meme : null;
  } catch (err) {
    dbg('[qq]', name, '生成失败：', err.message);
    return;
  }

  if (reply && isDuplicate(getCfg(), qq, reply)) {
    dbg('[qq]', name, '回复与最近重复，放弃本次');
    return;
  }

  // 发语音的条件：对方发了语音 / 明确要语音 / 配置 voiceAlways。失败退回文字
  const voiceReq = /发(条|个|个)?语音|语音回|用语音|语音说|语音呢|说句话听听/.test(incoming);
  const wantVoice = !!getCfg().voiceReply && !!(voiceUrl || getCfg().voiceAlways || voiceReq);
  let sentVoice = false;
  if (wantVoice && reply) {
    try {
      const file = await ttsToFile(reply, getCfg());
      await client.sendRecord(isGroup, targetId, file);
      sentVoice = true;
      dbg('[qq] 已发送语音 ->', name, reply);
    } catch (err) {
      dbg('[qq]', name, '语音发送失败，退回文字：', err.message);
    }
  }

  // 配图：模型挑了表情包就发（文字和图拼一条消息；语音场景图单独发）
  let sentMeme = false;
  if (memePath) {
    try {
      const segs = [];
      if (reply && !sentVoice) segs.push({ type: 'text', data: { text: reply } });
      segs.push({ type: 'image', data: { file: `file:///${memePath.replace(/\\/g, '/')}` } });
      await client.sendSegments(isGroup, targetId, segs);
      sentMeme = true;
      dbg('[qq] 已发送配图 ->', name, path.basename(memePath));
    } catch (err) {
      dbg('[qq]', name, '配图发送失败：', err.message);
    }
  }

  if (!sentVoice && !sentMeme) {
    try {
      await (isGroup
        ? client.sendGroupText(targetId, reply)
        : client.sendPrivateText(targetId, reply));
    } catch (err) {
      dbg('[qq]', name, '发送失败：', err.message);
      say(`QQ 回复 ${name} 发送失败：${err.message}`);
      return;
    }
  }

  guardRecord(getCfg(), qq, reply || '');
  const cs = chatState(qq);
  cs.ctx = [...ctx, `对方：${incoming.replace(/\n/g, '；')}`, `我：${reply || '（发了个表情包）'}`].slice(-CTX_PER_CHAT);
  saveState();

  say(`已替你回复 ${name}${sentVoice ? '（语音）' : ''}${sentMeme ? '（带图）' : ''}：「${reply || '[表情包]'}」`);
  dbg('[qq] 已发送 ->', name, reply || '[表情包]');
}

/* ------------------------------------------------------------------ */
/* 初始化（main.js 调用）                                               */
/* ------------------------------------------------------------------ */

function init(notifierFn) {
  setNotifier(notifierFn);
  const cfg = getCfg();
  if (cfg.enabled) {
    // 恢复上次开着的状态
    start().catch((err) => dbg('[qq] 恢复启动失败:', err.message));
  }
}

function shutdown() {
  for (const [, pend] of pendingChats) {
    if (pend.timer) clearTimeout(pend.timer);
  }
  pendingChats.clear();
  if (client) {
    client.stop();
    client = null;
  }
}

module.exports = {
  init,
  start,
  stop,
  toggle,
  status,
  shutdown,
  setNotifier,
  // 内部函数导出仅供测试
  _internals: { getCfg, guardCheck, guardRecord, isDuplicate, normalize, cleanReply, matchWhitelist, loadState, chatState, saveState, resetState: () => { state = null; }, buildSystemPrompt, PERSONA_DEFAULT, collectMeme, memeListText, memeFile, loadMemeCatalog, saveMemeCatalog, memeDir }
};
