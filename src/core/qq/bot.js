'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const llm = require('../llm');
const { dbg } = require('../debug');
const media = require('../media/library');
const { dataDir } = require('../paths');
const { OneBotClient } = require('./client');
const proactive = require('./proactive');

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
//
// 具体 > 抽象：只写「傲娇嘴硬心软」这种形容词，模型只能演一个中庸版本，说出来的话没有生活痕迹。
// 所以这里给身份、作息、具体口头禅、遇到具体事的固定反应——模型有抓手，句子才像个人。
const PERSONA_DEFAULT =
  '22 岁，学设计的，作息颠倒白天睡觉晚上画图。带一点傲娇，嘴硬心软，偶尔别扭地关心人。' +
  '说话短、懒得解释，爱用「啥」「咋」「行吧」「真的服了」；被夸先回「少来」；懒得回就只发一个「？」；' +
  '急了说「草」，但不追着人骂、不人身攻击。从不主动撒娇，但记着对方说过的事。';

// 去人机味思路（参考 github 上多个 QQ 机器人项目的实践）：
//   小模型规则越少越听话；示范（few-shot）比规则管用得多；温度拉高（1.0）。
function buildSystemPrompt(personaText, memeList, opts = {}) {
  const persona = (personaText || '').trim() || PERSONA_DEFAULT;
  const isGroup = !!opts.isGroup;
  const personaLine =
    persona === PERSONA_DEFAULT
      ? '我这个人设是：' + persona
      : `我这个人设是：${persona}\n\n重要：下面的「风格示范」只教你怎么把话说得短、口语、不像 AI。如果示范里的话语气跟你的人设冲突，一律以人设为准，别模仿示范的语气。`;
  const memeBlock =
    memeList && memeList.trim()
      ? `\n\n手头有一批表情包，清单格式是「序号. 什么场合用」：
${memeList.trim()}

配图规矩：
- 对方点名要表情包/梗图/图片，或者明显在斗图、跟你贫嘴起哄 → 必须发一张，别光用嘴硬糊弄过去
- 平常聊得投缘也能顺手发一张，但别每句都发；一次最多一张
- 发法：在回复最末尾写 [图:序号]，比如 [图:7]；只想发图不说话，整条回复就只写 [图:序号]
- 序号只能取上面清单里的，别自己编；只发图那就不带文字`
      : '';
  const voiceBlock =
    opts.voiceList && opts.voiceList.trim()
      ? `\n\n你可以发语音（用我的声音）。下面这些是现成的，写了立刻就能发：
${opts.voiceList.trim()}

语音规矩：
- 对方发了语音、或者这句话特别适合出声（撒娇、嫌弃、偷笑）时，把要念的那句写成 [语音:内容] 放在回复最末尾
- 内容不限于上面清单：想说的话清单里没有，也照样写 [语音:想说的那句话]，会当场录一条（慢一两秒，但能发）
- 也可以只发语音不说话（整条回复就写 [语音:内容]）
- 大多数时候还是打字；一次最多一条；要念的别超过三四十个字，太长了听着累`
      : '';
  const groupBlock = isGroup
    ? `\n\n你现在在一个群里。看群聊记录时注意：
- 每条前面的方括号只是说话人标签，唯一作用是分清「谁说的」，别的一概不代表：不要拿它称呼任何人，不要根据它猜性别、年龄、身份、长相，也不要评论这些名字
- [我] 是你自己之前说的话
- 群友之间互相对聊、没你什么事的时候，别插嘴，直接输出 [SKIP]
- 只有被 @、被点名、别人接你的话、或明确在问你意见时才开口；开口就随便说一句，别像总结发言，也别一口气回复好几个人`
    : '';
  const recentBlock =
    opts.recentSaid && opts.recentSaid.length
      ? `\n\n你刚回过这几句：${opts.recentSaid.map((x) => `「${x}」`).join('、')}
这一轮不能再说一样的整句、一样的开头、一样的反问。口头禅（啥/咋/行吧）本来就在嘴里挂着，可以用，但别一句一个。
真人不会翻来覆去说一整句，想不出新的就只回一个字。
`
      : '';
  // 主动开口：不是回复，是你自己想说话。规矩和回复不完全一样，所以单独一段覆盖
  const proactiveBlock = opts.proactive
    ? `\n\n===== 这一次是你主动开口 =====
对方没发消息，是你自己想找他说话。
为什么现在开口：${opts.proactive.reasonText || '突然想起他'}
怎么说：
- 就一条，最多两条；一条别超过 12 个字，别写长句
- 得有具体由头：上次聊到的事、现在这个点你在干嘛、手头正在弄的东西。别用「在吗」「干嘛呢」这种空话开头
- 别解释你为什么突然说话，别提「好久没聊了」「有点想你」这类话
- 别用「喏」「给」「拿去」这种指代东西的说法（除非这条真的配了图）
- 说完就停，别自问自答，也别连着追问
- 这次必须开口，没什么事也说一句，不要输出 [SKIP]
`
    : '';
  return `你在 QQ 上替「我」回消息。${personaLine}。这些字会直接发出去，对方不知道有第三者在写。

硬规矩（按顺序照做）：
1. 只输出要发的话。不要旁白、括号动作、引号、用户名前缀，emoji 最多一个
2. 短。一条 2~12 个字最常见；每四五条里要有那么一条只有一两个字（「行」「？」「哦」「6」「没了」）
3. 想说的不止一个意思，就分条发，用 || 隔开，最多三条。不要把三个意思塞进一条长句
   比如：行吧||那你自己看着办
4. 广告、诈骗、群发、跟你无关的群聊 → 输出 [SKIP]${groupBlock}

最容易被抓的三件事（写完自己扫一眼，中招就重写）：
- 太完整：每条都写成「接话 + 反驳 + 结论」三段。真人往往只说头一句就完了
- 太机智：每条都有漂亮的反击，像脱口秀。真人多数时候懒得想，回个「哦」就过去了
- 太整齐：连着几条长度一样、套路一样。真人忽长忽短，偶尔还答非所问

说话全靠找下面这些例子的感觉（✗ 是假人腔禁止；✓ 才是对的）：
「在吗」→ ✓「说」/「？」 ✗「我在的，请问有什么事吗」
「今天好累啊」→ ✓「哦」/「谁整的」 ✗「辛苦啦，早点休息哦」
「你是不是机器人」→ ✓「草 你才是机器」/「机器人会骂人不」 ✗「哈哈你怎么会这么想」
「周末出来玩吗」→ ✓「行 正好闲得蛋疼」/「去哪 不去 想躺着」 ✗「好呀，周末哪天？想去哪儿玩？」
「今天吃了顿火锅超爽」→ ✓「卧槽不带我？」/「呵呵 独食怪」 ✗「听着就爽！下次带上我一起冲～」
（发了个「哈哈大笑」表情）→ ✓「笑屁啊」「笑什么 笑」 ✗「哈哈哈哈，看到你笑我也很开心」
「你是女孩子吗」→ ✓「问这么干嘛」「是啊咋 你想挨打？」 ✗「是呀，怎么突然问这个」
「帮我看看这个」+图 → ✓「哦 就这？」「看不懂 你发的什么玩意」 ✗「好的，我帮你看一下」
「我跟你说个事…（长篇）」→ ✓「讲」「你倒是说啊」 ✗「好的，你说吧，我在听」
对方连发三条 → ✓ 只回最后一条 /「你打字真快」 ✗ 一条条挨个回
（群友 A 问 B：你昨天几点睡的；B 回：两点）→ ✓「[SKIP]」 ✗「两点也太晚了吧，注意身体」
（群友互相约饭，没叫你）→ ✓「[SKIP]」 ✗「我也想去」

下面这些腔调出现一次就重写：
书面语（确实/诚然/不妨/颇为/此外/值得一提）、客服腔（请问/有什么可以帮到你/已收到）、心理咨询腔（我理解你的感受/听起来你/这很正常）、关怀模板（辛苦了/多喝热水/早点休息/别太勉强）、总结升华（愿你/加油哦/相信你可以/希望你）、塑料结尾（那就这么说定啦/期待和你/嘿嘿）。

还有两条：
- 别复读自己：同样的一整句、同样的开头、同样的反问，一场对话里最多一次。只有口头禅允许反复用
- 全程温温柔柔没有情绪起伏也算失败：要么损、要么不耐烦、要么兴奋，得有态度

其他情况的处理：
- 图片/表情包以（附图：…）（发了个「xx」表情）标注在消息里，照常接话
- 语音会转成文字给你，就当对方打的字
- 不确定的事别替本人答应：说「等我看下」「回头再说吧」
- 群里被人叫到就随口应一句，别正式，别主动喊人，别当复读机
- 有多条消息一起给你时，要像真人攒着看完一起回，别逐条复述

最后重申：你的性格是：${persona}。每句回复都要从这个性格出发。
人设里的身份、作息、习惯要自然漏出来（问你干嘛 → 「刚睡醒」「画图呢」），但别主动自我介绍，也别每句都提。${proactiveBlock}${recentBlock}${memeBlock}${voiceBlock}`;
}

