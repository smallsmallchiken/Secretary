'use strict';

/**
 * 脱离窗口验证核心链路：
 *   1) 所有主进程模块能否正常 require（抓 MODULE_NOT_FOUND / 语法问题）
 *   2) agent.handle() 的完整问答链路（本地规则 + LLM function calling）
 *
 * 用法：
 *   node tools/test-agent.js                 # 只做模块加载检查
 *   node tools/test-agent.js 现在几点了 你好    # 依次跑几句
 */

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');

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

const prompts = process.argv.slice(2);
if (!prompts.length) {
  console.log('\n模块全部加载正常。传入句子可测试对话链路，例如：');
  console.log('  node tools/test-agent.js "现在几点了"');
  process.exit(0);
}

const agent = require(path.join(ROOT, 'src/core/agent.js'));

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
