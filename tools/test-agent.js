'use strict';

/**
 * 脱离窗口验证核心链路：
 *   1) 所有主进程模块能否正常 require（抓 MODULE_NOT_FOUND / 语法问题）
 *   2) agent.handle() 的完整问答链路（本地规则 + LLM function calling）
 *
 * 用法：
 *   node tools/test-agent.js                 # 只做模块加载检查
 *   node tools/test-agent.js --check         # 离线断言自检（无网络、无副作用）
 *   node tools/test-agent.js 现在几点了 你好    # 依次跑几句
 */

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');
const REMINDERS_FILE = path.join(ROOT, '.data', 'reminders.json');
const fs = require('fs');
const os = require('os');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};

const MODULES = [
  'src/core/config.js',
  'src/core/debug.js',
  'src/core/llm.js',
  'src/core/agent.js',
  'src/core/tools/index.js',
  'src/main/windows.js',
  'src/main/wander.js',
  'src/main/tray.js',
  'src/main/shortcuts.js'
];

let failed = 0;
for (const rel of MODULES) {
  try {
    require(path.join(ROOT, rel));
    console.log(`  ok   ${rel}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${rel} -> ${err.message}`);
  }
}

if (failed) {
  console.log(`\n${failed} 个模块加载失败`);
  process.exit(1);
}

const isCheck = process.argv.includes('--check');
// --check 不是要发给桌宠的句子，必须从待测句子里过滤掉
const prompts = process.argv.slice(2).filter((a) => a !== '--check');
if (!prompts.length && !isCheck) {
  console.log('\n模块全部加载正常。传入句子可测试对话链路，例如：');
  console.log('  node tools/test-agent.js "现在几点了"');
  process.exit(0);
}

const agent = require(path.join(ROOT, 'src/core/agent.js'));

// --check 与句子测试的调度放在文件末尾：--check 用到的 RULE_CASES / 计数器
// 是 const/let 声明，提前调用会踩 TDZ（ReferenceError: Cannot access before initialization）

/* -------------------- --check 离线断言 -------------------- */

const RULE_CASES = [
  ['现在几点了', 'get_time', {}],
  ['今天几号', 'get_time', {}],
  ['打开高德地图', 'open_app', { app_name: '高德地图' }],
  ['打开小画家', 'open_app', { app_name: '小画家' }],
  ['打开高级系统设置', 'open_app', { app_name: '高级系统设置' }],
  ['打开网易云音乐', 'open_app', { app_name: '网易云音乐' }],
  ['打开网易云音乐，我想听周杰伦', 'open_app', { app_name: '网易云音乐' }],
  ['开一下计算器', 'open_app', { app_name: '计算器' }],
  ['播放下一首', 'media_control', { action: 'next' }],
  ['下一首', 'media_control', { action: 'next' }],
  ['上一首', 'media_control', { action: 'prev' }],
  ['暂停', 'media_control', { action: 'toggle' }],
  ['暂停一下', 'media_control', { action: 'toggle' }],
  ['放歌', 'media_control', { action: 'toggle' }],
  ['停止播放', 'media_control', { action: 'stop' }],
  ['静音', 'media_control', { action: 'mute' }],
  ['声音大一点', 'media_control', { action: 'volume_up' }],
  ['把音量调大', 'media_control', { action: 'volume_up' }],
  ['调大音量', 'media_control', { action: 'volume_up' }],
  ['调高音量', 'media_control', { action: 'volume_up' }],
  ['声音小一点', 'media_control', { action: 'volume_down' }],
  ['把音量调小', 'media_control', { action: 'volume_down' }],
  ['把字体调大', null, null],
  ['截图', 'take_screenshot', {}],
  ['锁屏', 'lock_screen', {}],
  ['搜索 显卡驱动怎么更新', 'web_search', { query: '显卡驱动怎么更新' }],
  // 只说了命令词、没有查询内容 → 不该命中（曾经会被正则回溯拆成 搜 + 索）
  ['搜索', null, null],
  ['搜一下', null, null],
  ['查一下', null, null],
  ['查查', null, null],
  ['百度一下', null, null],
  // 关键词后面跟「一下」再跟内容 → 查询词不该带上半截关键词
  ['搜索天气', 'web_search', { query: '天气' }],
  ['搜索一下天气', 'web_search', { query: '天气' }],
  ['查一下天气', 'web_search', { query: '天气' }],
  ['百度一下天气', 'web_search', { query: '天气' }],
  ['网易云', 'open_app', { app_name: '网易云' }],
  ['我的提醒', 'list_reminders', {}],
  ['取消提醒 喝水', 'cancel_reminder', { text: '喝水' }],
  ['清空所有提醒', 'cancel_reminder', { all: true }],
  ['回复老王说明天开会改到三点', 'wechat_draft', { target: '老王', content: '明天开会改到三点' }]
];

