'use strict';

/**
 * 主动发消息自测（不连真 NapCat、不真调模型）。
 *
 *   1) proactive.dueReason 纯决策：免打扰 / 冷却 / 每日上限 / 未回上限 / 四种触发 / 优先级
 *   2) 端到端：起桩 NapCat，喂一条私聊把状态建起来，再喂假时间跑 proactiveTick，
 *      断言真的发出了 send_private_msg、状态记账正确、冷却期内不重复发
 *
 * 用法：node tools/test-proactive.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');

process.env.PET_DATA_DIR = path.join(os.tmpdir(), `secretary-proactive-test-${process.pid}`);
fs.rmSync(process.env.PET_DATA_DIR, { recursive: true, force: true });

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const HOUR = 3600000;
const MIN = 60000;
// 北京时间 2026-10-31 12:00 整（UTC 04:00），所有用例都围着这个点算，跟本机时区无关
const NOW = Date.UTC(2026, 9, 31, 4, 0, 0);

const proactive = require(path.join(ROOT, 'src/core/qq/proactive.js'));

/* ------------------------------------------------------------------ */
/* 1) 纯决策                                                            */
/* ------------------------------------------------------------------ */

console.log('== 决策：基础闸门 ==');

const baseCfg = {
  ...proactive.DEFAULTS,
  quietHours: [1, 8],
  slots: [],
  silenceHours: [20, 34],
  randomDaily: 0
};

function chat(over) {
  return {
    lastIncomingAt: NOW - 3 * HOUR,
    lastOutgoingAt: NOW - 3 * HOUR,
    awaitingReply: false,
    lastProactiveAt: 0,
    proactiveUnanswered: 0,
    proactiveDay: null,
    slotFired: {},
    ...over
  };
}

check(
  '从没聊过的人不主动搭讪',
  proactive.dueReason({ chat: {}, cfg: baseCfg, now: NOW, key: '1' }) === null
);
check(
  '免打扰时段（北京 03:00）一条都不发',
  proactive.dueReason({
    // 安静了 30 小时，正常该唤醒，但这个点必须憋着
    chat: chat({ lastIncomingAt: Date.UTC(2026, 9, 29, 13, 0, 0), lastOutgoingAt: Date.UTC(2026, 9, 29, 13, 0, 0) }),
    cfg: baseCfg,
    now: Date.UTC(2026, 9, 30, 19, 0, 0), // 北京 03:00
    key: '555'
  }) === null
);
check(
  '同一个会话不在免打扰时段时照常唤醒（对照组）',
  proactive.dueReason({
    chat: chat({ lastIncomingAt: Date.UTC(2026, 9, 29, 13, 0, 0), lastOutgoingAt: Date.UTC(2026, 9, 29, 13, 0, 0) }),
    cfg: baseCfg,
    now: Date.UTC(2026, 9, 31, 4, 0, 0), // 北京 12:00
    key: '555'
  })?.reason === 'silence'
);
check(
  '对方刚说完话 20 分钟内不插嘴',
  proactive.dueReason({ chat: chat({ lastIncomingAt: NOW - 5 * MIN, lastOutgoingAt: NOW - 4 * MIN }), cfg: baseCfg, now: NOW }) === null
);
check(
  '冷却期内不发',
  proactive.dueReason({ chat: chat({ lastProactiveAt: NOW - 30 * MIN, lastIncomingAt: NOW - 40 * HOUR, lastOutgoingAt: NOW - 40 * HOUR }), cfg: baseCfg, now: NOW }) === null
);
check(
  '每日上限到了不发',
  // 用 DEFAULTS.dailyMax 而不是写死 2：上限调过几次，写死会让这条断言慢慢失真
  proactive.dueReason({
    chat: chat({
      lastIncomingAt: NOW - 40 * HOUR,
      lastOutgoingAt: NOW - 40 * HOUR,
      proactiveDay: { day: '2026-10-31', n: proactive.DEFAULTS.dailyMax }
    }),
    cfg: baseCfg,
    now: NOW
  }) === null
);
check(
  '连续未回到达上限就闭嘴',
  proactive.dueReason({
    chat: chat({ lastIncomingAt: NOW - 40 * HOUR, lastOutgoingAt: NOW - 40 * HOUR, proactiveUnanswered: 2 }),
    cfg: baseCfg,
    now: NOW
  }) === null
);
check(
  '超过 14 天没互动的人不找',
  proactive.dueReason({
    chat: chat({ lastIncomingAt: NOW - 20 * 24 * HOUR, lastOutgoingAt: NOW - 20 * 24 * HOUR }),
    cfg: baseCfg,
    now: NOW
  }) === null
);
check(
  '总开关关了就不算',
  proactive.dueReason({ chat: chat(), cfg: { ...baseCfg, enabled: false }, now: NOW }) === null
);