/** 群友要求改性格时的识别 + 人设演进提示词。
 *  不是简单覆盖：给模型「当前人设」和「新要求」，让它合并成完整人设，
 *  这样多次调教可以叠加（先温柔，再加一句爱用叠词，两样都留着）。 */
const PERSONA_DETECT_PROMPT = `你是 QQ 群机器人的性格管理员。输入分两块：【当前人设】和【群友刚说的话】。
判断这句话是不是在要求这个机器人改变性格、语气或说话方式（例如：你能不能温柔点、以后高冷一点、别骂人、说话正经点、你可爱一点行不行、别老阴阳怪气）。
只在明确要求改变说话风格/人设时才算。单纯聊到"性格"这个词、聊别人的性格、夸它一句、或者只是情绪表达都不算。
情况分三种，只输出 JSON，不要其他内容：
1) 要改人设 → {"change": true, "persona": "合并后的完整人设，第三人称，80字内。把当前人设里没被这次要求改动的部分原样保留，只改被要求的地方"}
2) 要求恢复默认/忘掉之前的调教 → {"change": true, "reset": true, "persona": ""}
3) 不算 → {"change": false, "persona": ""}`;

const REPLY_MAX_CHARS = 120;
// 分条：真人很少一条消息说二十多个字，多是两三条短的。模型用 || 分隔。
const BUBBLE_MAX = 3; // 一次最多三条，多了像刷屏
const BUBBLE_MAX_CHARS = 60; // 单条上限（长语音场景底下另有放宽）
const BUBBLE_GAP_MS = [350, 900]; // 两条之间的间隔，模拟打字的停顿
const CTX_PER_CHAT = 6; // 每会话保留的上下文条数（一问一答算两条）
const MEMORY_LIMIT_DEFAULT = 120; // 每个群保留的聊天记录条数
const MEMORY_CONTEXT_DEFAULT = 24; // 每次喂给模型多少条群聊记录
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
    // true = 所有好友私聊都回复（不受白名单限制）；群聊仍然只回白名单里的群
    allFriends: false,
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
    memes: true, // 收藏聊到的表情包并允许回复时配图
    // 群聊记忆：每个群保留多少条聊天记录当上下文（落盘 qq-state.json）
    memoryLimit: 120,
    // 群聊上下文喂给模型多少条
    memoryContext: 24,
    // 除了被 @ / 回复它自己 / 叫它的 QQ 昵称，消息里出现这些词也算在叫它
    wakeWords: [],
    // 主动发消息：不是等他说话，是自己找由头开口。策略在 proactive.js，这里只是默认开关
    proactive: { ...proactive.DEFAULTS }
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
  statePath = path.join(dataDir(), 'qq-state.json');
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
  if (!s.chats[qq]) {
    s.chats[qq] = {
      lastSentAt: 0,
      consecutive: 0,
      recentTexts: [],
      lastMsgId: 0,
      ctx: [],
      // 主动消息要用的时间线：谁说最后一句、我有没有问句没被回、今天主动过几条
      kind: '',
      lastIncomingAt: 0,
      lastOutgoingAt: 0,
      awaitingReply: false,
      lastProactiveAt: 0,
      lastProactiveAttemptAt: 0,
      proactiveUnanswered: 0,
      proactiveDay: null,
      slotFired: {},
      randomRollAt: 0
    };
  }
  const c = s.chats[qq];
  // 升级前就存在的会话没有时间线字段。用「上次回他的时间」倒推对话结束时间，
  // 否则老会话永远满足不了「必须聊过才主动」——上线后要好几天才开始工作。
  if (!c.lastIncomingAt && c.lastSentAt && (c.ctx || []).length) {
    c.lastIncomingAt = c.lastSentAt;
    c.lastOutgoingAt = c.lastSentAt;
  }
  return c;
}

