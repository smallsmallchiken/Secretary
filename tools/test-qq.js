'use strict';

/**
 * QQ 自动回复链路自测（不启动窗口、不连真 NapCat）：
 *   1) 模块加载
 *   2) cleanReply / normalize / matchWhitelist 纯函数
 *   3) 起一个桩 NapCat（本地 WS server），验证：
 *      白名单外忽略 / 白名单内生成并回发 / 同 message_id 不重复 / 间隔护栏
 *
 * 用法：node tools/test-qq.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');

// 数据目录整体指到临时目录：配置 / 状态 / 日志 / 表情库都不会写到线上 .data。
// 之前直接改真实 config.json，正在值守的机器人会立刻读到测试用的假 baseUrl 而回复全挂。
process.env.PET_DATA_DIR = path.join(os.tmpdir(), `secretary-qq-test-${process.pid}`);
fs.rmSync(process.env.PET_DATA_DIR, { recursive: true, force: true });

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* 1) 模块加载                                                          */
/* ------------------------------------------------------------------ */

console.log('== 模块加载 ==');
let client, bot;
try {
  client = require(path.join(ROOT, 'src/core/qq/client.js'));
  check('qq/client.js 加载', true);
} catch (err) {
  check('qq/client.js 加载', false, err.message);
}
let llmStub;
try {
  // 先把 llm 换成桩：测试里不真调模型 API。behavior 可按入参返回不同内容
  const llmPath = require.resolve(path.join(ROOT, 'src/core/llm.js'));
  llmStub = {
    behavior: () => '“好嘞，我看看。”',
    calls: []
  };
  llmStub.chat = async (opts) => {
    llmStub.calls.push(opts);
    return { content: llmStub.behavior(opts) };
  };
  require.cache[llmPath] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    exports: llmStub
  };
  bot = require(path.join(ROOT, 'src/core/qq/bot.js'));
  check('qq/bot.js 加载', true);
} catch (err) {
  check('qq/bot.js 加载', false, err.message);
}

if (!client || !bot) {
  console.log('\n模块加载失败，后续用例跳过');
  process.exit(1);
}

const { _internals } = bot;

/* ------------------------------------------------------------------ */
/* 2) 纯函数                                                            */
/* ------------------------------------------------------------------ */

console.log('== 纯函数 ==');
check('cleanReply 剥引号', _internals.cleanReply('“好嘞，我看看。”') === '好嘞，我看看。');
check('cleanReply 剥前缀', _internals.cleanReply('回复：好的') === '好的');
check('cleanReply SKIP 拒回', _internals.cleanReply('[SKIP]') === null);
check('cleanReply 空串拒回', _internals.cleanReply('   ') === null);
check('cleanReply 截断 120', _internals.cleanReply('啊'.repeat(300)).length <= 120);
check('cleanReply 只取第一行', _internals.cleanReply('第一句\n第二句') === '第一句');
check('normalize 去标点空白', _internals.normalize('好 的，没！问题~') === '好的没问题');
check('cleanReply 剥配图标记', _internals.cleanReply('哈哈 [图:meme-1.png]') === '哈哈');
check('cleanReply 纯配图标记为空', _internals.cleanReply('[图:meme-1.png]') === null);

const cfgStub = { whitelist: [{ qq: 10001, name: '老王' }] };
check('白名单命中', _internals.matchWhitelist(cfgStub, { user_id: 10001 }) === '老王');
check('白名单未命中', _internals.matchWhitelist(cfgStub, { user_id: 99999 }) === null);

/* ------------------------------------------------------------------ */
/* 3) 桩 NapCat 端到端                                                   */
/* ------------------------------------------------------------------ */

console.log('== 桩 NapCat 端到端 ==');

// 全流程都在临时数据目录里跑（见文件头的 PET_DATA_DIR），不会污染真实状态
const DATA_DIR = process.env.PET_DATA_DIR;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'qq-state.json');
const configBackup = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
const stateBackup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : null;
if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

// 测试配置：白名单只有 10001，间隔 0 方便连发断言；llm 已在模块层打桩
const WebSocket = require('ws');
const http = require('http');

