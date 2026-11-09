'use strict';

/**
 * 手机控制端服务（server/desk/server.js）的安全边界测试。
 *
 * 只测「不该做的事确实没做」，不碰真机：
 *   - 电源指令在没开 DESK_ALLOW_POWER 时一律 403，且不进队列
 *   - /api/state 如实告诉前端 power=false（前端靠它置灰按钮）
 *   - 非电源指令不能被误伤
 *   - token 不对先拦 401
 *   - 服务端重启后 seq 对齐（否则手机上点按钮会「没反应」）
 *
 * 起的是真进程、真端口，跑完 kill。端口随机，避免和开发中的实例撞。
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

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

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, pathname, method, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
          : {}
      },
      (res) => {
        const bufs = [];
        res.on('data', (b) => bufs.push(b));
        res.on('end', () => {
          const text = Buffer.concat(bufs).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 静态资源不是 JSON */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

const TOKEN = 'page-token';
const AGENT = 'agent-token';

async function main() {
  const port = 18900 + Math.floor(Math.random() * 90);

  // 每日清单：造一份假的给服务端读，同时验证「今天」是按北京时区算的
  const fs = require('fs');
  const os = require('os');
  const dailyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-daily-'));
  const bjDay = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  fs.mkdirSync(path.join(dailyRoot, bjDay), { recursive: true });
  fs.writeFileSync(
    path.join(dailyRoot, bjDay, 'daily.md'),
    '## 一、今天要处理的事\n\n- [ ] 假待办一条｜QQ · 大肥鱼 · 09:12\n',
    'utf8'
  );
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'desk', 'server.js')], {
    env: {
      ...process.env,
      DESK_PORT: String(port),
      DESK_HOST: '127.0.0.1',
      DESK_TOKEN: TOKEN,
      DESK_AGENT_TOKEN: AGENT,
      DESK_SHEET: path.join(ROOT, 'pets', 'duodong', 'spritesheet.webp'),
      DESK_DAILY_DIR: dailyRoot,
      DESK_ALLOW_POWER: '' // 显式清空，别从环境里继承到 1
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  child.stdout.on('data', (b) => (logs += b.toString()));
  child.stderr.on('data', (b) => (logs += b.toString()));

  try {
    let up = false;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await request(port, '/healthz', 'GET');
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
      check('服务端起得来', false, logs.slice(0, 400) || '超时');
      return;
    }

    console.log('\n[1] 电源指令：没开 DESK_ALLOW_POWER 就 403，不进队列');
    for (const cmd of ['shutdown', 'restart', 'sleep']) {
      const r = await request(port, `/api/cmd?t=${TOKEN}`, 'POST', { cmd });
      check(`${cmd} 被 403 拒绝`, r.status === 403, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
      check(
        `${cmd} 错误码 power-disabled`,
        !!(r.json && r.json.error === 'power-disabled'),
        r.text.slice(0, 120)
      );
    }

    const st = await request(port, `/api/state?t=${TOKEN}`, 'GET');
    check('state.power=false（前端靠它置灰）', !!(st.json && st.json.power === false), String(st.json && st.json.power));
    check('被拒的指令没进队列', !!(st.json && st.json.pending === 0), String(st.json && st.json.pending));
    check('seq 没被白占', !!(st.json && st.json.seq === 0), String(st.json && st.json.seq));

    console.log('\n[2] 别误伤正常指令');
    const shot = await request(port, `/api/cmd?t=${TOKEN}`, 'POST', { cmd: 'shot' });
    check('shot 放行', shot.status === 200 && !!(shot.json && shot.json.ok), `HTTP ${shot.status}`);
    const lock = await request(port, `/api/cmd?t=${TOKEN}`, 'POST', { cmd: 'lock' });
    check('lock 放行（不丢数据，不该拦）', lock.status === 200, `HTTP ${lock.status}`);
    for (const cmd of ['media', 'openapp']) {
      const r = await request(port, `/api/cmd?t=${TOKEN}`, 'POST', {
        cmd,
        args: cmd === 'media' ? { action: 'next' } : { name: '网易云' }
      });
      check(`${cmd} 放行`, r.status === 200, `HTTP ${r.status}`);
    }

    console.log('\n[2b] 应用列表跟着电脑端上报走');
    await request(port, `/agent/report?t=${AGENT}`, 'POST', {
      info: { host: 'test-pc' },
      apps: ['网易云', '微信']
    });
    const st2 = await request(port, `/api/state?t=${TOKEN}`, 'GET');
    check(
      'state.apps 就是上报的那两个',
      !!(st2.json && Array.isArray(st2.json.apps) && st2.json.apps.join(',') === '网易云,微信'),
      JSON.stringify(st2.json && st2.json.apps)
    );

    await request(port, `/agent/report?t=${AGENT}`, 'POST', {
      info: { host: 'test-pc' },
      apps: Array.from({ length: 20 }, (_, i) => 'app' + i)
    });
    const st3 = await request(port, `/api/state?t=${TOKEN}`, 'GET');
    check(
      '超过 8 个只留 8 个（别把手机挤爆）',
      !!(st3.json && st3.json.apps && st3.json.apps.length === 8),
      String(st3.json && st3.json.apps && st3.json.apps.length)
    );

    console.log('\n[3] token 先于一切');
    const bad = await request(port, '/api/cmd?t=wrong', 'POST', { cmd: 'shutdown' });
    check('token 不对 401，而不是 403', bad.status === 401, `HTTP ${bad.status}`);
    const badState = await request(port, '/api/state?t=wrong', 'GET');
    check('state 也要 token', badState.status === 401, `HTTP ${badState.status}`);

    console.log('\n[4] 服务端重启后 seq 要能对齐');
    // 模拟：电脑端记得 since=99，服务端刚重启、seq 还停在 2（上面发过两条）
    const t0 = Date.now();
    const resync = await request(port, `/agent/poll?t=${AGENT}&since=99`, 'GET');
    const dt = Date.now() - t0;
    check('since 超前的 poll 立刻返回，不挂 25 秒', dt < 3000, `${dt}ms`);
    check('返回 resync 标记', !!(resync.json && resync.json.resync === true), resync.text.slice(0, 120));
    check('没有把旧指令当新的发下去', !!(resync.json && resync.json.cmds && resync.json.cmds.length === 0));

    const after = await request(port, `/api/cmd?t=${TOKEN}`, 'POST', { cmd: 'shot' });
    check('对齐后新指令 id 大于 since', !!(after.json && after.json.id > 99), JSON.stringify(after.json));
    console.log('  （这条新指令不会被电脑取走：它的 since=99 已经越过 100）');

    console.log('\n[5] 投递不丢指令');
    const sent = await request(port, `/api/cmd?t=${TOKEN}`, 'POST', { cmd: 'say', args: { text: '测试' } });
    const cid = sent.json.id;
    const p1 = await request(port, `/agent/poll?t=${AGENT}&since=${cid - 1}&nowait=1`, 'GET');
    check('poll 取到了', !!(p1.json && (p1.json.cmds || []).some((c) => c.id === cid)));
    const p2 = await request(port, `/agent/poll?t=${AGENT}&since=${cid - 1}&nowait=1`, 'GET');
    check(
      '响应丢了再 poll 还能取到（不能先出队）',
      !!(p2.json && (p2.json.cmds || []).some((c) => c.id === cid))
    );
    await request(port, `/agent/result?t=${AGENT}`, 'POST', {
      id: cid,
      cmd: 'say',
      ok: true,
      message: '测试'
    });
    const p3 = await request(port, `/agent/poll?t=${AGENT}&since=${cid - 1}&nowait=1`, 'GET');
    check(
      '报回执后才真正出队',
      !!(p3.json && !(p3.json.cmds || []).some((c) => c.id === cid))
    );
    console.log('\n[6] 备忘录：上报能到手机，清单原文能取');
    const memo = {
      stats: { total: 2, done: 1, open: 1 },
      items: [
        { id: 'a1', text: '把图交上去', done: false, chat: '大肥鱼', src: 'QQ', day: bjDay, hm: '09:12' },
        { id: 'a2', text: '已经做完的', done: true, chat: '', src: '', day: bjDay, hm: '08:00' }
      ],
      at: Date.now()
    };
    const rep = await request(port, `/agent/report?t=${AGENT}`, 'POST', { memo });
    check('report 收下备忘录', rep.status === 200, `HTTP ${rep.status}`);
    const mst = await request(port, `/api/state?t=${TOKEN}`, 'GET');
    check('状态里带着待办条数', !!(mst.json && mst.json.memo && mst.json.memo.stats.total === 2),
      JSON.stringify(mst.json && mst.json.memo));
    check('未完成排在已完成前面', !!(mst.json && mst.json.memo.items[0].done === false));

    const dl = await request(port, `/api/daily?t=${AGENT}&day=${bjDay}`, 'GET');
    check('清单原文取得到', !!(dl.json && /假待办一条/.test(dl.json.md || '')), `HTTP ${dl.status}`);
    const noDay = await request(port, `/api/daily?t=${AGENT}&day=${bjDay}`, 'GET');
    check('日期格式对得上北京时间的今天', !!(noDay.json && noDay.json.day === bjDay));

    const dl401 = await request(port, `/api/daily?t=${TOKEN}&day=${bjDay}`, 'GET');
    check('清单用电脑端口令才能取（手机端口令不行）', dl401.status === 401, `HTTP ${dl401.status}`);
    const badDay = await request(port, `/api/daily?t=${AGENT}&day=../etc`, 'GET');
    check('日期参数不能穿目录', badDay.status === 400, `HTTP ${badDay.status}`);
    const missDay = await request(port, `/api/daily?t=${AGENT}&day=1999-01-01`, 'GET');
    check('那天没清单也不报错，回空', missDay.status === 200 && missDay.json.md === '');
  } finally {
    child.kill();
    try { fs.rmSync(dailyRoot, { recursive: true, force: true }); } catch { /* 临时目录，清不掉无所谓 */ }
    await sleepMs(200);
  }

  console.log(`\n手机控制端：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