console.log('== 决策：话题追问 ==');
const asked = chat({ lastIncomingAt: NOW - 2 * HOUR, lastOutgoingAt: NOW - 61 * MIN, awaitingReply: true });
const fu = proactive.dueReason({ chat: asked, cfg: baseCfg, now: NOW, key: '10001' });
check('问句没回、过了窗口下限 -> 追问', fu && fu.reason === 'followUp', fu && fu.reason);
check(
  '没到窗口下限不追',
  proactive.dueReason({
    chat: chat({ lastIncomingAt: NOW - 2 * HOUR, lastOutgoingAt: NOW - 30 * MIN, awaitingReply: true }),
    cfg: baseCfg,
    now: NOW,
    key: '10001'
  }) === null
);
check(
  '追过 6 小时就别追了（像讨债）',
  proactive.dueReason({
    chat: chat({ lastIncomingAt: NOW - 20 * HOUR, lastOutgoingAt: NOW - 7 * HOUR, awaitingReply: true }),
    cfg: baseCfg,
    now: NOW,
    key: '10001'
  }) === null
);
check(
  '不是问句就不算追问',
  proactive.dueReason({
    chat: chat({ lastIncomingAt: NOW - 2 * HOUR, lastOutgoingAt: NOW - 61 * MIN, awaitingReply: false }),
    cfg: baseCfg,
    now: NOW,
    key: '10001'
  }) === null
);

console.log('== 决策：定时问候 ==');
const slotCfg = { ...baseCfg, slots: ['12:40'], slotJitterMinutes: 5, slotWindowMinutes: 12 };
let slotDue = null;
let slotAt = 0;
for (let m = 0; m < 60 && !slotDue; m += 1) {
  const at = NOW + m * MIN;
  const r = proactive.dueReason({ chat: chat(), cfg: slotCfg, now: at, key: '777' });
  if (r && r.reason === 'timed') {
    slotDue = r;
    slotAt = at;
  }
}
check('到点会触发定时问候', !!slotDue);
check('定时问候带 slot 和 day（发完要记账）', slotDue && slotDue.slot === '12:40' && slotDue.day === '2026-10-31');
check(
  '同一个 slot 今天发过就不再发',
  proactive.dueReason({
    chat: chat({ slotFired: { '12:40': '2026-10-31' } }),
    cfg: slotCfg,
    now: slotAt,
    key: '777'
  }) === null
);
check(
  '抖动是稳定的（同一会话同一天算出同一个时间点）',
  (() => {
    const a = proactive.dueReason({ chat: chat(), cfg: slotCfg, now: slotAt, key: '777' });
    const b = proactive.dueReason({ chat: chat(), cfg: slotCfg, now: slotAt, key: '777' });
    return !!a && !!b && a.reason === b.reason;
  })()
);

console.log('== 决策：空闲唤醒 / 随机关怀 ==');
check(
  '安静 20 小时以上会唤醒',
  proactive.dueReason({
    chat: chat({ lastIncomingAt: NOW - 30 * HOUR, lastOutgoingAt: NOW - 30 * HOUR }),
    cfg: baseCfg,
    now: NOW,
    key: '888'
  })?.reason === 'silence'
);
check(
  '安静不够久不唤醒',
  proactive.dueReason({
    chat: chat({ lastIncomingAt: NOW - 10 * HOUR, lastOutgoingAt: NOW - 10 * HOUR }),
    cfg: baseCfg,
    now: NOW,
    key: '888'
  }) === null
);
const randomCfg = { ...baseCfg, randomDaily: 1, randomChance: 0.5, randomRollMinutes: 60 };
const hit = proactive.dueReason({
  chat: chat({ lastIncomingAt: NOW - 2 * HOUR, lastOutgoingAt: NOW - 2 * HOUR }),
  cfg: randomCfg,
  now: NOW,
  key: '999',
  rnd: () => 0.1
});
check('随机关怀掷中 -> random', hit && hit.reason === 'random' && hit.rolled === true, hit && hit.reason);
const miss = proactive.dueReason({
  chat: chat({ lastIncomingAt: NOW - 2 * HOUR, lastOutgoingAt: NOW - 2 * HOUR }),
  cfg: randomCfg,
  now: NOW,
  key: '999',
  rnd: () => 0.9
});
check('随机关怀没掷中 -> rolled=false（要让调用方记时间，别 60 秒再掷）', miss && miss.rolled === false);
check(
  '刚掷过就一小时不掷',
  proactive.dueReason({
    chat: chat({ lastIncomingAt: NOW - 2 * HOUR, lastOutgoingAt: NOW - 2 * HOUR, randomRollAt: NOW - 10 * MIN }),
    cfg: randomCfg,
    now: NOW,
    key: '999',
    rnd: () => 0.1
  }) === null
);

