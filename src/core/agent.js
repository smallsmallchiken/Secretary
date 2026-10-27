'use strict';

const config = require('./config');
const llm = require('./llm');
const tools = require('./tools');
const { dbg } = require('./debug');

/* ------------------------------------------------------------------ */
/* 中文自然语言时间解析                                                 */
/* ------------------------------------------------------------------ */

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnToNum(s) {
  if (s == null) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === '十') return 10;
  if (s.length === 1) return CN_DIGITS[s] ?? NaN;
  let m = s.match(/^十(.+)$/);
  if (m) return 10 + (CN_DIGITS[m[1]] ?? 0);
  m = s.match(/^(.+)十(.+)$/);
  if (m) return (CN_DIGITS[m[1]] ?? 0) * 10 + (CN_DIGITS[m[2]] ?? 0);
  m = s.match(/^(.+)十$/);
  if (m) return (CN_DIGITS[m[1]] ?? 0) * 10;
  return NaN;
}

const NUM_TOKEN = '(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})';

/**
 * 把「10分钟后」「明天下午三点半」这类说法解析成 Date。
 * 解析不出来返回 null。
 */
function parseWhen(input, base = new Date()) {
  const text = String(input || '');

  // 相对时间
  let m = text.match(/(\d+(?:\.\d+)?|半|[一二两三四五六七八九十]{1,3})\s*个?\s*(秒|分钟|分|小时|钟头|天)\s*(?:之?后|以后)/);
  if (m) {
    const n = m[1] === '半' ? 0.5 : cnToNum(m[1]);
    const unitMs = { 秒: 1000, 分钟: 60000, 分: 60000, 小时: 3600000, 钟头: 3600000, 天: 86400000 }[m[2]];
    if (Number.isFinite(n) && unitMs) return new Date(base.getTime() + n * unitMs);
  }

  // 绝对时间
  const re = new RegExp(
    `(今天|明天|后天|大后天)?\\s*(早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\\s*${NUM_TOKEN}\\s*[点時时:：]\\s*(半|${NUM_TOKEN})?`
  );
  m = text.match(re);
  if (!m) return null;

  let [, dayWord, period, hourRaw, minRaw] = m;
  let hour = cnToNum(hourRaw);
  if (!Number.isFinite(hour) || hour > 24) return null;

  let minute = 0;
  if (minRaw === '半') minute = 30;
  else if (minRaw != null) {
    const v = cnToNum(minRaw);
    if (Number.isFinite(v)) minute = v;
  }
  if (minute > 59) minute = 0;

  const d = new Date(base);
  if (period === '下午' || period === '傍晚' || period === '晚上' || period === '夜里') {
    if (hour < 12) hour += 12;
  } else if (period === '中午') {
    if (hour < 11) hour += 12;
  } else if (period === '早上' || period === '早晨' || period === '上午') {
    if (hour === 12) hour = 0;
  }

  d.setSeconds(0, 0);
  d.setHours(hour, minute);

  if (dayWord === '明天') d.setDate(d.getDate() + 1);
  else if (dayWord === '后天') d.setDate(d.getDate() + 2);
  else if (dayWord === '大后天') d.setDate(d.getDate() + 3);
  else if (!dayWord && d.getTime() <= base.getTime()) {
    // 没说日期但时间已过，认为是明天
    d.setDate(d.getDate() + 1);
  }

  return d;
}

/* ------------------------------------------------------------------ */
/* 本地规则引擎（不需要 API Key）                                       */
/* ------------------------------------------------------------------ */

const MEDIA_PATTERNS = [
  [/^(暂停|停一下|暂停播放|pause)/i, 'toggle'],
  [/^(播放|继续|继续播放|放歌|开始播放)/, 'toggle'],
  [/下一首|下一曲|切歌|换一首|next/, 'next'],
  [/上一首|上一曲|前一首|prev/, 'prev'],
  [/静音|取消静音|mute/, 'mute'],
  [/(音量)?(调)?(大|高)(一点|点|一些)?|声音大/, 'volume_up'],
  [/(音量)?(调)?(小|低)(一点|点|一些)?|声音小/, 'volume_down'],
  [/停止播放|关掉音乐|stop/, 'stop']
];