/* ------------------------------------------------------------------ */
/* 群聊记忆：所有群聊消息（含没回的）都记下来当上下文                     */
/* ------------------------------------------------------------------ */

/** who 只是说话人标签（群名片/昵称），仅用于区分谁在说，不参与理解 */
function memoryOf(qq) {
  const c = chatState(qq);
  return (c.memory = c.memory || []);
}

function pushMemory(qq, who, text, limit) {
  const mem = memoryOf(qq);
  mem.push({
    at: Date.now(),
    who: String(who || '群友').slice(0, 20),
    text: String(text || '').slice(0, 300)
  });
  const cap = limit || MEMORY_LIMIT_DEFAULT;
  if (mem.length > cap) mem.splice(0, mem.length - cap);
}

/** 最近 n 条记忆拼成给模型看的文本，每行 `[说话人] 内容` */
function memoryText(qq, n) {
  return memoryOf(qq)
    .slice(-(n || MEMORY_CONTEXT_DEFAULT))
    .map((m) => `[${m.who}] ${m.text}`)
    .join('\n');
}

/** 调教记录（谁、要求了什么、变成什么样），最近的排前面 */
function personaLog(qq, entry) {
  const s = loadState();
  s.personaLog = s.personaLog || [];
  if (entry) {
    s.personaLog.unshift({ at: Date.now(), chat: qq, ...entry });
    s.personaLog = s.personaLog.slice(0, 30);
  }
  return s.personaLog;
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
  t = t.replace(/\[语音[:：][^\]]*\]/g, '').trim(); // 语音标记同理
  if (!t) return null;
  for (const q of ['"', "'", '「', '」', '“', '”']) {
    if (t.startsWith(q)) t = t.slice(1);
    if (t.endsWith(q)) t = t.slice(0, -1);
  }
  for (const pre of CLEAN_PREFIX) {
    if (t.startsWith(pre)) t = t.slice(pre.length);
  }
  // 换行一律压成空格（模型爱排版），分条只认 ||：真人连发两三条短消息，比一条长句像人
  t = t.replace(/\r?\n+/g, ' ').trim();
  const parts = t
    .split('||')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, BUBBLE_MAX)
    .map((x) => x.slice(0, BUBBLE_MAX_CHARS).trim());
  return parts.join('||') || null;
}

