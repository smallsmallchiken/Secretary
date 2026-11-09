'use strict';

/**
 * 手机控制端的「电脑这半边」。
 *
 * 电脑主动连出去（长轮询），所以不需要公网 IP、不需要路由器端口映射，
 * 也不怕运营商封 80 端口——它就是个普通出站 HTTP 请求。
 *
 * 连上之后能做四件事：执行指令、上报状态、上传截图、转接对话。
 * 指令都走 tools/system.run，和桌宠自己用的是同一套实现，不重复造。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const config = require('../core/config');
const system = require('../core/tools/system');
const media = require('../core/tools/media');
const apps = require('../core/tools/apps');
const { dbg } = require('../core/debug');

let running = false;
let seq = 0; // 已经执行到第几条指令，服务器靠它判断队列
let fail = 0;
let sayHandler = null; // main.js 注入的对话入口，避免和 main 循环 require
let loops = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cfg() {
  return config.get('remote', {}) || {};
}

function base() {
  const c = cfg();
  return String(c.base || '').replace(/\/+$/, '');
}

/* ------------------------------ HTTP ------------------------------ */

function request(pathname, opts = {}) {
  const c = cfg();
  const method = opts.method || 'GET';
  const timeout = opts.timeout || 40000;
  const u = new URL(base() + pathname);
  const lib = u.protocol === 'https:' ? https : http;
  const body = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': body.length }
          : {},
        timeout
      },
      (res) => {
        const chunks = [];
        res.on('data', (x) => chunks.push(x));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON 就当空 */
          }
          resolve({ status: res.statusCode, json, raw: text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
    // 刻意不挂 abort 控制器：长轮询本来就要挂住 25 秒，
    // 真要停的时候由 running=false 让它自然结束（最多多等一轮）
    void c;
  });
}

/* ------------------------------ 指令执行 ------------------------------ */

function shotPath() {
  const dir = path.join(os.tmpdir(), 'desk-shot');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `shot-${Date.now()}.jpg`);
}

async function execOne(c) {
  const id = Number(c.id) || 0;
  const cmd = String(c.cmd || '');
  const args = c.args || {};
  let ok = false;
  let message = '';
  let data = null;

  dbg(`[remote] 收到指令 #${id} ${cmd}`);
  try {
    switch (cmd) {
      case 'shutdown':
      case 'restart':
      case 'lock':
      case 'cancel': {
        const r = await system.run(cmd, args);
        ok = true;
        message = r.message;
        break;
      }
      case 'sleep': {
        // 睡眠是立刻挂起，进程可能在结果发出去之前就冻住。
        // 所以先把「正在睡眠」报上去，隔一会儿再真的睡。
        // 闸门要先查：等 setTimeout 里才失败的话，手机已经收到「正在睡眠」了
        if (!system.powerAllowed()) throw new Error('电源操作已禁用（power.allow 不是 true）');
        ok = true;
        message = '正在睡眠';
        setTimeout(() => {
          system.run('sleep').catch((e) => dbg('[remote] 睡眠失败:', e.message));
        }, 700);
        break;
      }
      case 'shot': {
        const file = shotPath();
        const r = await system.run('screenshot', { format: 'jpg', path: file });
        const buf = fs.readFileSync(r.data);
        const up = await request(`/agent/shot?t=${encodeURIComponent(cfg().token || '')}`, {
          method: 'POST',
          body: { data: buf.toString('base64') },
          timeout: 30000
        });
        if (!up.json || !up.json.shotId) throw new Error('上传截图失败');
        ok = true;
        message = '截好了';
        data = { shotId: up.json.shotId, kb: Math.round(buf.length / 1024) };
        fs.unlink(r.data, () => {});
        break;
      }
      case 'media': {
        const r = await media.control(String(args.action || 'toggle'));
        ok = true;
        message = r.message;
        break;
      }
      case 'openapp': {
        const name = String(args.name || '').trim();
        if (!name) throw new Error('要打开哪个应用？');
        const aliases = config.get('appAliases', {}) || {};
        const r = await apps.openApp(name, aliases);
        ok = true;
        message = r.message;
        break;
      }
      case 'say': {
        const text = String(args.text || '').slice(0, 500).trim();
        if (!text) throw new Error('空消息');
        if (!sayHandler) throw new Error('对话入口没接上');
        const res = await sayHandler(text);
        ok = true;
        message = (res && res.message) || '（没说话）';
        break;
      }
      default:
        throw new Error(`不认识的指令：${cmd}`);
    }
  } catch (err) {
    message = err.message || String(err);
    dbg(`[remote] 指令 #${id} ${cmd} 失败:`, message);
  }

  seq = Math.max(seq, id);
  try {
    await request(`/agent/result?t=${encodeURIComponent(cfg().token || '')}`, {
      method: 'POST',
      body: { id, cmd, ok, message, data },
      timeout: 12000
    });
  } catch (e) {
    dbg('[remote] 结果上报失败:', e.message);
  }
}

