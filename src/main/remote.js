'use strict';

/**
 * 手机控制端的「电脑这半边」。
 *
 * 电脑主动连出去（长轮询），所以不需要公网 IP、不需要路由器端口映射，
 * 也不怕运营商封 80 端口——它就是个普通出站 HTTP 请求。
 *
 * 连上之后只做三件事：控制桌宠（戳一下 / 溜达一圈）、上报备忘录与状态、
 * 把手机上的话转给桌宠的对话入口。
 *
 * 手机端刻意做得很窄——只留「桌宠」和「今天的待办」两块。电源、媒体、
 * 打开应用、截屏那些都撤掉了：在外面真正会用的只有这两件事，多一个按钮
 * 就多一处要维护、多一个可能点错的地方。要加功能先问清楚再加。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const config = require('../core/config');
const system = require('../core/tools/system');
const memo = require('../core/memo');
const { dataDir } = require('../core/paths');
const wander = require('./wander');
const windows = require('./windows');
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

/* ------------------------------ 备忘录 ------------------------------ */

/** 北京时间的今天。清单目录按北京时区分天，服务器与本地都按这个算 */
function bjDay() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 上一次同步到的清单原文：内容没变就不重复解析、不重复写盘 */
let lastDailyMd = '';
let lastMemoAt = 0;

/**
 * 从服务器取今天的清单原文，落到本地 .data/daily/<天>/daily.md，再交给 memo 解析。
 *
 * 为什么绕这一圈而不是自己解析：`memo.parseDaily` 是待办格式的唯一实现，
 * 而清单的产出方是 server/daily_report.py。多写一份解析就多一处会分叉的地方。
 */
async function pullDaily(force) {
  const day = bjDay();
  let r;
  try {
    r = await request(
      `/api/daily?t=${encodeURIComponent(cfg().token || '')}&day=${day}`,
      { timeout: 12000 }
    );
  } catch (err) {
    // 服务器重启、热点掉线都会走到这里。拉不到就拉倒，
    // 本地已有的待办照常用——不能让一次网络抖动把整条上报链路打断。
    dbg('[remote] 取清单失败:', err.message);
    return { pulled: false, added: 0 };
  }
  if (r.status !== 200 || !r.json || !r.json.md) return { pulled: false, added: 0 };
  const md = String(r.json.md);
  if (!md.trim()) return { pulled: false, added: 0 };
  if (!force && md === lastDailyMd) return { pulled: false, added: 0 };

  lastDailyMd = md;
  try {
    const dir = path.join(dataDir(), 'daily', day);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daily.md'), md, 'utf8');
  } catch (err) {
    dbg('[remote] 写本地清单失败:', err.message);
    return { pulled: false, added: 0 };
  }
  try {
    const s = memo.syncFromDaily();
    if (s.added) dbg(`[remote] 清单同步：新增 ${s.added} 条，共 ${s.total} 条`);
    return { pulled: true, added: s.added };
  } catch (err) {
    dbg('[remote] 备忘录同步失败:', err.message);
    return { pulled: false, added: 0 };
  }
}

/**
 * 给手机看的备忘录。
 *
 * 未完成的排前面（新的在上），已完成的只带最近几条垫底——
 * 手机上这块地方是拿来「看一眼还有什么事」，不是翻旧账的。
 */
function packMemo() {
  let all = [];
  let stats = { total: 0, done: 0, open: 0 };
  try {
    const l = memo.list();
    all = l.items || [];
    stats = l.stats || stats;
  } catch {
    /* 备忘录坏了不该拖垮整条上报链路 */
  }
  const open = all.filter((x) => !x.done);
  const done = all.filter((x) => x.done).slice(0, 6);
  const items = open.concat(done).slice(0, 40).map((x) => ({
    id: x.id,
    text: String(x.text || '').slice(0, 140),
    done: !!x.done,
    chat: String(x.chat || '').slice(0, 20),
    src: String(x.src || '').slice(0, 8),
    day: String(x.day || ''),
    hm: String(x.hm || '')
  }));
  return { stats, items, at: Date.now() };
}

/* ------------------------------ 两条循环 ------------------------------ */async function execOne(c) {
  const id = Number(c.id) || 0;
  const cmd = String(c.cmd || '');
  const args = c.args || {};
  let ok = false;
  let message = '';
  let data = null;

  dbg(`[remote] 收到指令 #${id} ${cmd}`);
  try {
    switch (cmd) {
      case 'pet': {
        // 手机戳一下桌宠。不走去问模型：这个动作要的是「立刻有反应」，
        // 等两秒才回一句才是真的怪。
        const action = String(args.action || 'poke');
        if (action === 'walk') {
          ok = wander.nudge();
          message = ok ? '溜达去了' : '正在忙，等会儿';
        } else {
          windows.sendToPet('pet:state', { state: 'happy' });
          setTimeout(() => windows.sendToPet('pet:state', { state: 'idle' }), 1800);
          ok = true;
          message = '嗯？';
        }
        break;
      }
      case 'memotoggle': {
        const r = memo.toggle(String(args.id || ''));
        if (!r.ok) throw new Error(r.error || '没有这条待办');
        ok = true;
        message = r.item.done ? '已完成' : '已恢复';
        data = { stats: r.stats };
        break;
      }
      case 'memorefresh': {
        const n = await pullDaily();
        ok = true;
        message = n.added ? `新增 ${n.added} 条` : '已是最新';
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

/**
 * 状态 + 备忘录上报。
 *
 * 这块调快到了 3.5 秒一次：手机打开就是「今天还有什么事」，勾一条要马上变灰。
 * 系统信息（CPU/内存/电量）没那么急，每 4 轮算一次，值班的是备忘录。
 * 清单来源每 60 秒拉一次——服务器那边是每小时重跑日报，一分钟的延迟够用了。
 */
async function reportLoop() {
  let tick = 0;
  let info = null;
  let reportFail = 0;
  // 等一会儿再报第一次：CPU 占用要两次采样才有数，
  // 和 start() 里的预热挨太近会算不出东西
  await sleep(1200);
  while (running) {
    try {
      if (Date.now() - lastMemoAt > 55000) {
        lastMemoAt = Date.now();
        try {
          await pullDaily();
        } catch (err) {
          dbg('[remote] 拉清单失败:', err.message);
        }
      }
      if (tick % 4 === 0 || !info) {
        try {
          info = await system.sysinfo();
        } catch {
          /* 拿不到就沿用上一次的，别因为电量读失败中断上报 */
        }
      }
      tick += 1;

      const r = await request(`/agent/report?t=${encodeURIComponent(cfg().token || '')}`, {
        method: 'POST',
        body: { info, memo: packMemo() },
        timeout: 12000
      });
      if (r.status === 401) {
        dbg('[remote] 上报口令不对，30 秒后再试');
        await sleep(30000);
        continue;
      }
    } catch (err) {
      // 别静默：上报断了手机就一直显示上一次的列表，用户只会觉得「不实时」。
      // 但也不能每秒刷一行，前三次 + 之后每 30 次记一条。
      reportFail += 1;
      if (reportFail <= 3 || reportFail % 30 === 0) {
        dbg(`[remote] 上报失败（第 ${reportFail} 次）：${err.message}`);
      }
    }
    await sleep(3500);
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

module.exports = {
  start, stop, status, setSayHandler, execOne,
  // pullDaily / packMemo 单独放出来是给 tools/test-remote-memo.js 用的：
  // 「清单 -> 待办」这条链路要能在不起 Electron 的情况下单测
  _internals: { request, cfg, pullDaily, packMemo, resetDailyCache: () => { lastDailyMd = ''; } }
};