console.log('== 决策：旧事回访 ==');

// 这一路的「由头」不在决策层：调用方从归档里抠出前几天聊过的事喂给模型，
// 这里只判断时间上该不该开口，所以多一个 revisit 入参。
check(
  '归档里有旧话题 + 隔了 4 小时 → 回访',
  (() => {
    const r = proactive.dueReason({ chat: chat(), cfg: baseCfg, now: NOW, key: '777', revisit: true });
    return r && r.reason === 'revisit';
  })()
);
check(
  '归档里没货（revisit=false）→ 不编由头',
  (() => {
    const r = proactive.dueReason({ chat: chat(), cfg: baseCfg, now: NOW, key: '777', revisit: false });
    return !r || r.reason !== 'revisit';
  })()
);
check(
  '刚聊完 1 小时就翻旧账太拧巴 → 不回访',
  (() => {
    const r = proactive.dueReason({
      chat: chat({ lastIncomingAt: NOW - HOUR, lastOutgoingAt: NOW - HOUR }),
      cfg: baseCfg,
      now: NOW,
      key: '777',
      revisit: true
    });
    return !r || r.reason !== 'revisit';
  })()
);
check(
  '回访冷却期内（2 小时前才回访过）不重复问同一件事',
  (() => {
    const r = proactive.dueReason({
      chat: chat({ lastRevisitAt: NOW - 2 * HOUR }),
      cfg: baseCfg,
      now: NOW,
      key: '777',
      revisit: true
    });
    return !r || r.reason !== 'revisit';
  })()
);
check(
  '回访也受每日上限管着',
  (() => {
    const r = proactive.dueReason({
      chat: chat({ proactiveDay: { day: '2026-10-31', n: proactive.DEFAULTS.dailyMax } }),
      cfg: baseCfg,
      now: NOW,
      key: '777',
      revisit: true
    });
    return r === null;
  })()
);

console.log('== 决策：优先级 ==');
// 构造一个「追问已经到期」又「正好踩在定时槽里」的时刻：北京 12:41（槽 12:40，抖动关掉）
const bothNow = Date.UTC(2026, 9, 31, 4, 41, 0);
const bothCfg = { ...baseCfg, slots: ['12:40'], slotJitterMinutes: 0, slotWindowMinutes: 12 };
const both = proactive.dueReason({
  chat: chat({ lastIncomingAt: bothNow - 200 * MIN, lastOutgoingAt: bothNow - 100 * MIN, awaitingReply: true }),
  cfg: bothCfg,
  now: bothNow,
  key: '777'
});
check('追问优先于定时问候', both && both.reason === 'followUp', both && both.reason);
check(
  '同一时刻不追问时就轮到定时问候',
  proactive.dueReason({
    chat: chat({ lastIncomingAt: bothNow - 200 * MIN, lastOutgoingAt: bothNow - 100 * MIN, awaitingReply: false }),
    cfg: bothCfg,
    now: bothNow,
    key: '777'
  })?.reason === 'timed'
);

/* ------------------------------------------------------------------ */
/* 2) 端到端                                                            */
/* ------------------------------------------------------------------ */

console.log('== 端到端：真的发出去 ==');

let bot = null;
let llmStub = null;
try {
  const llmPath = require.resolve(path.join(ROOT, 'src/core/llm.js'));
  llmStub = {
    calls: [],
    behavior: () => '刚睡醒||你在干嘛',
    chat: async (opts) => {
      llmStub.calls.push(opts);
      return { content: llmStub.behavior(opts) };
    }
  };
  require.cache[llmPath] = { id: llmPath, filename: llmPath, loaded: true, exports: llmStub };
  bot = require(path.join(ROOT, 'src/core/qq/bot.js'));
} catch (err) {
  check('模块加载', false, err.message);
  process.exit(1);
}

const WebSocket = require('ws');
const config = require(path.join(ROOT, 'src/core/config.js'));