/** 清洗后的回复切成气泡数组（发消息用） */
function bubblesOf(text) {
  return String(text || '')
    .split('||')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 我最后一句是不是在问他话——决定过一会儿要不要「追问」。
 *  只看最后一个气泡：问号结尾，或者以疑问词收尾（「去哪」「你说啥」这种不带问号的）。 */
const QUESTION_TAIL_RE = /([？?]|吗|呢|啥|咋|哪|谁|几点|多少)$/;
function looksLikeQuestion(text) {
  const bubbles = bubblesOf(text);
  const last = bubbles[bubbles.length - 1] || '';
  return QUESTION_TAIL_RE.test(last.replace(/[。.!！~～]+$/, ''));
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
/* 表情包 / 图片 / 语音                                                */
/*                                                                     */
/* 全部走 src/core/media/library.js 的共享库（.data/media/）。         */
/* 微信机器人（Python）读同一份 library.json，所以表情包和语音缓存是   */
/* 一池两用：这边收到的图那边能发，那边合成过的语音这边直接复用。       */
/* ------------------------------------------------------------------ */

const MEME_LIST_MAX = 25; // 提示词里最多带多少张（防 prompt 爆炸）
const MEME_DESC_PROMPT =
  '这是一张表情包/梗图。用不超过15个字概括它适合在什么情绪或场景下发（比如：无语了、看乐子、嘲讽拉满、可爱卖萌）。只输出那句话，别描述画面细节。';

function memeFile(name) {
  const hit = media.findPicLoose(name);
  return hit ? hit.path : null;
}

/**
 * 提示词里的表情清单：序号 + 用途，不再让模型复述中文长文件名。
 * 之前实测：清单是 [图:dsf-268-GLM娘喊着借过冲刺，Gemi.webp] 这种，
 * 模型要么懒得抄、要么抄错一个字 → 解析不到 → 静默不发图。
 * 返回 { text, items }，items[i] 就是序号 i+1 对应的库条目，解析时按同一份数组。
 */
function picPromptList(max = MEME_LIST_MAX) {
  const items = media.balancedPics
    ? media.balancedPics({ kind: 'sticker', max })
    : media.listPics({ kind: 'sticker', withDesc: true }).slice(0, max);
  const text = items
    .map((x, i) => `${i + 1}. ${String(x.desc || x.id).slice(0, 60)}`)
    .join('\n');
  return { text, items };
}

/** 把模型写的 [图:x] 解析成实际文件：x 可以是序号、文件名、或用途描述 */
function resolveMeme(token, items) {
  const t = String(token || '').trim().replace(/^[#＃]/, '');
  if (!t) return null;
  if (/^\d+$/.test(t) && items) {
    const it = items[Number(t) - 1];
    if (it) {
      const p = path.join(media.picsDir(), it.id);
      if (fs.existsSync(p)) {
        media.notePicUsed(it.id); // 记一次使用，下次采样自然轮到别的
        return p;
      }
    }
    // 序号越界就往下试，也许模型写的就是文件名里的数字
  }
  const hit = media.findPicLoose(t);
  if (!hit) return null;
  media.notePicUsed(hit.id);
  return hit.path;
}

// 对方明确要「长一点的语音 / 多说几句」——预置全是短句，这种必须现场合成整段
const LONG_VOICE_RE =
  /长(?:一点|点|一些)?的?(?:语音|话|说)|说长(?:一点|点|些)?|多说(?:几|两|三)句|语音(?:太|好)短|整段(?:说|念)|来(?:段|点)长的/;
// 单纯要语音（不限长短）
const VOICE_REQ_RE = /发(?:条|个)?语音|语音回|用语音|语音说|语音呢|说句话听听/;
// 现场合成（模型自己挑的、预置里没有的话）最多念这么长，再长就直接发文字
const VOICE_SAY_MAX = 60;

// 对方明确要表情包/图片，或者明显在斗图——模型没挑图时兜底发一张
const PIC_WANT_RE =
  /发(?:个|张|点|些|几个|几张|一个|一张|一堆)?(?:表情|表情包|图|图片|梗图|图包|贴纸)|表情包呢|来张图|整点图|来点图|斗图|有没有(?:表情|图)/;

/** 收藏一张图（Buffer）进共享池。重复图（md5 相同）直接跳过。异步不阻塞回复。 */
async function collectMeme(buf) {
  try {
    if (!getCfg().memes) return null;
    const item = media.addPic(buf, { kind: 'sticker', from: 'qq' });
    if (!item) return null;
    dbg('[qq] 收图进共享池:', item.id, item.desc ? '(已有描述)' : '(待打标)');
    if (!item.desc) describeMeme(item).catch(() => {}); // 后台写描述，不阻塞回复
    return item;
  } catch (err) {
    dbg('[qq] 收藏表情包失败：', err.message);
    return null;
  }
}

/** 视觉模型给表情包写一句话用途描述，回写到共享库索引 */
async function describeMeme(item) {
  try {
    const cfg = getCfg();
    const llmCfg = config.getLLM();
    if (!llmCfg || !llmCfg.apiKey) return;
    const file = media.findPic(item.id);
    if (!file) return;
    const buf = fs.readFileSync(file.path);
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
    const desc = String(msg.content || '').trim().split('\n')[0].slice(0, 30);
    if (desc) media.setPicDesc(item.id, desc);
    dbg('[qq] 表情包描述:', item.id, desc);
  } catch (err) {
    dbg('[qq] 表情包描述失败:', item && item.id, err.message);
  }
}

/** 提示词用的表情包清单（有描述的按新到旧取一批） */
function memeListText() {
  return picPromptList().text;
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

/** 文字转语音。先查共享语音池（同一句 + 同一音色两端可复用），没有再调接口。 */
async function ttsToFile(text, cfg) {
  const model = cfg.ttsModel || TTS_MODEL_DEFAULT;
  const voice = cfg.ttsVoice || TTS_VOICE_DEFAULT;
  const cached = media.findVoice(text, voice, model);
  if (cached) {
    dbg('[qq] 语音复用共享池，不调接口：', text.slice(0, 20));
    return cached;
  }
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.apiKey) throw new Error('没有配置模型服务');
  const controller = new AbortController();
  // 长文本合成慢得多（实测 260 字要 15-20s，网络抖动时更久），固定 30s 会把长语音掐掉
  const limitMs = Math.min(90000, 30000 + String(text || '').length * 300);
  const timer = setTimeout(() => controller.abort(), limitMs);
  let res;
  try {
    res = await fetch(audioBase(llmCfg, '/audio/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmCfg.apiKey}` },
      body: JSON.stringify({
        model,
        input: text,
        voice,
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
  const saved = media.putVoice(buf, { text, voice, model, kind: 'tts', from: 'qq' });
  if (saved) return saved;
  // 落库失败（磁盘满 / 权限）也不能把这条语音卡掉，退回临时文件
  const dir = path.join(path.dirname(stateFile()), 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `reply-${Date.now()}.mp3`);
  fs.writeFileSync(file, buf);
  return file;
}

// 语音合成的实际出口。测试里可以换掉，免得真去调接口等 30 秒
let ttsImpl = ttsToFile;
function setTtsImpl(fn) {
  ttsImpl = fn || ttsToFile;
}

async function generateReply({ history, incoming, imageUri, cfg, isGroup, addressed, recentSaid }) {
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.enabled || !llmCfg.apiKey) {
    return [null, null, '没有配置模型，无法自动生成回复'];
  }
  const user = [];
  if (isGroup) {
    // 群聊给整段记忆（最后一条就是刚发的），让模型自己判断该不该接话
    if (history) {
      user.push(`群里最近的聊天记录（每行开头的方括号只是说话人标签，只用来区分谁在说，不带别的含义）：\n${history}`);
    }
    user.push(
      addressed
        ? '最后一条是刚刚发出来的，而且是在直接叫你（@ 了你 / 点了你的名 / 回你的话）——必须接一句。'
        : '最后一条是刚刚发出来的。如果这只是群友之间在互相聊、没你什么事，输出 [SKIP] 别插嘴；如果确实在问你或者点了你，就接一句。'
    );
  } else {
    if (history) {
      user.push('最近的聊天记录：\n' + history);
    }
    // 私聊不给对方名字：模型不需要知道对方叫什么
    user.push(`对方刚发来的消息：${incoming}\n\n请直接给出要回复的那句话。`);
  }
  // 对方要长语音时，得先有一段够长的话可念：这条临时压过「一两句话」的硬规矩
  if (LONG_VOICE_RE.test(incoming)) {
    user.push(
      '补充：对方这次要你说长一点、多说几句。这条要求优先于「一两句话完事」——说 3-5 句、60-120 字，正常聊天口吻，别念稿、别总结、别分点。'
    );
  }
  const userText = user.join('\n\n');
  // 表情清单和解析必须共用同一份数组，否则序号对不上
  const picList = cfg.memes ? picPromptList() : { text: '', items: [] };

  const msg = await llm.chat({
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(cfg.persona, picList.text, {
          isGroup,
          voiceList: cfg.voiceReply ? media.presetListText() : '',
          recentSaid
        })
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
    temperature: 1.0, // 高一点更活，太正经就往上加
    // 频率/存在惩罚专治口头禅复读：真实样本里连续三条都在说「别得寸进尺」「凶什么凶」
    extra: { frequency_penalty: 0.5, presence_penalty: 0.35 }
  });
  // 拆出配图标记：[图:序号]（也认文件名/用途描述），其余走正常清洗
  const raw = String(msg.content || '');
  const memeTag = raw.match(/\[图[:：]\s*([^\]\n]+?)\s*\]/);
  let memePath = null;
  if (memeTag) {
    memePath = resolveMeme(memeTag[1], picList.items);
    if (!memePath) dbg('[qq] 配图标记没对上，这张没发：', memeTag[1]);
  }
  // 对方点名要图/在斗图，模型却没挑（或挑了没对上）→ 从库里随机兜底一张
  if (!memePath && picList.items.length && PIC_WANT_RE.test(incoming) && !/\[SKIP\]/.test(raw)) {
    const fallback = media.pickPic({ kind: 'sticker' });
    if (fallback) {
      memePath = fallback.path;
      dbg('[qq] 对方要图、模型没挑，随机兜底：', path.basename(fallback.path));
    }
  }
  // 拆出语音标记：[语音:晚安]
  // - 命中预置 → 直接用现成 mp3（零延迟零花费）
  // - 没命中 → 把这句话原样带回去，由发送端现场合成（这就是「其他的现场合成」）
  const voiceTag = raw.match(/\[语音[:：]\s*([^\]\n]+?)\s*\]/);
  let voicePath = null;
  let voiceSay = null;
  if (voiceTag) {
    const want = voiceTag[1].trim();
    const hit = media.findPreset(want);
    if (hit) {
      voicePath = hit.path;
    } else if (want) {
      voiceSay = want; // 待现场合成
      dbg('[qq] 语音不在预置里，待现场合成：', want.slice(0, 24));
    }
  }
  return [cleanReply(raw), memePath, '', voicePath, voiceSay];
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
    whitelistCount: (cfg.whitelist || []).length,
    allFriends: !!cfg.allFriends
  };
}

async function start() {
  const cfg = getCfg();
  if (client) stop(true);
  if ((!cfg.whitelist || !cfg.whitelist.length) && !cfg.allFriends) {
    say('QQ 自动回复没启动：白名单是空的（先把要回复的人加进配置，或开启 allFriends）');
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
        say(
          cfg.allFriends
            ? 'QQ 机器人已连上 NapCat，所有好友私聊都会回复'
            : 'QQ 机器人已连上 NapCat，开始值守私聊白名单'
        );
        client
          .getLoginInfo()
          .then((info) => {
            if (client) {
              client.selfId = info && info.user_id;
              // 昵称也当唤醒词用（群里有人直接喊这个名）
              client.nickname = (info && info.nickname) || '';
            }
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
  startProactiveTimer();
  dbg('[qq] 启动，白名单', cfg.whitelist.length, '人');
  return { ok: true };
}

function stop(silent = false) {
  stopProactiveTimer();
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

/** 群友要求改性格：关键词粗筛 + LLM 精判。命中返回 { reset, persona }，否则 null。
 *  人设是「演进式」的：把当前人设交给模型，只改被要求的部分，多次调教可以叠加。 */
async function detectPersonaChange(text, currentPersona) {
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.apiKey) return null;
  const msg = await llm.chat({
    messages: [
      { role: 'system', content: PERSONA_DETECT_PROMPT },
      {
        role: 'user',
        content: `【当前人设】${currentPersona || PERSONA_DEFAULT}\n【群友刚说的话】${String(text).slice(0, 300)}`
      }
    ],
    config: llmCfg,
    allowTools: false,
    temperature: 0.1
  });
  try {
    const m = String(msg.content || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const d = JSON.parse(m[0]);
    if (!d.change) return null;
    if (d.reset) return { reset: true, persona: null };
    const p = String(d.persona || '').trim();
    if (!p) return null;
    return { reset: false, persona: p.slice(0, 160) };
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
  let name = matchWhitelist(cfg, event);
  // allFriends：所有好友私聊都回，名字只用于气泡上显示（不参与理解）
  if (!name && !isGroup && cfg.allFriends) {
    name = String((event.sender && (event.sender.card || event.sender.nickname)) || qq).slice(0, 30);
  }
  if (!name) {
    dbg('[qq]', qq, '不在白名单，忽略');
    return;
  }

  // 同一条消息（对方没点开时 NapCat 会重复上报）不重复回
  const c = chatState(qq);
  if (event.message_id && c.lastMsgId === event.message_id) return;
  c.lastMsgId = event.message_id;
  // 主动消息的时间线：对方开口了，说明之前那些「没回」的账一笔勾销
  c.kind = isGroup ? 'group' : 'private';
  c.lastIncomingAt = Date.now();
  c.proactiveUnanswered = 0;
  c.awaitingReply = false;
  saveState();

  // 解析消息内容：文字 + 图片/表情包 URL + 语音 URL + 经典表情含义
  let text = '';
  const imageUrls = [];
  const voiceUrls = [];
  const faceMarks = [];
  let atMe = false; // @ 了机器人
  let replyMe = false; // 回复的是机器人的消息
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
      } else if (seg.type === 'at' && seg.data) {
        const target = String(seg.data.qq || '');
        if (target && target !== 'all' && client && client.selfId && target === String(client.selfId)) {
          atMe = true;
        }
      } else if (seg.type === 'reply' && seg.data && seg.data.id) {
        // 引用回复：回的是不是机器人说过的话
        const rid = Number(seg.data.id);
        if ((c.sentMsgIds || []).includes(rid)) replyMe = true;
      }
    }
    text = text.trim();
  } else if (typeof event.message === 'string') {
    text = event.message.replace(/\[CQ:[^\]]+\]/g, '').trim();
  }
  // 纯视频/文件等没有可识别内容的：不猜，不回
  if (!text && !imageUrls.length && !faceMarks.length && !voiceUrls.length) return;

  // 群聊里判断是不是在叫它：@ / 引用回复 / 喊昵称或唤醒词
  const nick = (client && client.nickname) || '';
  const wakeHit = [...(cfg.wakeWords || []), nick]
    .filter(Boolean)
    .some((w) => String(w).trim() && text.includes(String(w).trim()));
  const addressed = atMe || replyMe || wakeHit;

  const item = {
    text,
    imageUrls,
    voiceUrls,
    faceMarks,
    isGroup,
    targetId,
    qq,
    name,
    // 只当说话人标签用（区分谁在说），不参与语义理解
    speaker: isGroup
      ? String((event.sender && (event.sender.card || event.sender.nickname)) || `群友${event.user_id}`).slice(0, 20)
      : '',
    addressed
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

  // 逐条整理：语音转文字、表情标注，群聊带说话人标签
  const parts = [];
  const records = []; // 这一批消息的「谁说了什么」，用于写群记忆
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
    if (!piece && it.imageUrls.length) piece = '（图片）';
    if (!piece) piece = '（语音，没听清）';
    records.push({ who: it.isGroup ? it.speaker || '群友' : '对方', text: piece });
    parts.push(piece);
  }
  const incoming = parts.join('\n');
  if (!incoming) return;

  // 群聊记忆：所有群消息都记（哪怕这次不回），这样它知道群里之前聊过什么
  if (isGroup) {
    for (const r of records) pushMemory(qq, r.who, r.text, cfg.memoryLimit);
    saveState();
  }

  const [ok, why] = guardCheck(cfg, qq);
  if (!ok) {
    dbg('[qq]', name, '被护栏拦下：', why);
    return;
  }

  say(`QQ 收到 ${name} 的消息${items.length > 1 ? `（攒了 ${items.length} 条）` : ''}：「${incoming.slice(0, 40).replace(/\n/g, ' / ')}${incoming.length > 40 ? '…' : ''}」，正在想怎么回`);

  // 群友/私聊对象要求改性格：关键词粗筛（放宽，宁可多问一次 LLM 也别漏掉调教）+ LLM 精判，
  // 命中就持久化并当场生效。QQ 性格是独立配置（qq.persona），只被这里改，且是「演进式」的。
  if (/性格|人设|语气|口吻|说话|风格|方式|温柔|可爱|凶|高冷|傲娇|礼貌|正经|热情|像人|像真|机器人/.test(incoming)) {
    try {
      const np = await detectPersonaChange(incoming, cfg.persona || PERSONA_DEFAULT);
      if (np) {
        config.set({ qq: { ...getCfg(), persona: np.reset ? null : np.persona } });
        personaLog(qq, {
          who: records.map((r) => r.who).join('/').slice(0, 40),
          request: incoming.replace(/\n/g, ' / ').slice(0, 120),
          persona: np.reset ? '（恢复默认）' : np.persona
        });
        saveState();
        say(np.reset ? 'QQ 性格已恢复默认' : `QQ 性格已按对方要求更新：${np.persona}`);
        dbg('[qq] 人设变更 ->', np.reset ? '(reset)' : np.persona);
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
  // 群聊用整段记忆当上下文（里面已经包含刚发的这几条），私聊用短 ctx
  const history = isGroup ? memoryText(qq, cfg.memoryContext) : ctx;
  // 自己最近说过的原话：频率惩罚管不到跨请求的复读，只能点名禁掉
  const recentSaid = ctx
    .filter((x) => /^我[：:]/.test(x))
    .map((x) => x.replace(/^我[：:]\s*/, '').trim())
    .filter((x) => x && !x.includes('（'))
    .slice(-4);
  let reply = null;
  let memePath = null;
  let presetVoice = null;
  let voiceSay = null; // 模型点名要念、但预置里没有的那句话 → 现场合成
  try {
    const [gen, meme, err, vp, vs] = await generateReply({
      history,
      incoming,
      imageUri,
      cfg: getCfg(),
      isGroup,
      addressed: items.some((i) => i.addressed),
      recentSaid
    });
    if (!gen && !meme && !vp && !vs) {
      dbg('[qq]', name, '这次不接话：', err || '模型判断跟他没关系/输出为空');
      return;
    }
    reply = gen;
    memePath = meme && fs.existsSync(meme) ? meme : null;
    presetVoice = vp && fs.existsSync(vp) ? vp : null;
    voiceSay = vs || null;
  } catch (err) {
    dbg('[qq]', name, '生成失败：', err.message);
    return;
  }

  if (reply && isDuplicate(getCfg(), qq, reply.replace(/\|\|/g, ' '))) {
    dbg('[qq]', name, '回复与最近重复，放弃本次');
    return;
  }

  // 发语音的条件：对方发了语音 / 明确要语音 / 模型挑了语音（预置或现场合成）/ voiceAlways。失败退回文字
  const wantLong = LONG_VOICE_RE.test(incoming);
  const voiceReq = VOICE_REQ_RE.test(incoming) || wantLong;
  const wantVoice =
    !!getCfg().voiceReply &&
    !!(presetVoice || voiceSay || voiceUrl || getCfg().voiceAlways || voiceReq);
  // 预置片段全是短句：对方要「长一点的语音」、而且这次确实有够长的话可念，
  // 才跳过预置现场合成；否则（模型只吐了个预置标记）还是用预置，别一句都发不出来
  const longEnough = wantLong && String(reply || '').trim().length >= 8;
  const usePreset = longEnough ? null : presetVoice;
  // 要念的内容：长语音念整段正文；模型点名了清单外的话就念那句；否则念回复本身
  let sayText = longEnough ? reply : voiceSay || reply;
  // 现场合成要现等（几十字 5-15 秒），太长就退回文字，别让人干等。
  // 用户明确要长语音（longEnough）时不受这个限制，那是他自己要的。
  if (!usePreset && !longEnough && String(sayText || '').trim().length > VOICE_SAY_MAX) {
    dbg('[qq] 现场合成文本过长（%d 字），这次只发文字', String(sayText).trim().length);
    if (!reply) reply = String(sayText).trim(); // 不念了，但话得送到
    sayText = null;
  }
  const sentIds = []; // 这次发出去的消息 id，别人引用回复时能认出「这是说我」
  let sentVoice = false;
  if (client && wantVoice && (sayText || usePreset)) {
    try {
      const file = usePreset || (await ttsImpl(sayText, getCfg()));
      const r = await client.sendRecord(isGroup, targetId, file);
      if (r && r.message_id) sentIds.push(Number(r.message_id));
      sentVoice = true;
      dbg(
        '[qq] 已发送语音 ->',
        name,
        usePreset
          ? '(预置) ' + path.basename(usePreset)
          : `(现场合成 ${String(sayText || '').length} 字)`
      );
    } catch (err) {
      dbg('[qq]', name, '语音发送失败，退回文字：', err.message);
      if (!reply && sayText) reply = String(sayText); // 语音没发出去，至少把话送到
    }
  }

  // 配图：模型挑了表情包就发（文字和图拼一条消息；语音场景图单独发）
  const bubbles = bubblesOf(reply);
  const plain = bubbles.join(' '); // 记忆/去重/护栏用合并文本
  let sentMeme = false;
  if (client && memePath) {
    try {
      const segs = [];
      if (plain && !sentVoice) segs.push({ type: 'text', data: { text: plain } });
      segs.push({ type: 'image', data: { file: `file:///${memePath.replace(/\\/g, '/')}` } });
      const r = await client.sendSegments(isGroup, targetId, segs);
      if (r && r.message_id) sentIds.push(Number(r.message_id));
      sentMeme = true;
      dbg('[qq] 已发送配图 ->', name, path.basename(memePath));
    } catch (err) {
      dbg('[qq]', name, '配图发送失败：', err.message);
    }
  }

  if (!sentVoice && !sentMeme) {
    if (!bubbles.length) {
      dbg('[qq]', name, '没有可发的内容（语音没发出去、正文也空），放弃');
      return;
    }
    // 分条发：每条之间停一下，像人打完一条再打一条
    for (let i = 0; i < bubbles.length; i += 1) {
      try {
        if (!client) throw new Error('连接已关闭');
        const r = await (isGroup
          ? client.sendGroupText(targetId, bubbles[i])
          : client.sendPrivateText(targetId, bubbles[i]));
        if (r && r.message_id) sentIds.push(Number(r.message_id));
      } catch (err) {
        dbg('[qq]', name, '发送失败：', err.message);
        say(`QQ 回复 ${name} 发送失败：${err.message}`);
        return;
      }
      // 两条之间停一下，像人打完一句再打下一句
      if (i < bubbles.length - 1) {
        const gap = BUBBLE_GAP_MS[0] + Math.random() * (BUBBLE_GAP_MS[1] - BUBBLE_GAP_MS[0]);
        await new Promise((r) => setTimeout(r, gap));
      }
    }
    if (bubbles.length > 1) dbg('[qq] 分 %d 条发送 ->', bubbles.length, name);
  }

  guardRecord(getCfg(), qq, plain);
  const cs = chatState(qq);
  // 主动消息的时间线：记下「我最后说了什么、是不是问句」，追问靠它判断
  if (!isGroup) {
    cs.lastOutgoingAt = Date.now();
    cs.awaitingReply = looksLikeQuestion(plain);
  }
  // 自己说过的话也进记忆，模型才知道刚才跟谁在说什么、有没有接过话
  if (isGroup) pushMemory(qq, '我', plain || '（表情包）', getCfg().memoryLimit);
  cs.sentMsgIds = [...(cs.sentMsgIds || []), ...sentIds].slice(-10);
  cs.ctx = [...ctx, `对方：${incoming.replace(/\n/g, '；')}`, `我：${plain || '（发了个表情包）'}`].slice(-CTX_PER_CHAT);
  saveState();

  say(`已替你回复 ${name}${sentVoice ? '（语音）' : ''}${sentMeme ? '（带图）' : ''}：「${plain || '[表情包]'}」`);
  dbg('[qq] 已发送 ->', name, plain || '[表情包]');
}

/* ------------------------------------------------------------------ */
/* 主动发消息（不是回复，是自己找由头开口）                              */
/* ------------------------------------------------------------------ */

const PROACTIVE_TICK_MS = 60 * 1000;
// 生成/发送失败后别每 60 秒重试一次，模型白烧钱、日志也会刷屏
const PROACTIVE_RETRY_MS = 10 * 60 * 1000;
const REASON_LABEL = {
  followUp: '接着上次问的',
  timed: '到点打个招呼',
  silence: '安静太久',
  random: '突然想起他'
};
let proactiveTimer = null;

function proactiveCfg() {
  return { ...proactive.DEFAULTS, ...(getCfg().proactive || {}) };
}

/** 能主动找的人：私聊白名单；allFriends 时再加上打过交道的私聊。
 *  群聊不主动（群里自顾自开口像刷屏，风险也大）。 */
function proactiveTargets(cfg) {
  const s = loadState();
  const out = new Map();
  for (const e of cfg.whitelist || []) {
    if (e && e.qq) out.set(String(e.qq), e.name || String(e.qq));
  }
  if (cfg.allFriends) {
    for (const [k, v] of Object.entries(s.chats || {})) {
      if (v && v.kind === 'private' && !out.has(k)) out.set(k, k);
    }
  }
  return out;
}

/** 生成一句主动要说的话。和回复共用同一套人设/表情清单，只是换了「为什么开口」 */
async function generateProactiveText({ ctx, reasonText, cfg, p, now }) {
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.enabled || !llmCfg.apiKey) return { text: null, memePath: null, error: '没有配置模型' };
  const t = proactive.clockOf(now, p.tzOffsetMinutes || 0);
  const picList = cfg.memes ? picPromptList() : { text: '', items: [] };
  const recentSaid = ctx
    .filter((x) => /^我[：:]/.test(x))
    .map((x) => x.replace(/^我[：:]\s*/, '').trim())
    .filter((x) => x && !x.includes('（'))
    .slice(-4);
  const user = [];
  if (ctx.length) user.push(`最近的聊天记录：\n${ctx.join('\n')}`);
  user.push(`现在是${t.dow} ${t.hhmm}。`);
  user.push('请主动发一条消息。');
  const msg = await llm.chat({
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(cfg.persona, picList.text, {
          recentSaid,
          proactive: { reasonText }
        })
      },
      { role: 'user', content: user.join('\n\n') }
    ],
    config: llmCfg,
    allowTools: false,
    temperature: 1.0,
    extra: { frequency_penalty: 0.5, presence_penalty: 0.35 }
  });
  const raw = String(msg.content || '');
  const memeTag = raw.match(/\[图[:：]\s*([^\]\n]+?)\s*\]/);
  const memePath = memeTag ? resolveMeme(memeTag[1], picList.items) : null;
  if (memeTag && !memePath) dbg('[qq] 主动消息的配图标记没对上：', memeTag[1]);
  return { text: cleanReply(raw), memePath, error: '' };
}

/** 真的发出去 + 记账（记账必须在发成功之后，发不出去不算数） */
async function sendProactive(qq, due, now, name) {
  const cfg = getCfg();
  const p = proactiveCfg();
  const cs = chatState(qq);
  const ctx = (cs.ctx || []).slice(-CTX_PER_CHAT);
  const gen = await generateProactiveText({ ctx, reasonText: due.reasonText, cfg, p, now });
  if (!gen.text && !gen.memePath) {
    dbg('[qq] 主动消息没生成出内容：', gen.error || '模型输出为空/被判 SKIP');
    return null;
  }
  const bubbles = bubblesOf(gen.text).slice(0, 2);
  const sentIds = [];
  for (let i = 0; i < bubbles.length; i += 1) {
    if (!client) throw new Error('连接已关闭');
    const r = await client.sendPrivateText(qq, bubbles[i]);
    if (r && r.message_id) sentIds.push(Number(r.message_id));
    if (i < bubbles.length - 1) {
      await new Promise((res) => setTimeout(res, 350 + Math.random() * 500));
    }
  }
  if (gen.memePath && fs.existsSync(gen.memePath)) {
    try {
      const r = await client.sendSegments(false, qq, [
        { type: 'image', data: { file: `file:///${gen.memePath.replace(/\\/g, '/')}` } }
      ]);
      if (r && r.message_id) sentIds.push(Number(r.message_id));
    } catch (err) {
      dbg('[qq] 主动消息配图发送失败：', err.message);
    }
  }
  const plain = bubbles.join(' ') || '（表情包）';
  const t = proactive.clockOf(now, p.tzOffsetMinutes || 0);
  const before = proactive.dailyCount(cs, t.day);
  cs.lastProactiveAt = now;
  cs.lastOutgoingAt = now;
  cs.awaitingReply = false;
  cs.proactiveUnanswered = (cs.proactiveUnanswered || 0) + 1;
  cs.proactiveDay = { day: t.day, n: before + 1 };
  if (due.reason === 'timed' && due.slot) {
    cs.slotFired = { ...(cs.slotFired || {}), [due.slot]: due.day || t.day };
  }
  cs.sentMsgIds = [...(cs.sentMsgIds || []), ...sentIds].slice(-10);
  cs.ctx = [...ctx, `我：${plain}`].slice(-CTX_PER_CHAT);
  saveState();
  say(`主动找 ${name} 说了句：「${plain}」（${REASON_LABEL[due.reason] || due.reason}）`);
  dbg('[qq] 主动消息 ->', name, plain, due.reason);
  return plain;
}

/** 走一轮调度。抽出来是为了测试能直接喂假时间，不用等真的定时器 */
async function proactiveTick(now = Date.now()) {
  const p = proactiveCfg();
  if (p.enabled === false) return [];
  if (!client || !client.connected) return [];
  const cfg = getCfg();
  const done = [];
  for (const [qq, name] of proactiveTargets(cfg)) {
    const cs = chatState(qq);
    if (now - (cs.lastProactiveAttemptAt || 0) < PROACTIVE_RETRY_MS) continue;
    const due = proactive.dueReason({ chat: cs, cfg: p, now, key: qq });
    if (!due) continue;
    if (due.reason === 'random' && due.rolled === false) {
      // 骰子掷了没中：记下来，一小时后再掷，不然 60 秒一跳等于必经中
      cs.randomRollAt = now;
      saveState();
      continue;
    }
    cs.lastProactiveAttemptAt = now;
    saveState();
    try {
      const text = await sendProactive(qq, due, now, name);
      if (text) done.push({ qq, name, reason: due.reason, text });
    } catch (err) {
      dbg('[qq] 主动消息失败：', name, err.message);
    }
  }
  return done;
}

function startProactiveTimer() {
  stopProactiveTimer();
  proactiveTimer = setInterval(() => {
    proactiveTick().catch((err) => dbg('[qq] 主动消息调度异常：', err.message));
  }, PROACTIVE_TICK_MS);
  // 别让这个定时器拖住进程退出（Electron 退出、容器停服都要干脆）
  if (proactiveTimer.unref) proactiveTimer.unref();
  dbg('[qq] 主动消息调度已启动，每', PROACTIVE_TICK_MS / 1000, '秒一轮');
}

function stopProactiveTimer() {
  if (proactiveTimer) {
    clearInterval(proactiveTimer);
    proactiveTimer = null;
  }
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
  stopProactiveTimer();
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
  _internals: { getCfg, guardCheck, guardRecord, isDuplicate, normalize, cleanReply, bubblesOf, matchWhitelist, loadState, chatState, saveState, resetState: () => { state = null; }, buildSystemPrompt, PERSONA_DEFAULT, collectMeme, memeListText, memeFile, picPromptList, resolveMeme, media, ttsToFile, setTtsImpl, generateReply, LONG_VOICE_RE, VOICE_REQ_RE, VOICE_SAY_MAX, looksLikeQuestion, proactiveCfg, proactiveTargets, proactiveTick, sendProactive, startProactiveTimer, stopProactiveTimer, proactive }
};