/* ------------------------------ 两条循环 ------------------------------ */

async function pollLoop() {
  while (running) {
    try {
      const q =
        `/agent/poll?t=${encodeURIComponent(cfg().token || '')}` +
        `&since=${seq}&host=${encodeURIComponent(cfg().name || os.hostname())}`;
      const r = await request(q, { timeout: 35000 });
      if (r.status === 401) {
        dbg('[remote] 口令不对，30 秒后再试');
        await sleep(30000);
        continue;
      }
      seq = Math.max(seq, Number((r.json && r.json.seq) || 0));
      const cmds = (r.json && r.json.cmds) || [];
      for (const c of cmds) {
        if (!running) break;
        await execOne(c);
      }
      fail = 0;
    } catch (err) {
      if (!running) break;
      fail++;
      const wait = Math.min(30000, 2000 * Math.pow(2, Math.min(fail, 4)));
      // 只有前几次和之后每分钟打一次，别把 debug.log 刷爆
      if (fail <= 3 || fail % 30 === 0) {
        dbg(`[remote] 连不上服务器（第 ${fail} 次）：${err.message}，${Math.round(wait / 1000)}s 后重试`);
      }
      await sleep(wait);
    }
  }
}

async function reportLoop() {
  let last = 0;
  // 等一会儿再报第一次：CPU 占用要两次采样才有数，
  // 和 start() 里的预热挨太近会算不出东西
  await sleep(1500);
  while (running) {
    try {
      const info = await system.sysinfo();
      // 把 appAliases 的键带上去，手机端才能生成「打开应用」的按钮——
      // 应用列表只有这台机器知道，服务端不该硬编码
      const apps = Object.keys(config.get('appAliases', {}) || {});
      const r = await request(`/agent/report?t=${encodeURIComponent(cfg().token || '')}`, {
        method: 'POST',
        body: { info, apps },
        timeout: 12000
      });
      if (r.status === 200) last = Date.now();
    } catch (err) {
      // 账号口令错已经由 pollLoop 报过，这里静默
      void err;
    }
    await sleep(8000);
  }
}

/* ------------------------------ 对外接口 ------------------------------ */

/** @param {(text:string)=>Promise<object>} fn 对话入口（main.js 的 handleUserMessage） */
function setSayHandler(fn) {
  sayHandler = fn;
}

function start() {
  const c = cfg();
  if (c.enabled !== true) {
    dbg('[remote] 未启用（config.remote.enabled）');
    return { ok: false, reason: 'disabled' };
  }
  if (!c.base || !c.token) {
    dbg('[remote] 缺少 base 或 token，跳过');
    return { ok: false, reason: 'config' };
  }
  if (running) return { ok: true, already: true };
  running = true;
  fail = 0;
  // 预热一次：CPU 占用要两次采样才有数，别让手机第一屏显示 "--"
  system.sysinfo().catch(() => {});
  loops = [pollLoop(), reportLoop()];
  dbg(`[remote] 已启动 → ${c.base}`);
  return { ok: true };
}

function stop() {
  running = false;
  loops = [];
  dbg('[remote] 已停止');
}

function status() {
  const c = cfg();
  return { running, enabled: c.enabled === true, base: c.base || '', name: c.name || '', seq };
}

module.exports = { start, stop, status, setSayHandler, execOne, _internals: { request, cfg } };