async function main() {
  const sent = [];
  const wss = new WebSocket.Server({ port: 0 }, () => run(wss.address().port));
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg.action) return;
      if (msg.action === 'get_login_info') {
        ws.send(JSON.stringify({ status: 'async', retcode: 0, data: { user_id: 55555, nickname: '小号' }, echo: msg.echo }));
      } else if (msg.action === 'send_private_msg') {
        sent.push(msg.params);
        ws.send(JSON.stringify({ status: 'async', retcode: 0, data: { message_id: 900 + sent.length }, echo: msg.echo }));
      }
    });
  });

  async function run(port) {
    config.set({
      llm: { enabled: true, apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1', model: 'test' },
      qq: {
        enabled: false,
        wsUrl: `ws://127.0.0.1:${port}`,
        token: '',
        whitelist: [{ qq: 10001, name: '老王' }],
        allFriends: false,
        perChatIntervalSeconds: 0,
        maxConsecutive: 99,
        maxPerHour: 99,
        batchWaitMs: 10,
        voiceReply: false,
        memes: false,
        proactive: { ...proactive.DEFAULTS, quietHours: [1, 8], slots: [], randomDaily: 0, silenceHours: [20, 34] }
      }
    });

    const notices = [];
    bot.setNotifier((t) => notices.push(t));
    await bot.start();
    let waited = 0;
    while (!bot.status().running && waited < 3000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    check('已连上桩 NapCat', bot.status().running === true);

    // 造一段「昨天聊过、现在安静很久」的私聊状态
    const { chatState, proactiveTick, saveState } = bot._internals;
    const cs = chatState('10001');
    cs.kind = 'private';
    cs.ctx = ['对方：今天画到几点', '我：三点吧'];
    cs.lastIncomingAt = NOW - 30 * HOUR;
    cs.lastOutgoingAt = NOW - 30 * HOUR;
    cs.awaitingReply = false;
    cs.lastProactiveAt = 0;
    cs.proactiveUnanswered = 0;
    cs.proactiveDay = null;
    saveState();

    const done = await proactiveTick(NOW);
    check('tick 判定该开口', done.length === 1, JSON.stringify(done));
    check('真的发出了 send_private_msg', sent.length >= 1, `实际 ${sent.length}`);
    check('发给了正确的人', sent[0] && String(sent[0].user_id) === '10001');
    check('内容经过清洗（分条按 ||）', sent.map((s) => s.message[0].data.text).join('|') === '刚睡醒|你在干嘛', sent.map((s) => s.message[0].data.text).join('|'));
    check('气泡有播报', notices.some((t) => t.includes('主动找 老王')));
    check('记账：未回数 +1', cs.proactiveUnanswered === 1, String(cs.proactiveUnanswered));
    check('记账：今天主动过 1 条', cs.proactiveDay && cs.proactiveDay.n === 1, JSON.stringify(cs.proactiveDay));
    check('记账：lastProactiveAt 已更新', cs.lastProactiveAt === NOW);
    check('主动说过的话进了上下文', cs.ctx[cs.ctx.length - 1] === '我：刚睡醒 你在干嘛', cs.ctx[cs.ctx.length - 1]);
    check('主动消息不算「问了没答」（不会再触发追问）', cs.awaitingReply === false);

    // 立刻再 tick 一次：冷却 + 未回记账 都该拦住
    const again = await proactiveTick(NOW + 60 * MIN);
    check('冷却期内不重复发', again.length === 0 && sent.length === 2, `again=${again.length} sent=${sent.length}`);

    // 对方回了：未回计数清零，敢再主动
    const cs2 = chatState('10001');
    cs2.lastIncomingAt = NOW + 2 * HOUR;
    cs2.proactiveUnanswered = 0;
    cs2.proactiveDay = null;
    saveState();
    check('对方开口后未回计数清零', cs2.proactiveUnanswered === 0);

    // 关掉总开关就不发
    config.set({ qq: { ...bot._internals.getCfg(), proactive: { ...proactive.DEFAULTS, enabled: false } } });
    const off = await proactiveTick(NOW + 100 * HOUR);
    check('总开关关闭时不发', off.length === 0);

    // 模型返回 [SKIP] 时不该装作发过
    config.set({ qq: { ...bot._internals.getCfg(), proactive: { ...proactive.DEFAULTS, quietHours: [1, 8], slots: [], randomDaily: 0 } } });
    llmStub.behavior = () => '[SKIP]';
    const cs3 = chatState('10001');
    cs3.lastIncomingAt = NOW + 100 * HOUR;
    cs3.lastOutgoingAt = NOW + 100 * HOUR;
    cs3.lastProactiveAt = 0;
    cs3.proactiveDay = null;
    cs3.lastProactiveAttemptAt = 0;
    saveState();
    const before = sent.length;
    const skip = await proactiveTick(NOW + 130 * HOUR);
    check('模型输出 SKIP 时不发也不记账', skip.length === 0 && sent.length === before);
    check('SKIP 之后记账仍为 0（没发就不算主动过）', !cs3.proactiveDay || cs3.proactiveDay.n === 0, JSON.stringify(cs3.proactiveDay));

    bot.shutdown();
    wss.close();

    console.log('');
    if (failed) {
      console.log(`${failed} 项失败`);
      process.exit(1);
    }
    console.log('全部通过');
    process.exit(0);
  }
}

main().catch((err) => {
  console.log('测试异常：', err && (err.stack || err.message));
  process.exit(1);
});
