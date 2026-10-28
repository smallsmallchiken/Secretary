'use strict';

const fs = require('fs');
const path = require('path');
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

const SYSTEM_PROMPT = `你在替本人回复 QQ 私聊消息。要求：
- 用本人第一人称，口语化，像真人随手打的，不要书面语
- 短，通常一到两句话，不要长篇大论
- 不要用「您好」「感谢您的来信」这类客服腔
- 不确定的事不要替本人承诺，说「我看一下」「回头跟你说」
- 只输出要发的那句话本身，不要任何解释、引号或前缀
- 对方消息如果看起来是广告、诈骗、群发，直接不回复（输出 [SKIP]）`;

const REPLY_MAX_CHARS = 120;
const CTX_PER_CHAT = 6; // 每会话保留的上下文条数（一问一答算两条）
const CLEAN_PREFIX = ['回复：', '回复:', '可以这样回：'];

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function defaultConfig() {
  return {
    // 默认关：必须用户在右键菜单显式打开才工作
    enabled: false,
    wsUrl: 'ws://127.0.0.1:3001',
    token: '',
    // 白名单：[{ qq: 123456, name: '备注' }]。空数组 = 不回复任何人
    whitelist: [],
    // 护栏参数
    perChatIntervalSeconds: 20,
    maxConsecutive: 3,
    maxPerHour: 20,
    dedupeWindowSeconds: 60
  };
}

function getCfg() {
  const saved = config.get('qq', {}) || {};
  return { ...defaultConfig(), ...saved };
}

function whitelistSet(cfg) {
  return new Set((cfg.whitelist || []).map((x) => String(x.qq)).filter(Boolean));
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

/** 发送前闸门。返回 (放行?, 原因)。默认不放行。 */
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
  if (gap < cfg.perChatIntervalSeconds * 1000) {
    return [false, `间隔不足(${Math.round(gap / 1000)}s)`];
  }
  if ((c.consecutive || 0) >= cfg.maxConsecutive) {
    return [false, `连发达上限(${c.consecutive})`];
  }
  s.sentThisHour = (s.sentThisHour || []).filter((t) => now - t < 3600000);
  if (s.sentThisHour.length >= cfg.maxPerHour) {
    return [false, `每小时达上限(${s.sentThisHour.length})`];
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

async function generateReply(historyTexts, incoming) {
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.enabled || !llmCfg.apiKey) {
    return [null, '没有配置模型，无法自动生成回复'];
  }
  const user = [];
  if (historyTexts && historyTexts.length) {
    user.push('最近的聊天记录：\n' + historyTexts.join('\n'));
  }
  user.push(`对方刚发来的消息：${incoming}\n\n请直接给出要回复的那句话。`);

  const msg = await llm.chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user.join('\n\n') }
    ],
    config: llmCfg,
    allowTools: false,
    temperature: 0.8
  });
  return [cleanReply(msg.content), ''];
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
/** 关键字白名单 + 只收私聊好友消息。返回命中的备注名或 null。 */
function matchWhitelist(cfg, event) {
  const want = whitelistSet(cfg);
  if (!want.has(String(event.user_id))) return null;
  const entry = (cfg.whitelist || []).find((x) => String(x.qq) === String(event.user_id));
  return (entry && entry.name) || String(event.user_id);
}

async function handleEvent(event) {
  try {
    await onMessage(event);
  } catch (err) {
    dbg('[qq] 处理事件失败:', err.message);
  }
}

async function onMessage(event) {
  const cfg = getCfg();
  if (!cfg.enabled) return;

  // 只处理私聊。群聊/讨论组/频道一律忽略
  if (event.post_type !== 'message' || event.message_type !== 'private') return;
  // 好友私聊才回；sub_type 为 group 的临时会话不回
  if (event.sub_type && event.sub_type !== 'friend') {
    dbg('[qq] 忽略非好友私聊 sub_type=', event.sub_type);
    return;
  }
  // 自己发的（多端同步等）不回
  if (client && client.selfId && String(event.user_id) === String(client.selfId)) return;

  const qq = String(event.user_id);
  const name = matchWhitelist(cfg, event);
  if (!name) {
    dbg('[qq]', qq, '不在白名单，忽略');
    return;
  }

  // 消息文本（数组格式取 text 段；纯字符串兜底）
  let text = '';
  if (Array.isArray(event.message)) {
    text = event.message
      .filter((seg) => seg.type === 'text')
      .map((seg) => seg.data && seg.data.text)
      .join('')
      .trim();
  } else if (typeof event.message === 'string') {
    text = event.message.replace(/\[CQ:[^\]]+\]/g, '').trim();
  }
  if (!text) return; // 图片/语音/文件等：不猜，不回

  // 同一条消息（对方没点开时 NapCat 会重复上报）不重复回
  const c = chatState(qq);
  if (event.message_id && c.lastMsgId === event.message_id) return;
  c.lastMsgId = event.message_id;
  saveState();

  const [ok, why] = guardCheck(cfg, qq);
  if (!ok) {
    dbg('[qq]', name, '被护栏拦下：', why);
    return;
  }

  const incoming = String(text).slice(0, 500);
  say(`QQ 收到 ${name} 的消息：「${incoming.slice(0, 40)}${incoming.length > 40 ? '…' : ''}」，正在想怎么回`);

  const ctx = (c.ctx || []).slice(-CTX_PER_CHAT);
  let reply;
  try {
    const [gen, err] = await generateReply(ctx, incoming);
    if (!gen) {
      dbg('[qq]', name, '生成放弃：', err || '模型输出为空/标记跳过');
      return;
    }
    reply = gen;
  } catch (err) {
    dbg('[qq]', name, '生成失败：', err.message);
    return;
  }

  if (isDuplicate(cfg, qq, reply)) {
    dbg('[qq]', name, '回复与最近重复，放弃本次');
    return;
  }

  try {
    await client.sendPrivateText(event.user_id, reply);
  } catch (err) {
    dbg('[qq]', name, '发送失败：', err.message);
    say(`QQ 回复 ${name} 发送失败：${err.message}`);
    return;
  }

  guardRecord(cfg, qq, reply);
  // 重置连发计数：对方又说了话算新一轮交互
  const cs = chatState(qq);
  cs.ctx = [...ctx, `对方：${incoming}`, `我：${reply}`].slice(-CTX_PER_CHAT);
  saveState();

  say(`已替你回复 ${name}：「${reply}」`);
  dbg('[qq] 已发送 ->', name, reply);
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
  _internals: { getCfg, guardCheck, guardRecord, isDuplicate, normalize, cleanReply, matchWhitelist, loadState, chatState, saveState, resetState: () => { state = null; } }
};