function matchLocal(raw) {
  const text = raw.trim();
  const compact = text.replace(/[，。！？、\s]/g, '');
  const low = text.toLowerCase();

  // 时间 / 日期
  if (/几点|什么时间|现在时间|今天几号|今天星期几|今天周几/.test(text) && !/提醒|开会|叫醒/.test(text)) {
    return { tool: 'get_time', args: {} };
  }

  // 提醒
  const remindMatch = text.match(/提醒我(.+)/) || text.match(/(.+?)提醒我/);
  if (remindMatch || /我(要|想)?(设|定)(个|一个)?提醒/.test(text)) {
    const when = parseWhen(text);
    let content = remindMatch ? remindMatch[1] : '';
    // 从内容里剥掉时间描述
    content = content
      .replace(/(\d+(?:\.\d+)?|半|[零〇一二两三四五六七八九十]{1,3})\s*个?\s*(秒|分钟|分|小时|钟头|天)\s*(?:之?后|以后)/g, '')
      .replace(/(今天|明天|后天|大后天)?\s*(早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\s*[\d零〇一二两三四五六七八九十]{1,3}\s*[点時时:：]\s*(半|[\d零〇一二两三四五六七八九十]{1,3})?/g, '')
      .replace(/^(要|去|让我|我|记得|的|个|一下|帮我)+/g, '')
      .replace(/^(去|要|记得)+/g, '')
      .trim();
    if (!content) content = '该做事情了';
    if (when) {
      return { tool: 'set_reminder', args: { text: content, at: when.toISOString() } };
    }
    return { tool: 'set_reminder', args: { text: content, at: '' }, _missingTime: true };
  }

  if (/我的提醒|有什么提醒|提醒列表|待办/.test(text)) {
    return { tool: 'list_reminders', args: {} };
  }
  if (/取消(所有)?提醒|清空提醒/.test(text)) {
    return { tool: 'cancel_reminder', args: {} };
  }

  // 微信 / QQ 回复草稿
  const replyMatch = text.match(/^(?:帮我)?(?:回复|回|答|发给)\s*([^:：]{0,12}?)\s*(?:说|：|:)\s*(.+)$/);
  if (replyMatch) {
    return {
      tool: 'wechat_draft',
      args: { target: replyMatch[1].trim() || null, content: replyMatch[2].trim() }
    };
  }
  if (/^(复制|粘贴)(这段|一下)?/.test(text) && text.length > 4) {
    const clipMatch = text.match(/复制(.+)/);
    if (clipMatch) return { tool: 'clipboard_write', args: { text: clipMatch[1].trim() } };
  }
  if (/剪贴板里(是什么|有什么|的内容)|读一下剪贴板/.test(text)) {
    return { tool: 'clipboard_read', args: {} };
  }

  // 截图 / 锁屏
  if (/^(截图|截个屏|截屏|屏幕截图)/.test(text)) return { tool: 'take_screenshot', args: {} };
  if (/^(锁屏|锁屏幕|锁定屏幕|锁一下)/.test(text)) return { tool: 'lock_screen', args: {} };

  // 搜索
  const searchMatch = text.match(/^(?:帮我)?(?:搜索|搜一下|搜|百度|查一下|查查|查)\s*(.+)$/);
  if (searchMatch) return { tool: 'web_search', args: { query: searchMatch[1].trim() } };

  // 打开网址
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
  if (urlMatch && /打开|访问|去/.test(text)) {
    return { tool: 'open_url', args: { url: urlMatch[1] } };
  }

  // 媒体控制
  for (const [re, action] of MEDIA_PATTERNS) {
    if (re.test(compact) || re.test(low)) return { tool: 'media_control', args: { action } };
  }

  // 打开应用
  const openMatch = text.match(/^(?:帮我)?(?:打开|启动|运行|开启|开一下|开个|开)\s*(.{1,30}?)(?:吧|呗|呀|啊)?$/);
  if (openMatch) {
    let appName = openMatch[1].trim().replace(/[，。！？]$/, '');
    appName = appName.replace(/^(一下|下|个)\s*/, '');
    if (appName && !/文件|文件夹|网页|浏览器$this/.test(appName)) {
      return { tool: 'open_app', args: { app_name: appName } };
    }
  }
  // 直接说应用名
  if (/^(网易云音乐?|微信|qq|钉钉|飞书|企业微信)$/i.test(compact)) {
    return { tool: 'open_app', args: { app_name: compact } };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* LLM 路径                                                            */
/* ------------------------------------------------------------------ */

function llmReady() {
  const cfg = config.get('llm');
  return !!(cfg && cfg.enabled && cfg.apiKey);
}

// 出现这些信号说明是复合/复杂意图，本地规则单条匹配会吃掉一半语义，应该交给模型
const COMPLEX_HINT = /然后|再(帮|把|去|说|看)|并且|顺便|同时|先.{0,8}再|以及|之后/;

function isComplex(text) {
  return text.length > 14 || COMPLEX_HINT.test(text);
}

let history = [];

async function runLLM(text) {
  const cfg = config.get('llm');
  history.push({ role: 'user', content: text });
  if (history.length > 16) history = history.slice(-16);

  const messages = [{ role: 'system', content: llm.SYSTEM_PROMPT }, ...history];
  const sideEffects = [];
  dbg('[llm] 发起请求 model=', cfg.model, 'baseUrl=', cfg.baseUrl, '历史=', history.length);

  for (let round = 0; round < 4; round++) {
    const msg = await llm.chat({ messages, config: cfg });
    messages.push(msg);
    dbg(
      '[llm] 第', round + 1, '轮返回: tool_calls=',
      msg.tool_calls ? msg.tool_calls.length : 0,
      'content=', String(msg.content || '').slice(0, 100)
    );

    if (!msg.tool_calls || !msg.tool_calls.length) {
      const content = (msg.content || '').trim() || '……';
      history.push({ role: 'assistant', content });
      if (history.length > 16) history = history.slice(-16);
      return { type: 'text', message: content, sideEffects };
    }

    for (const call of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      dbg('[llm] 调用工具', call.function.name, JSON.stringify(args).slice(0, 200));
      let result;
      try {
        if (call.function.name === 'set_reminder' && args.at) {
          // 模型可能给的是相对说法，兜底解析一次
          const parsed = parseWhen(String(args.at));
          if (parsed) args.at = parsed.toISOString();
        }
        result = await tools.execute(call.function.name, args);
        sideEffects.push({ tool: call.function.name, ...result });
        dbg('[llm] 工具结果', call.function.name, JSON.stringify(result).slice(0, 200));
      } catch (err) {
        result = { ok: false, message: err.message };
        dbg('[llm] 工具失败', call.function.name, err.message);
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 4000)
      });
    }
  }

  return { type: 'text', message: '这个我想太久了，换个说法试试？', sideEffects };
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

const FALLBACK_HELP =
  '这个我还不会。现在能直接听懂：\n' +
  '· 打开网易云音乐 / 打开微信\n' +
  '· 暂停、下一首、静音、音量调大\n' +
  '· 10分钟后提醒我喝水\n' +
  '· 现在几点 / 截图 / 锁屏\n' +
  '· 搜索 xxx\n' +
  '· 回复老王说明天开会改到三点\n\n' +
  '想要真正的自由对话，去设置里填一个模型 API Key。';

/** 把底层的技术错误翻译成人话 */
function friendlyError(err) {
  const msg = String((err && err.message) || err || '');
  if (/EPERM|EACCES/i.test(msg)) {
    return '系统不让启动外部程序（可能被安全软件拦住了）。你手动双击试试，或者把程序的完整路径告诉我。';
  }
  if (/ENOENT|not found/i.test(msg)) {
    return '找不到这个程序或文件，检查一下名字或路径对不对。';
  }
  if (/timeout|超时/i.test(msg)) {
    return '等太久了，没等到结果。再试一次？';
  }
  if (/401|invalid.*key|api key/i.test(msg)) {
    return 'API Key 好像不对，去设置里检查一下。';
  }
  if (/429|rate limit/i.test(msg)) {
    return '请求太频繁了，等几秒再说。';
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
    return '网络连不上，检查一下网络或代理。';
  }
  return msg || '出错了';
}

async function handle(rawInput) {
  const text = String(rawInput || '').trim();
  if (!text) return { type: 'text', message: '在呢，说吧。' };

  const local = matchLocal(text);
  // 配了模型时，复杂说法交给模型编排；简单单条指令仍走本地，快且省 token
  const preferLLM = llmReady() && isComplex(text);
  dbg(
    '[agent] 输入：', text,
    '| 本地命中：', local ? local.tool : '无',
    '| LLM可用：', llmReady(),
    '| 交给模型：', preferLLM
  );

  // 提醒但没说时间
  if (local && local._missingTime) {
    return { type: 'text', message: `好的，要提醒你「${local.args.text}」。什么时候提醒？比如「下午3点」或「半小时后」。` };
  }

  // 微信草稿：如果配置了模型，让它把话写得更自然
  if (local && local.tool === 'wechat_draft' && llmReady() && !preferLLM) {
    try {
      const res = await runLLM(`请把这句话润色成一条可以直接发给对方的中文回复，只输出回复正文，不要任何解释：${local.args.content}`);
      const polished = res.message.replace(/^["“]|["”]$/g, '').trim();
      const result = await tools.execute('wechat_draft', { content: polished, target: local.args.target });
      return { type: 'action', tool: 'wechat_draft', ...result };
    } catch {
      // 润色失败就退回原话
    }
  }

  if (local && !preferLLM) {
    try {
      const result = await tools.execute(local.tool, local.args);
      return { type: 'action', tool: local.tool, ...result };
    } catch (err) {
      return { type: 'error', message: friendlyError(err) };
    }
  }

  if (llmReady()) {
    try {
      return await runLLM(text);
    } catch (err) {
      // 模型这条路走不通，如果本地能处理就退回本地，别让用户白等
      if (local && local.tool) {
        try {
          const result = await tools.execute(local.tool, local.args);
          return { type: 'action', tool: local.tool, ...result };
        } catch {
          /* 落到下面的错误提示 */
        }
      }
      return { type: 'error', message: friendlyError(err) };
    }
  }

  if (local) {
    try {
      const result = await tools.execute(local.tool, local.args);
      return { type: 'action', tool: local.tool, ...result };
    } catch (err) {
      return { type: 'error', message: friendlyError(err) };
    }
  }

  return { type: 'text', message: FALLBACK_HELP };
}

function resetHistory() {
  history = [];
}

module.exports = { handle, parseWhen, matchLocal, llmReady, resetHistory, cnToNum };