let passCount = 0;
let failCount = 0;

function ok(name) {
  passCount += 1;
  console.log(`  ok   ${name}`);
}

function fail(name, detail) {
  failCount += 1;
  console.log(`  FAIL ${name} -> ${detail}`);
}

function check(name, cond, detail) {
  if (cond) ok(name);
  else fail(name, detail);
}

function argsMatch(actual, expectedSubset) {
  for (const [k, v] of Object.entries(expectedSubset)) {
    if (actual[k] !== v) return false;
  }
  return true;
}

async function throwsAsync(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

async function runChecks() {
  const tools = require(path.join(ROOT, 'src/core/tools/index.js'));
  const reminder = require(path.join(ROOT, 'src/core/tools/reminder.js'));
  const config = require(path.join(ROOT, 'src/core/config.js'));
  const llm = require(path.join(ROOT, 'src/core/llm.js'));

  const reminderSnapshot = fs.existsSync(REMINDERS_FILE)
    ? fs.readFileSync(REMINDERS_FILE, 'utf8')
    : null;

  try {
    /* ---- 第 1 组：规则路由 ---- */
    console.log('\n[1] 规则路由');
    for (const [input, tool, args] of RULE_CASES) {
      const m = agent.matchLocal(input);
      if (tool === null) {
        check(`matchLocal(${JSON.stringify(input)}) = null`, m === null, m ? `命中了 ${m.tool}` : '');
      } else {
        check(
          `matchLocal(${JSON.stringify(input)}) -> ${tool}`,
          m && m.tool === tool && argsMatch(m.args, args),
          m ? `got ${m.tool} ${JSON.stringify(m.args)}` : 'no match'
        );
      }
    }

    /* ---- 第 2 组：parseWhen ---- */
    console.log('\n[2] parseWhen');
    const base = new Date();
    const d2 = agent.parseWhen('后天上午十点');
    const expect2 = new Date(base);
    expect2.setDate(expect2.getDate() + 2);
    check(
      'parseWhen(后天上午十点) 日期=今天+2 10:00',
      d2 && d2.getDate() === expect2.getDate() && d2.getMonth() === expect2.getMonth() && d2.getHours() === 10 && d2.getMinutes() === 0,
      d2 ? String(d2) : 'null'
    );
    const d1 = agent.parseWhen('明天下午三点半');
    const expect1 = new Date(base);
    expect1.setDate(expect1.getDate() + 1);
    check(
      'parseWhen(明天下午三点半) = 今天+1 15:30',
      d1 && d1.getDate() === expect1.getDate() && d1.getHours() === 15 && d1.getMinutes() === 30,
      d1 ? String(d1) : 'null'
    );
    const rel = agent.parseWhen('10分钟后');
    check(
      'parseWhen(10分钟后) ≈ now+10min (±5s)',
      rel && Math.abs(rel.getTime() - (Date.now() + 10 * 60000)) < 5000,
      rel ? String(rel) : 'null'
    );

    /* ---- 第 3 组：提醒参数 ---- */
    console.log('\n[3] 提醒参数');
    const r1 = agent.matchLocal('10分钟后提醒我喝水');
    check(
      '10分钟后提醒我喝水 args.at ≈ now+10min',
      r1 && r1.tool === 'set_reminder' && Math.abs(new Date(r1.args.at).getTime() - (Date.now() + 10 * 60000)) < 5000,
      r1 ? JSON.stringify(r1.args) : 'no match'
    );
    const r2 = agent.matchLocal('明天下午三点提醒我交报告');
    const at2 = r2 ? new Date(r2.args.at) : null;
    const exp2 = new Date(base);
    exp2.setDate(exp2.getDate() + 1);
    check(
      '明天下午三点提醒我交报告 args.at = 明天 15:00',
      at2 && at2.getDate() === exp2.getDate() && at2.getHours() === 15 && at2.getMinutes() === 0,
      r2 ? JSON.stringify(r2.args) : 'no match'
    );

    /* ---- 第 4 组：LLM 路径回归（ISO 时间不被 parseWhen 覆盖） ---- */
    console.log('\n[4] LLM 路径回归（打桩，不联网）');
    const origGet = config.get;
    const origGetLLM = config.getLLM;
    const origChat = llm.chat;
    const fakeLLM = { enabled: true, apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1', model: 'test' };
    let chatCalls = 0;
    config.get = function (keyPath, fallback) {
      if (keyPath === 'llm') return fakeLLM;
      return origGet.call(config, keyPath, fallback);
    };
    // agent.js 走的是 config.getLLM()，不打桩就会读到用户真实配置，自检也就不再是无副作用的
    config.getLLM = () => fakeLLM;
    llm.chat = async () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: {
                name: 'set_reminder',
                arguments: JSON.stringify({ text: '开会', at: '2030-12-31T15:00:00' })
              }
            }
          ]
        };
      }
      return { role: 'assistant', content: '定好了' };
    };

    try {
      agent.resetHistory();
      const res = await agent.handle('帮我把会议提醒定在 2030 年 12 月 31 日下午三点');
      const list = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
      const added = list.find((x) => x.text === '开会');
      const expectISO = new Date('2030-12-31T15:00:00').toISOString();
      check(
        '模型给的 ISO 日期不被覆盖（2030-12-31 仍是 2030-12-31）',
        added && added.at === expectISO,
        `res=${JSON.stringify(res.message)} at=${added && added.at} want=${expectISO}`
      );

      const errEmpty = await throwsAsync(() => tools.execute('cancel_reminder', {}));
      check('cancel_reminder 空参数抛错（防一句话清空全部）', !!errEmpty, 'no error');

      const rm = await tools.execute('cancel_reminder', { text: '开会' });
      const after = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
      check(
        'cancelByText(开会) 删掉刚加的提醒',
        rm.ok && !after.some((x) => x.text === '开会'),
        JSON.stringify(rm)
      );
      const errNoHit = await throwsAsync(() => Promise.resolve(reminder.cancelByText('不存在的提醒')));
      check('cancelByText 找不到时抛错', !!errNoHit, 'no error');
    } finally {
      config.get = origGet;
      config.getLLM = origGetLLM;
      llm.chat = origChat;
    }

    /* ---- 第 5 组：PowerShell 字符串转义 ---- */
    console.log('\n[5] PowerShell 转义');
    const apps = require(path.join(ROOT, 'src/core/tools/apps.js'));
    const hostile = "a';calc;'";
    const quoted = apps.psQuote(hostile);
    check(
      'psQuote 把单引号成对转义（应用名带 \' 不能逃出 PS 字符串）',
      quoted === "a'';calc;''" && !quoted.replace(/''/g, '').includes("'"),
      JSON.stringify(quoted)
    );

    /* ---- 第 6 组：开始菜单匹配优先级 ---- */
    console.log('\n[6] 开始菜单匹配');
    const menuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-startmenu-'));
    try {
      for (const n of ['微信.lnk', '腾讯会议.lnk', 'QQ.lnk', 'QQ音乐.lnk', 'Notepad.lnk']) {
        fs.writeFileSync(path.join(menuDir, n), '');
      }
      const expect = [
        ['QQ', 'QQ.lnk'],
        ['qq音乐', 'QQ音乐.lnk'],
        ['微信', '微信.lnk'],
        ['腾讯会议', '腾讯会议.lnk'],
        ['Notepad', 'Notepad.lnk'],
        ['会议', null], // 名字太短，不接受「包含」匹配
        ['记事本', null]
      ];
      for (const [name, want] of expect) {
        const got = apps.findByStartMenu(name, [menuDir]);
        check(
          `findByStartMenu(${JSON.stringify(name)}) -> ${want || 'null'}`,
          (want ? path.basename(got || '') === want : got === null),
          got ? path.basename(got) : 'null'
        );
      }
    } finally {
      fs.rmSync(menuDir, { recursive: true, force: true });
    }

    /* ---- 第 7 组：逾期提醒补发 ---- */
    console.log('\n[7] 逾期提醒补发');
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    fs.writeFileSync(
      REMINDERS_FILE,
      JSON.stringify(
        [
          { id: 'f1', text: '未来的事', at: new Date(now + 3600e3).toISOString(), createdAt: stamp },
          { id: 'm1', text: '刚错过的事', at: new Date(now - 3600e3).toISOString(), createdAt: stamp },
          { id: 'o1', text: '过期太久的事', at: new Date(now - 48 * 3600e3).toISOString(), createdAt: stamp }
        ],
        null,
        2
      ),
      'utf8'
    );

    const fired = [];
    const aliveAfterInit = reminder.init((item) => fired.push(item));

    check(
      '逾期 1h 的补发一次，并带「已经过了时间」标记',
      fired.length === 1 && fired[0].missed === true && fired[0].text.includes('已经过了时间'),
      JSON.stringify(fired)
    );
    check(
      '逾期 48h 的不补发（直接丢弃）',
      !fired.some((x) => x.text.includes('过期太久')),
      JSON.stringify(fired.map((x) => x.text))
    );
    check(
      '未来的提醒仍留在待办里',
      aliveAfterInit.length === 1 && aliveAfterInit[0].id === 'f1',
      JSON.stringify(aliveAfterInit.map((x) => x.id))
    );
    const afterInit = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
    check(
      '补发过的从存储里清掉（下次启动不会重复补发）',
      afterInit.length === 1 && afterInit[0].id === 'f1',
      JSON.stringify(afterInit.map((x) => x.id))
    );
    // init() 给未来那条排了定时器，清掉免得进程挂住（文件随后由外层 finally 还原）
    reminder.clearAll();

    /* ---- 第 8 组：问回去 + 网址白名单 ---- */
    console.log('\n[8] 问回去 / 网址白名单');
    const askContent = await agent.handle('10分钟后提醒我');
    check(
      '「10分钟后提醒我」回问内容，不塞占位文字',
      askContent.type === 'text' && askContent.message.includes('要提醒什么'),
      JSON.stringify(askContent)
    );
    const askTime = await agent.handle('提醒我喝水');
    check(
      '「提醒我喝水」回问时间',
      askTime.type === 'text' && askTime.message.includes('什么时候'),
      JSON.stringify(askTime)
    );
    const badUrl = await throwsAsync(() =>
      tools.execute('open_url', { url: 'file:///C:/Windows/System32/calc.exe' })
    );
    check('open_url 拒绝非 http(s) 协议', !!badUrl, 'no error');
    const goodUrl = await tools.execute('open_url', { url: 'https://example.com' });
    check('open_url 放行 https', goodUrl && goodUrl.ok === true, JSON.stringify(goodUrl));
  } finally {
    // 无论成败都还原提醒队列
    if (reminderSnapshot == null) {
      if (fs.existsSync(REMINDERS_FILE)) fs.unlinkSync(REMINDERS_FILE);
    } else {
      fs.writeFileSync(REMINDERS_FILE, reminderSnapshot, 'utf8');
    }
  }

  console.log(`\n自检结果：${passCount} 通过 / ${failCount} 失败`);
  if (failCount) process.exit(1);
}

/* -------------------- 调度（必须放在所有声明之后）-------------------- */

// --check：离线断言，不碰网络、不写盘（除了临时增删一条提醒，最后还原）
if (isCheck) {
  runChecks().catch((err) => {
    console.error('\n自检异常：', err);
    process.exit(1);
  });
} else if (prompts.length) {
  (async () => {
    console.log(`\nLLM 就绪：${agent.llmReady()}`);
    for (const text of prompts) {
      const t0 = Date.now();
      const res = await agent.handle(text);
      const ms = Date.now() - t0;
      console.log(`\n> ${text}   (${ms}ms)`);
      console.log(`  type: ${res.type}`);
      console.log(`  message: ${res.message}`);
      if (res.tool) console.log(`  tool: ${res.tool}`);
    }
  })();
}