async function main() {
  // 桩 NapCat：WS server + 最小 OpenAI 兼容接口（不需要，llm 已打桩）
  const received = []; // 收到的 { action, params }
  let replyCount = 0;
  let groupCount = 0;

  const wss = new WebSocket.Server({ port: 0 }, () => {
    const port = wss.address().port;
    run(port);
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.action) {
        received.push(msg);
        if (msg.action === 'get_login_info') {
          ws.send(JSON.stringify({ status: 'async', retcode: 0, data: { user_id: 55555, nickname: '小号' }, echo: msg.echo }));
        } else if (msg.action === 'send_private_msg') {
          replyCount++;
          ws.send(JSON.stringify({ status: 'async', retcode: 0, data: { message_id: 777 }, echo: msg.echo }));
        } else if (msg.action === 'send_group_msg') {
          groupCount++;
          ws.send(JSON.stringify({ status: 'async', retcode: 0, data: { message_id: 778 }, echo: msg.echo }));
        }
        return;
      }
      if (msg.post_type) {
        // 桩里收到的是事件？不该发生（桌宠只上行 API），记录即视为异常
        received.push({ action: '__unexpected_event__' });
      }
    });
  });

  async function pushEvent(ws, ev) {
    ws.send(JSON.stringify(ev));
    // 给主进程事件循环一点处理时间
    await new Promise((r) => setTimeout(r, 250));
  }

  async function run(port) {
    try {
      // 状态隔离：把配置直接写进 config（避免动真实 config.json 的其他段）
      const config = require(path.join(ROOT, 'src/core/config.js'));
      config.set({
        llm: { enabled: true, apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1', model: 'test' },
        qq: {
          enabled: false,
          wsUrl: `ws://127.0.0.1:${port}`,
          token: '',
          whitelist: [{ qq: 10001, name: '老王' }],
          // 必须显式关掉：真实配置里 allFriends 可能为 true，会把「白名单外不回」的用例带偏
          allFriends: false,
          perChatIntervalSeconds: 0,
          maxConsecutive: 99,
          maxPerHour: 99,
          dedupeWindowSeconds: 60,
          batchWaitMs: 10,
          voiceReply: false
        }
      });

      const notices = [];
      bot.setNotifier((t) => notices.push(t));

      // start() 需要 NapCat 在听
      await bot.start();
      const st = bot.status();
      check('启动后 enabled=true', st.enabled === true);
      check('白名单人数', st.whitelistCount === 1);

      // 等 WS 连上并拿到登录信息
      let waited = 0;
      while (!st.running && waited < 3000) {
        await new Promise((r) => setTimeout(r, 100));
        waited += 100;
      }
      check('已连上桩 NapCat', bot.status().running === true);
      await new Promise((r) => setTimeout(r, 300)); // 等 get_login_info 往返
      check('登录号已识别', bot.status().selfId === 55555);

      // 取到桌宠侧的 ws 连接（桩只接了一个 client）
      const petWs = [...wss.clients][0];

      // 用例 A：白名单外 -> 不回
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        user_id: 99999, message_id: 1, message: [{ type: 'text', data: { text: '在吗' } }]
      });
      check('白名单外不回复', replyCount === 0);

      // 用例 B：群聊消息 -> 不回
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'group', sub_type: 'normal',
        user_id: 10001, group_id: 888, message_id: 2,
        message: [{ type: 'text', data: { text: '群里说话' } }]
      });
      check('群聊不回复', replyCount === 0);

      // 用例 C：临时会话（非 friend）-> 不回
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'private', sub_type: 'group',
        user_id: 10001, message_id: 3, message: [{ type: 'text', data: { text: '临时会话' } }]
      });
      check('临时会话不回复', replyCount === 0);

      // 用例 D：白名单内好友私聊 -> 生成并回发（llm 桩返回固定文案）
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        user_id: 10001, message_id: 100, message: [{ type: 'text', data: { text: '帮我看看那个文件' } }]
      });
      check('白名单内自动回复', replyCount === 1, `实际 ${replyCount}`);
      const sent = received.find((r) => r.action === 'send_private_msg');
      check('发给正确的 QQ 号', sent && String(sent.params.user_id) === '10001');
      check(
        '回复内容经过清洗（去引号）',
        sent && sent.params.message[0].data.text === '好嘞，我看看。',
        sent && sent.params.message[0].data.text
      );
      check('气泡有播报', notices.some((t) => t.includes('已替你回复 老王')));

      // 用例 E：同 message_id 重复上报 -> 不重复回
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        user_id: 10001, message_id: 100, message: [{ type: 'text', data: { text: '帮我看看那个文件' } }]
      });
      check('同一条消息不重复回', replyCount === 1, `实际 ${replyCount}`);

      // 用例 F：图片消息（无文本）-> 不猜不回
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        user_id: 10001, message_id: 101, message: [{ type: 'image', data: { file: 'x.png' } }]
      });
      check('纯图片不回复', replyCount === 1, `实际 ${replyCount}`);

      // 用例 G：间隔护栏（把间隔调大后应被拦）
      config.set({ qq: { perChatIntervalSeconds: 30 } });
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        user_id: 10001, message_id: 102, message: [{ type: 'text', data: { text: '又来了' } }]
      });
      check('间隔护栏拦截', replyCount === 1, `实际 ${replyCount}`);
      config.set({ qq: { perChatIntervalSeconds: 0 } });

      // 用例 H：连发两条 → 攒批后只回一次（llm 桩固定文案会撞去重，先关掉）
      config.set({ qq: { dedupeWindowSeconds: 0 } });
      petWs.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        user_id: 10001, message_id: 200, message: [{ type: 'text', data: { text: '跟你说个事' } }]
      }));
      petWs.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        user_id: 10001, message_id: 201, message: [{ type: 'text', data: { text: '算了没事了' } }]
      }));
      await new Promise((r) => setTimeout(r, 1200)); // 等 batchWaitMs(10ms) + 生成
      check('连发两条只回一次（攒批）', replyCount === 2, `实际 ${replyCount}`);

      // 用例 I：白名单群 → send_group_msg 回复
      config.set({ qq: { whitelist: [{ qq: 10001, name: '老王' }, { group: 888, name: '测试群' }] } });
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'group', sub_type: 'normal',
        user_id: 10001, group_id: 888, message_id: 300,
        sender: { card: '小明', nickname: '小明' },
        message: [{ type: 'text', data: { text: '大家晚上吃什么' } }]
      });
      check('白名单群自动回复', groupCount === 1, `实际 ${groupCount}`);
      const gSent = received.find((r) => r.action === 'send_group_msg');
      check('群回复发给正确的群', gSent && String(gSent.params.group_id) === '888');

      // 用例 J：模型回配图标记 → 文字+图片段发出（表情包库测试）
      // 备份并清空表情库目录，造一张假表情包
      const MEMES_DIR = path.join(DATA_DIR, 'memes');
      const MEME_CATALOG = path.join(MEMES_DIR, 'catalog.json');
      const memesBackup = fs.existsSync(MEME_CATALOG) ? fs.readFileSync(MEME_CATALOG, 'utf8') : null;
      fs.rmSync(MEMES_DIR, { recursive: true, force: true });
      fs.mkdirSync(MEMES_DIR, { recursive: true });
      fs.writeFileSync(path.join(MEMES_DIR, 'meme-1.png'), Buffer.from('fakepngdata-'.repeat(300)));
      const cat = _internals.loadMemeCatalog();
      cat.seq = 1;
      cat.items = [{ name: 'meme-1.png', hash: 'x', desc: '无语时用', addedAt: Date.now() }];
      _internals.saveMemeCatalog();
      check('表情包清单可读', _internals.memeListText().includes('meme-1.png'));

      // llm 桩临时改成只回配图标记（纯图无文字）
      const origBehavior = llmStub.behavior;
      llmStub.behavior = () => '[图:meme-1.png]';
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        user_id: 10001, message_id: 400, message: [{ type: 'text', data: { text: '无语住了' } }]
      });
      const imgSent = received.filter((r) => r.action === 'send_private_msg').pop();
      check(
        '配图回复发出图片段',
        imgSent && imgSent.params.message.some((s) => s.type === 'image'),
        imgSent && JSON.stringify(imgSent.params.message)
      );
      check(
        '纯图回复不带空文字段',
        imgSent && imgSent.params.message.every((s) => s.type !== 'text' || (s.data.text || '').trim()),
        imgSent && JSON.stringify(imgSent.params.message)
      );
      llmStub.behavior = origBehavior; // 还原桩

      /* ---------------- 群聊记忆 / 不插嘴 / 昵称标签 / 调教演进 ---------------- */

      // 用例 K：群聊消息都进记忆（含机器人没回的），带说话人标签
      const gState = _internals.chatState('888');
      check('群消息写进记忆', Array.isArray(gState.memory) && gState.memory.length >= 1, JSON.stringify(gState.memory));
      check(
        '记忆带说话人标签',
        gState.memory.some((m) => m.who === '小明'),
        JSON.stringify(gState.memory.slice(-3))
      );
      check(
        '自己说过的话也进记忆',
        gState.memory.some((m) => m.who === '我'),
        JSON.stringify(gState.memory.slice(-3))
      );

      // 用例 L：别人互聊，模型输出 [SKIP] → 不插嘴，但记忆照样记
      llmStub.behavior = () => '[SKIP]';
      const beforeSkip = groupCount;
      const memLenBefore = _internals.chatState('888').memory.length;
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'group', sub_type: 'normal',
        user_id: 10002, group_id: 888, message_id: 500,
        sender: { card: '小红', nickname: '小红' },
        message: [{ type: 'text', data: { text: '你昨天几点睡的' } }]
      });
      check('互聊时不插嘴', groupCount === beforeSkip, `实际 ${groupCount}`);
      check(
        '没回的消息也进记忆',
        _internals.chatState('888').memory.length === memLenBefore + 1,
        `实际 ${_internals.chatState('888').memory.length}`
      );

      // 用例 M：群聊上下文用「[昵称] 内容」区分说话人，且明确告知标签只用于区分
      llmStub.behavior = () => '睡了睡了';
      llmStub.calls.length = 0;
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'group', sub_type: 'normal',
        user_id: 10003, group_id: 888, message_id: 501,
        sender: { card: '阿强', nickname: '阿强' },
        message: [{ type: 'text', data: { text: '那你们几点睡的' } }]
      });
      const genCall = llmStub.calls.find((c) => c.allowTools === false && c.temperature === 1.0);
      const genUser = genCall && (typeof genCall.messages[1].content === 'string' ? genCall.messages[1].content : '');
      const genSys = genCall && genCall.messages[0].content;
      check('上下文里有说话人标签', !!genUser && genUser.includes('[小红]') && genUser.includes('[阿强]'), genUser);
      check('提示词声明标签只用于区分', !!genSys && genSys.includes('只是说话人标签'), genSys && genSys.slice(0, 80));

      // 用例 N：调教是演进式的（把当前人设交给模型合并）
      llmStub.behavior = (opts) => {
        const sys = String((opts.messages[0] && opts.messages[0].content) || '');
        if (sys.includes('性格管理员')) {
          return '{"change": true, "persona": "傲娇小丫头但说话温柔，偶尔才骂人，被夸会脸红"}';
        }
        return '行吧 我温柔点';
      };
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        user_id: 10001, message_id: 600, message: [{ type: 'text', data: { text: '以后跟我说话温柔点' } }]
      });
      const newCfg = _internals.getCfg();
      check('调教后人设已更新', String(newCfg.persona || '').includes('温柔'), newCfg.persona);
      check('调教有记录', _internals.loadState().personaLog.length > 0, JSON.stringify(_internals.loadState().personaLog[0]));
      const personaLogText = JSON.stringify(_internals.loadState().personaLog[0] || {});
      check('调教记录带请求原文', personaLogText.includes('温柔'), personaLogText);

      // 用例 O：allFriends=true 时所有好友私聊都回（群聊仍按白名单）
      config.set({ qq: { allFriends: true } });
      llmStub.behavior = () => '行 我知道';
      const beforeAll = replyCount;
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        user_id: 99999, message_id: 700,
        sender: { nickname: '陌生好友' },
        message: [{ type: 'text', data: { text: '在吗兄弟' } }]
      });
      check('所有好友私聊都回', replyCount === beforeAll + 1, `实际 ${replyCount}`);
      const allSent = received.filter((r) => r.action === 'send_private_msg').pop();
      check('回给陌生好友', allSent && String(allSent.params.user_id) === '99999', allSent && String(allSent.params.user_id));
      // 群聊不受 allFriends 影响：非白名单群仍然不回
      const beforeGroup = groupCount;
      await pushEvent(petWs, {
        post_type: 'message', message_type: 'group', sub_type: 'normal',
        user_id: 10001, group_id: 999, message_id: 701,
        sender: { card: '路人' },
        message: [{ type: 'text', data: { text: '这个群也回吗' } }]
      });
      check('非白名单群仍然不回', groupCount === beforeGroup, `实际 ${groupCount}`);
      config.set({ qq: { allFriends: false } });

      bot.shutdown();
      wss.close();
    } finally {
      // 恢复表情库目录
      try {
        fs.rmSync(path.join(DATA_DIR, 'memes'), { recursive: true, force: true });
        if (memesBackup !== null) {
          fs.mkdirSync(path.join(DATA_DIR, 'memes'), { recursive: true });
          fs.writeFileSync(path.join(DATA_DIR, 'memes', 'catalog.json'), memesBackup, 'utf8');
        }
      } catch { /* ignore */ }
      // 恢复真实配置与状态
      if (configBackup !== null) fs.writeFileSync(CONFIG_FILE, configBackup, 'utf8');
      else if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
      if (stateBackup !== null) fs.writeFileSync(STATE_FILE, stateBackup, 'utf8');
      else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    }

    console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
