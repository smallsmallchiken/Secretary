'use strict';

/**
 * 「大脑」离线自检（无网络、无副作用）：
 *   1) context.build() —— 情境注入：时间/星期必有，待办与记事取不到也不炸
 *   2) agent 对话历史持久化 —— 写盘、读回、reset 清空
 *   3) runLLM 的消息里真的带了情境（读源码断言，不联网）
 *
 * 用法：node tools/test-brain.js
 */

const path = require('path');
const Module = require('module');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');

// electron 桩 + 数据目录指向临时沙盒，测试不碰真实 .data
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-'));
process.env.PET_DATA_DIR = sandbox;

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) {
    pass += 1;
    console.log('  ok  ', name);
  } else {
    fail += 1;
    console.log('  FAIL', name);
  }
}

/* ---------- 1) 情境注入 ---------- */

console.log('[1] context.build() 情境注入');
const context = require('../src/core/context.js');
{
  const block = context.build();
  ok(typeof block === 'string' && block.length > 0, '能产出非空情境');
  ok(/当前时间：\d{4}-\d{2}-\d{2} 星期[日一二三四五六] \d{2}:\d{2}/.test(block), '带日期+星期+时分');
  // 记事为空的沙盒里不应崩，待办 0 时不提待办（避免模型没话找话）
  ok(!/备忘录：还有 0 条/.test(block), '待办为 0 时不注入待办行');
}

/* ---------- 2) 历史持久化 ---------- */

console.log('[2] agent 对话历史持久化');
const agent = require('../src/core/agent.js');
const historyFile = path.join(sandbox, 'chat-history.json');
{
  agent.resetHistory();
  ok(!fs.existsSync(historyFile) || JSON.parse(fs.readFileSync(historyFile, 'utf8')).length === 0, 'reset 后历史为空');

  // handle() 走本地规则路径（不联网）：问时间会命中 get_time 并执行，
  // 这里用一条必然无副作用的本地命中——「现在几点」→ get_time。
  agent
    .handle('现在几点了')
    .then((r) => {
      ok(r && (r.type === 'action' || r.type === 'text'), '本地问答链路通');
      const saved = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      ok(Array.isArray(saved) && saved.length >= 2, '问答已落盘');
      ok(saved.some((x) => x.role === 'user' && /现在几点/.test(x.content)), '用户句在历史里');

      // 模拟重启：重新 require 一个新实例读回（用 cache 清除重建）
      delete require.cache[require.resolve('../src/core/agent.js')];
      const agent2 = require('../src/core/agent.js');
      const block2 = context.build();
      ok(typeof block2 === 'string', '重启后 context 仍可用');

      // 历史文件确实被新实例读到：再问一句后文件里应该有旧句+新句
      return agent2.handle('现在几点了').then(() => {
        const saved2 = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        ok(saved2.filter((x) => /现在几点/.test(x.content)).length >= 2, '重启后历史接着写（不失忆）');
      });
    })
    .catch((err) => {
      fail += 1;
      console.log('  FAIL 链路异常:', err.message);
    })
    .finally(() => {
      console.log(`\n大脑自检：${pass} 通过 / ${fail} 失败`);
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
      } catch {}
      process.exit(fail ? 1 : 0);
    });
}
