'use strict';

/**
 * 电源闸门测试：证明「默认状态下绝对不会关机」。
 *
 * 这个测试最怕的是它自己把关机跑了。所以第一件事就是把 child_process.spawn 换成
 * 假函数——即使闸门以后被谁改坏，这里最多记录到一次 spawn 调用，机器不会黑。
 * 这也是唯一允许「测关机」的形式：只验参数，不执行。
 *
 * 验三件事：
 *   1) 默认 power.allow=false 时，shutdown/restart/sleep 都在 spawn 之前抛错
 *   2) 打开开关后确实会 spawn（argv 正确），但用的是假 spawn，仍然不执行
 *   3) 模型那侧的工具表里根本没有电源工具（LLM 不可能自己关机）
 *
 * 服务端（手机页面那一侧）的边界在 tools/test-desk.js。
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

// 必须在 require system.js 之前换掉：它在顶层就 `const { spawn } = require('child_process')`
const cp = require('child_process');
const calls = [];
cp.spawn = function (file, args) {
  calls.push([path.basename(String(file)), args || []]);
  const handlers = {};
  const proc = {
    on(ev, fn) {
      (handlers[ev] = handlers[ev] || []).push(fn);
      return proc;
    },
    once(ev, fn) {
      return proc.on(ev, fn);
    },
    unref() {},
    kill() {},
    stdout: null,
    stderr: null
  };
  // 补一个 close(0)：system.run('cancel') 是 await 子进程退出的，
  // 假 spawn 不触发的话那条 await 会永远挂着，测试直接卡死
  setImmediate(() => (handlers.close || []).forEach((fn) => fn(0)));
  return proc;
};

const system = require(path.join(ROOT, 'src/core/tools/system.js'));
const config = require(path.join(ROOT, 'src/core/config.js'));
const tools = require(path.join(ROOT, 'src/core/tools/index.js'));

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`);
  }
}

async function rejectOf(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/* ------------------------------ 1. 默认关闭 ------------------------------ */

async function testClosed() {
  console.log('[1] 默认配置：电源操作一律拒绝');
  const allow = (config.get('power', {}) || {}).allow;
  check('config 里 power.allow 不是 true', allow !== true, `实际 ${JSON.stringify(allow)}`);
  check('system.powerAllowed() 返回 false', system.powerAllowed() === false);

  for (const cmd of ['shutdown', 'restart', 'sleep']) {
    const before = calls.length;
    const err = await rejectOf(() => system.run(cmd));
    check(`${cmd} 抛错`, !!err, '居然没抛错，闸门失效了');
    check(`${cmd} 报「禁用」而不是别的`, !!(err && /禁用/.test(err.message)), err && err.message);
    check(`${cmd} 没触到 spawn`, calls.length === before, `多调用 ${calls.length - before} 次`);
  }

  // cancel 是安全方向（取消关机），不设闸；它走的是假 spawn，不会真执行
  const cErr = await rejectOf(() => system.run('cancel'));
  check('cancel 不被闸门拦', !cErr, cErr && cErr.message);
}

/* ------------------------------ 2. 打开开关 ------------------------------ */

async function testOpen() {
  console.log('\n[2] power.allow=true 时才放行（假 spawn 只验参数）');
  const realGet = config.get;
  config.get = function (key, dflt) {
    if (key === 'power') return { allow: true };
    return realGet.call(this, key, dflt);
  };
  try {
    calls.length = 0;
    const r = await system.run('shutdown', { delay: 15 });
    check('shutdown 返回 ok', r && r.ok === true, JSON.stringify(r));
    check('真的调了 shutdown.exe', calls.length === 1 && calls[0][0] === 'shutdown.exe', JSON.stringify(calls));
    check(
      '参数是 /s /t 15',
      calls[0] && calls[0][1][0] === '/s' && calls[0][1][1] === '/t' && calls[0][1][2] === '15',
      JSON.stringify(calls[0] && calls[0][1])
    );

    calls.length = 0;
    await system.run('restart');
    check('restart 走 /r', calls[0] && calls[0][1][0] === '/r', JSON.stringify(calls[0] && calls[0][1]));

    calls.length = 0;
    await system.run('sleep');
    check('sleep 走 rundll32', calls[0] && calls[0][0] === 'rundll32.exe', JSON.stringify(calls[0]));
  } finally {
    config.get = realGet;
  }

  check('开关一关立刻恢复拒绝', system.powerAllowed() === false);
}

/* ------------------------------ 3. 模型那侧 ------------------------------ */

function testTools() {
  console.log('\n[3] 模型工具表里没有电源工具');
  const names = tools.TOOLS.map((t) => t.name);
  for (const bad of ['shutdown', 'restart', 'sleep', 'power_off']) {
    check(`没有 ${bad} 工具`, !names.includes(bad), names.join(','));
  }
  check('有 lock_screen（锁屏不丢数据）', names.includes('lock_screen'));

  // 描述里提到「关机」会诱导模型去尝试走别的路径，检查一遍文案
  const descs = tools.TOOLS.map((t) => `${t.name} ${t.label || ''} ${t.description || ''}`);
  check('没有工具的文案在撩「关机/重启」', !descs.some((d) => /关机|重启/.test(d)));
}

/* ------------------------------ run ------------------------------ */

(async () => {
  await testClosed();
  await testOpen();
  await testTools();
  console.log(`\n电源闸门：${pass} 通过，${fail} 失败`);
  if (calls.length) console.log('（假 spawn 记录：' + JSON.stringify(calls) + '）');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
