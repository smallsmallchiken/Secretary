'use strict';

/**
 * 调 QQ 回复人设的命令行工具（不连 QQ、不发任何消息）。
 *
 * 用法：
 *   node tools/try-persona.js "今天好累啊"
 *   node tools/try-persona.js              # 进入交互模式，逐句输入
 *   node tools/try-persona.js "在吗" --ctx "对方：早\n我：早啊"
 */

const readline = require('readline');
const path = require('path');
// 挂 electron 桩（config.js 在非 Electron 环境跑需要）
const Module = require('module');
const STUB = path.join(__dirname, 'electron-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};
const config = require('../src/core/config');
const llm = require('../src/core/llm');
const { _internals } = require('../src/core/qq/bot');
const { cleanReply, buildSystemPrompt, PERSONA_DEFAULT } = _internals;

const args = process.argv.slice(2);
let personaArg = null;
const pFlag = args.indexOf('--persona');
if (pFlag >= 0) {
  personaArg = args[pFlag + 1] || '';
  args.splice(pFlag, 2);
}
const ctxFlag = args.indexOf('--ctx');
let ctxLines = [];
if (ctxFlag >= 0) {
  ctxLines = String(args[ctxFlag + 1] || '').split('\\n').filter(Boolean);
  args.splice(ctxFlag, 2);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function reply(incoming) {
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.apiKey) {
    console.log('✗ 没配置模型（.data/config.json 的 llm 段）');
    process.exit(1);
  }
  const user = [];
  if (ctxLines.length) user.push('最近的聊天记录：\n' + ctxLines.join('\n'));
  user.push(`对方刚发来的消息：${incoming}\n\n请直接给出要回复的那句话。`);

  const t0 = Date.now();
  const msg = await llm.chat({
    messages: [
      { role: 'system', content: buildSystemPrompt(personaArg) },
      { role: 'user', content: user.join('\n\n') }
    ],
    config: llmCfg,
    allowTools: false,
    temperature: 1.0
  });
  const out = cleanReply(msg.content);
  console.log(`（${Date.now() - t0}ms）我会回 > ${out === null ? '[SKIP]' : out}`);
}

(async () => {
  if (args.length) {
    await reply(args.join(' '));
    process.exit(0);
  }
  console.log('调人设模式：输入对方的话，回车看回复，Ctrl+C 退出');
  for (;;) {
    const incoming = (await ask('对方说 > ')).trim();
    if (!incoming) continue;
    try {
      await reply(incoming);
    } catch (err) {
      console.log('✗', err.message);
    }
  }
})();
