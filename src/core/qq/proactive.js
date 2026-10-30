'use strict';

/**
 * QQ 主动发消息的决策层（纯函数，不碰网络、不读写文件）。
 *
 * 设计参考（都是 AstrBot 生态里做得比较细的几个主动消息插件，思路一致）：
 *   - yuntaojinghong/astrbot_plugin_proactive_care（微光）：五路触发 + 固定优先级
 *     「话题追问 > 定时问候 > 空闲唤醒 > 随机关怀」，每次开口都要有由头，且同一天不重复。
 *   - Pleiades1726/astrbot_plugin_proactive_chat：沉默时长取随机区间、免打扰时段、
 *     「连续 N 条主动都没回就停，直到对方开口」。
 *   - Luna-channel/astrbot_plugin_Conversa：触发时间 = 基准 ± 随机波动、概率指数递减防刷屏。
 *   - naliling/astrbot-plugin-autonomous-social：主动消息必须有具体由头，
 *     带有效期、冷却期、跨会话去重。
 *
 * 这里只做「该不该开口、为什么开口」，说什么交给模型。所有阈值都可配。
 *
 * 关键取舍：
 *   1. 时间一律按北京时间算（服务器是 UTC）。tzOffsetMinutes 可改。
 *   2. 追问/定时/空闲三路是**确定性**的，只在时间点上判断，靠随机抖动错开多个会话，
 *      不掷骰子——否则 60 秒一跳，掷几十次一定中，概率形同虚设。
 *      只有「随机关怀」真掷骰子，并且一小时只能掷一次。
 *   3. 没有未回消息铺垫（proactiveUnanswered 达到上限）就彻底闭嘴，
 *      不做「你为什么不理我」的追命连环。
 */

const DEFAULTS = {
  enabled: true,
  tzOffsetMinutes: 480, // 北京时间
  quietHours: [1, 8], // 这个区间一条都不发（跨天可写 [23, 8]）
  activeWindow: [9, 23], // 随机关怀只在这个区间里挑时间
  dailyMax: 2, // 每个会话每天最多主动几条
  cooldownMinutes: 240, // 两次主动之间至少隔多久
  maxUnanswered: 2, // 连续这么多条主动都没回就停，等他先开口；0 = 不限
  minGapMinutes: 20, // 对方刚说完话这么多分钟内不插嘴（可能还在打字）
  activeDays: 14, // 超过这么多天没互动的人不再主动找（关系已经凉了）
  followUpMinutes: [40, 90], // 我上一条问句没回 → 在这个区间里追一句
  followUpMaxHours: 6, // 超过这么久就别追了，追了像讨债
  silenceHours: [20, 34], // 距上次说话这么久 → 空闲唤醒
  slots: ['12:40', '22:40'], // 定时问候时刻（会前后抖动）
  slotJitterMinutes: 25,
  slotWindowMinutes: 12, // 到点后这么多分钟内算有效，错过就算了（不补发）
  randomDaily: 1, // 随机关怀每天最多几条
  randomChance: 0.35, // 每次掷骰子的命中率
  randomRollMinutes: 60 // 掷骰子的最小间隔
};

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 北京时间的「第几天」和「第几分钟」——只用 UTC 取值做偏移，不依赖系统时区 */
function clockOf(nowMs, tzOffsetMinutes) {
  const d = new Date(nowMs + tzOffsetMinutes * MIN);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const da = d.getUTCDate();
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  const dow = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
  return {
    day: `${y}-${pad(mo)}-${pad(da)}`,
    minutes: hh * 60 + mm,
    hhmm: `${pad(hh)}:${pad(mm)}`,
    dow
  };
}

/** 到点时间给人看的说法，喂给模型当由头 */
function gapText(ms) {
  if (!ms || ms < 0) return '刚聊过';
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return d <= 1 ? '昨天' : `${d} 天前`;
}

