'use strict';

/**
 * 电源闸门测试：证明「默认状态下绝对不会关机」。
 *
 * 这个测试最怕的是它自己把关机跑了。所以第一件事就是把 child_process.spawn 换成
 * 假函数——即使闸门以后被谁改坏，这里最多记录到一次 spawn 调用，机器不会黑。
 * 这也是唯一允许「测关机」的形式：只验参数，不执行。
 *
 * 验四件事：
 *   1) 默认 power.allow=false 时，shutdown/restart/sleep 都在 spawn 之前抛错
 *   2) 抛错信息能看清是配置问题，不是别的原因
 *   3) 打开开关后确实会 spawn（且 argv 正确），但用的是假 spawn，仍然不执行
 *   4) 服务端（手机页面同源的那个）默认用 403 拒掉电源指令，非电源指令不受影响
 */

const path = require('path');
const Module = require('module');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};

// 必须在 require system.js 之前换掉：它在顶层就 `const { spawn } = require('child_process')`
const cp = require('child_process');
const realSpawn = cp.spawn;
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
  console.log('\n[1] 默认配置：电源操作一律拒绝');
  const allow = (config.get('power', {}) || {}).allow;
  check('config 里 power.allow 不是 true', allow !== true, `实际 ${JSON.stringify(allow)}`);
  check('system.powerAllowed() 返回 false', system.powerAllowed() === false);

  for (const cmd of ['shutdown', 'restart', 'sleep']) {
    const before = calls.length;
    const err = await rejectOf(() => system.run(cmd));
    check(`${cmd} 抛错`, !!err, '居然没抛错，闸门失效了');
    check(`${cmd} 报「禁用」而不是别的`, !!(err && /禁用/.test(err.message)), err && err.message);
    check(`${cmd} 没有触到 spawn`, calls.length === before, `多调用 ${calls.length - before} 次`);
  }

  // lock 不拦（锁屏不丢数据，还能自己解锁），但不在这里测——真锁屏会打断用户
  check('cancel 仍然允许（安全方向不设闸）', !/禁用/.test(String((await rejectOf(() => system.run('cancel'))) || '')));
}

/* ------------------------------ 2. 打开开关 ------------------------------ */

async function testOpen() {
  console.log('\n[2] power.allow=true 时才真的放行（用假 spawn 验参数）');
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

  calls.length = 0;
  check('开关关掉后立刻恢复拒绝', system.powerAllowed() === false);
}

/* ------------------------------ 3. 服务端 ------------------------------ */

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      const bufs = [];
      res.on('data', (b) => bufs.push(b));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(bufs).toString('utf8'));
        } catch {
          /* 静态资源不是 JSON */
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function postJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
      },
      (res) => {
        const bufs = [];
        res.on('data', (b) => bufs.push(b));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(bufs).toString('utf8'));
          } catch {
            /* 忽略 */
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function testServer() {
  console.log('\n[3] 服务端：没开 DESK_ALLOW_POWER 时电源指令 403');
  const port = 18700 + Math.floor(Math.random() * 200);
  const child = realSpawn(process.execPath, [path.join(ROOT, 'server', 'desk', 'server.js')], {
    env: {
      ...process.env,
      DESK_PORT: String(port),
      DESK_HOST: '127.0.0.1',
      DESK_TOKEN: 'test-token',
      DESK_AGENT_TOKEN: 'test-agent',
      DESK_SHEET: path.join(ROOT, 'pets', 'duodong', 'spritesheet.webp'),
      DESK_ALLOW_POWER: '' // 显式清空，避免从环境里继承到 1
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errbuf = '';
  child.stderr.on('data', (b) => (errbuf += b.toString()));

  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await getJson(port, '/healthz');
        if (r.status === 200) {
          up = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await sleepMs(100);
    }
    if (!up) {
      check('服务端起来了', false, errbuf.slice(0, 300) || '超时');
      return;
    }

    for (const cmd of ['shutdown', 'restart', 'sleep']) {
      const r = await postJson(port, '/api/cmd?t=test-token', { cmd });
      check(`${cmd} 被 403 拒绝`, r.status === 403, `HTTP ${r.status} ${JSON.stringify(r.json)}`);
      check(
        `${cmd} 错误码是 power-disabled`,
        !!(r.json && r.json.error === 'power-disabled'),
        JSON.stringify(r.json)
      );
    }

    const info = await getJson(port, '/api/state?t=test-token');
    check('state 里 power=false 让前端置灰按钮', !!(info.json && info.json.power === false), JSON.stringify(info.json && info.json.power));
    check('被拒的指令没有进队列', !!(info.json && info.json.pending === 0), JSON.stringify(info.json && info.json.pending));

    // 非电源指令不能被误伤
    const shot = await postJson(port, '/api/cmd?t=test-token', { cmd: 'shot' });
    check('shot 仍然放行', shot.status === 200 && shot.json && shot.json.ok === true, `HTTP ${shot.status}`);

    const bad = await postJson(port, '/api/cmd?t=wrong', { cmd: 'shutdown' });
    check('token 不对时 401（先拦 token 再谈别的）', bad.status === 401, `HTTP ${bad.status}`);
  } finally {
    child.kill();
    await sleepMs(200);
  }
}

/* ------------------------------ run ------------------------------ */

(async () => {
  await testClosed();
  await testOpen();
  await testServer();
  console.log(`\n电源闸门：${pass} 通过，${fail} 失败`);
  if (calls.length) console.log('（假 spawn 记录：' + JSON.stringify(calls) + '）');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
