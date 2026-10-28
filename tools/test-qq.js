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
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');

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
try {
  // 先把 llm 换成桩：测试里不真调模型 API
  const llmPath = require.resolve(path.join(ROOT, 'src/core/llm.js'));
  require.cache[llmPath] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    exports: {
      chat: async () => ({ content: '“好嘞，我看看。”' })
    }
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

const cfgStub = { whitelist: [{ qq: 10001, name: '老王' }] };
check('白名单命中', _internals.matchWhitelist(cfgStub, { user_id: 10001 }) === '老王');
check('白名单未命中', _internals.matchWhitelist(cfgStub, { user_id: 99999 }) === null);

/* ------------------------------------------------------------------ */
/* 3) 桩 NapCat 端到端                                                   */
/* ------------------------------------------------------------------ */

console.log('== 桩 NapCat 端到端 ==');

// 备份并清空 qq 相关持久化，测试不污染真实状态
const DATA_DIR = path.join(ROOT, '.data');
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
          perChatIntervalSeconds: 0,
          maxConsecutive: 99,
          maxPerHour: 99,
          dedupeWindowSeconds: 60
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

      bot.shutdown();
      wss.close();
    } finally {
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