/** [from, to] 两个整点组成的区间，支持跨天（23 → 8） */
function inRange(minutes, [from, to]) {
  const a = from * 60;
  const b = to * 60;
  if (a === b) return false;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

function parseSlot(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
}

/** 稳定哈希：同一个会话、同一天、同一个触发点，抖动值固定，不会来回跳 */
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededOffset(seed, span) {
  if (span <= 0) return 0;
  return hash32(seed) % (span + 1);
}

function dailyCount(chat, day) {
  const d = chat && chat.proactiveDay;
  return d && d.day === day ? d.n || 0 : 0;
}

/**
 * 这一轮该不该开口。
 *
 * @param {object} o
 * @param {object} o.chat   会话状态（lastIncomingAt / lastOutgoingAt / lastProactiveAt /
 *                          awaitingReply / proactiveUnanswered / proactiveDay / slotFired）
 * @param {object} o.cfg    proactive 配置（缺项走 DEFAULTS）
 * @param {number} o.now    当前时间戳
 * @param {string} o.key    会话键（QQ 号），用于抖动种子
 * @param {function} o.rnd  0-1 随机数，测试可注入
 * @returns {null|{reason, reasonText, prob, slot?, day?}}
 */
function dueReason({ chat, cfg, now, key, rnd }) {
  const p = { ...DEFAULTS, ...(cfg || {}) };
  if (p.enabled === false) return null;

  const t = clockOf(now, p.tzOffsetMinutes || 0);
  if (inRange(t.minutes, p.quietHours || [])) return null;

  const c = chat || {};
  const lastIn = c.lastIncomingAt || 0;
  const lastOut = c.lastOutgoingAt || 0;
  const lastAct = Math.max(lastIn, lastOut);
  // 从来没聊过的人不主动搭讪（陌生人突然一句「在吗」很吓人）
  if (!lastAct) return null;
  if (!lastIn) return null;
  if (now - lastIn > (p.activeDays || 14) * DAY) return null;
  if (now - lastAct < (p.minGapMinutes || 0) * MIN) return null;

  const unanswered = c.proactiveUnanswered || 0;
  const cap = p.maxUnanswered || 0;
  if (cap > 0 && unanswered >= cap) return null;

  if (now - (c.lastProactiveAt || 0) < (p.cooldownMinutes || 0) * MIN) return null;
  if (dailyCount(c, t.day) >= (p.dailyMax || 0)) return null;

  // 1) 话题追问：我上一条是问句、对方没回，隔一会儿自己续一句
  if (c.awaitingReply && lastOut > lastIn && now - lastOut < (p.followUpMaxHours || 6) * HOUR) {
    const [a, b] = p.followUpMinutes || [40, 90];
    const span = Math.max(0, b - a) * MIN;
    const dueAt = lastOut + a * MIN + seededOffset(`${key}|fu|${lastOut}`, span);
    if (now >= dueAt) {
      return {
        reason: 'followUp',
        prob: 1,
        reasonText: `你上一条问了他一句，他没回（到现在 ${gapText(now - lastOut)}）。可以自己把话接下去，或者换个更有意思的说法，别催他回。`
      };
    }
  }

  // 2) 定时问候：到点了，但每个 slot 一天只发一次
  for (const raw of p.slots || []) {
    const base = parseSlot(raw);
    if (base === null) continue;
    const jitter = seededOffset(`${key}|slot|${t.day}|${raw}`, (p.slotJitterMinutes || 0) * 2) - (p.slotJitterMinutes || 0);
    const at = base + jitter;
    const fired = c.slotFired && c.slotFired[raw];
    if (fired === t.day) continue;
    const elapsed = t.minutes - at;
    if (elapsed >= 0 && elapsed < (p.slotWindowMinutes || 12)) {
      return {
        reason: 'timed',
        slot: raw,
        day: t.day,
        prob: 1,
        reasonText: `现在是你俩平时会聊天的点儿（${t.hhmm}），随口打个招呼。`
      };
    }
  }

  // 3) 空闲唤醒：安静太久了，主动找个由头
  if (unanswered === 0) {
    const [a, b] = p.silenceHours || [20, 34];
    const span = Math.max(0, b - a) * HOUR;
    const from = Math.max(lastAct, c.lastProactiveAt || 0);
    const dueAt = from + a * HOUR + seededOffset(`${key}|silence|${from}`, span);
    if (now >= dueAt) {
      return {
        reason: 'silence',
        prob: 1,
        reasonText: `上次说话是${gapText(now - Math.max(lastIn, lastOut))}了，你突然想起他，想找个话头。`
      };
    }
  }

  // 4) 随机关怀：唯一真掷骰子的一路，且一小时最多掷一次
  if (unanswered === 0 && (p.randomDaily || 0) > 0) {
    if (inRange(t.minutes, p.activeWindow || [9, 23])) {
      if (now - (c.randomRollAt || 0) >= (p.randomRollMinutes || 60) * MIN) {
        const roll = typeof rnd === 'function' ? rnd() : Math.random();
        if (roll < (p.randomChance || 0)) {
          return {
            reason: 'random',
            prob: 1,
            rolled: true,
            reasonText: '没什么事，就是突然想起他，想说句什么。'
          };
        }
        return { reason: 'random', prob: 1, rolled: false, reasonText: '' };
      }
    }
  }

  return null;
}

module.exports = { DEFAULTS, dueReason, clockOf, gapText, inRange, parseSlot, dailyCount, hash32 };
