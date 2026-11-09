'use strict';

/**
 * 手机控制端服务（跑在服务器上，常开）。
 *
 * 为什么服务端必须在云上：电脑关机时手机还得能打开页面、看到「离线」、点按钮。
 * 所以页面托管在这里，家里的电脑反过来连过来（长轮询），不需要公网 IP、不需要端口映射。
 *
 * 三条链路：
 *   手机 ──GET /api/state──► 读状态（含最近指令结果）
 *   手机 ──POST /api/cmd───► 写指令进队列
 *   电脑 ──GET /agent/poll─► 长轮询取指令（25 秒，有活立即返回）
 *   电脑 ──POST /agent/report / /agent/result──► 上报状态与结果
 *
 * 零依赖：只用 Node 内置模块，容器里不用 npm install。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.DESK_PORT || 8765);
const HOST = process.env.DESK_HOST || '127.0.0.1';
const TOKEN = process.env.DESK_TOKEN || '';
const AGENT_TOKEN = process.env.DESK_AGENT_TOKEN || '';
const SHEET = process.env.DESK_SHEET || '/opt/secretary/pets/duodong/spritesheet.webp';
const PUBLIC = path.join(__dirname, 'public');

const ONLINE_WINDOW_MS = 20000; // 20 秒没心跳算离线（心跳 8 秒一次）
const POLL_HOLD_MS = 25000; // 长轮询挂起上限，要小于 nginx proxy_read_timeout
const KEEP_RESULTS = 40;
// 截图走 base64 JSON，1080p 的 JPEG 质量 55 大约 200~400KB，base64 膨胀 4/3。
// 留 8MB 是给 4K 屏和大窗口的余量，不是常规用量。
const MAX_BODY = 8 * 1024 * 1024;
const MAX_SHOT = 6 * 1024 * 1024;
const KEEP_SHOTS = 4;

/**
 * 电源类指令的开关，默认关闭（要开得给容器加 DESK_ALLOW_POWER=1）。
 *
 * 两个理由：
 * 1. 关机 / 重启 / 睡眠是**不可撤销**的，电脑黑了人可能连电源键都按不到；
 * 2. 指令是排队的——电脑离线时点的「关机」会留在队列里，等它半小时后上线才执行。
 *    用户早忘了自己点过，一开机又被关掉，这叫事故不叫功能。
 * 所以默认一律拒绝，连队列都不进。
 */
const ALLOW_POWER = process.env.DESK_ALLOW_POWER === '1';
const POWER_CMDS = new Set(['shutdown', 'restart', 'sleep']);

/** 服务端唯一的共享状态。进程重启就清空，本来也只是几分钟内的缓存 */
const state = {
  seq: 0, // 指令序号，只增不减
  queue: [], // 待电脑执行的指令
  results: {}, // id -> { id, cmd, ok, message, at, data }
  agent: {
    lastSeen: 0,
    seenSeq: 0,
    info: null,
    host: ''
  },
  shots: new Map(), // shotId -> { buf, at }  截图只留内存，页面关了就没人看
  startedAt: Date.now()
};

/* ------------------------------ 小工具 ------------------------------ */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

/** 定长比较，避免 token 逐字符泄露时序 */
function sameToken(given, expect) {
  if (!expect || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expect));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function tokenOf(req, url) {
  const q = url.searchParams.get('t');
  if (q) return q;
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function online() {
  return Date.now() - state.agent.lastSeen < ONLINE_WINDOW_MS;
}

/** 有新的指令就唤醒挂起的长轮询 */
const waiters = new Set();
function wakeAll() {
  for (const fn of waiters) fn();
  waiters.clear();
}

function pushResult(r) {
  state.results[r.id] = r;
  const keys = Object.keys(state.results);
  if (keys.length > KEEP_RESULTS) {
    keys
      .sort((x, y) => (state.results[x].at || 0) - (state.results[y].at || 0))
      .slice(0, keys.length - KEEP_RESULTS)
      .forEach((k) => delete state.results[k]);
  }
}

/** 指令队列清理：电脑超过 5 分钟没取走的，直接丢，免得一开机执行一堆旧指令 */
function dropStale() {
  const now = Date.now();
  const before = state.queue.length;
  state.queue = state.queue.filter((c) => {
    // 电源指令的时间窗更短：电脑离线时点的「关机」不该等它上线才执行
    const ttl = POWER_CMDS.has(c.cmd) ? 60000 : 300000;
    return now - c.at < ttl;
  });
  if (before !== state.queue.length) {
    console.log(`[desk] 丢弃 ${before - state.queue.length} 条过期指令`);
  }
}

/* ------------------------------ 路由 ------------------------------ */

function serveStatic(res, file, type, maxAge) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store'
    });
    res.end(buf);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // 静态资源不需要 token：页面本身不含机密，雪碧图是公开素材
  if (p === '/' || p === '/index.html') {
    return serveStatic(res, path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8', 0);
  }
  if (p === '/spritesheet.webp') {
    return serveStatic(res, SHEET, 'image/webp', 604800);
  }
  if (p === '/manifest.webmanifest') {
    return serveStatic(res, path.join(PUBLIC, 'manifest.webmanifest'), 'application/manifest+json', 3600);
  }
  // 图标给「添加到主屏幕」用。白名单写死文件名，不做目录遍历
  if (p === '/icon-192.png' || p === '/icon-512.png') {
    return serveStatic(res, path.join(PUBLIC, path.basename(p)), 'image/png', 604800);
  }
  if (p === '/healthz') {
    return json(res, 200, { ok: true, online: online(), up: Math.round((Date.now() - state.startedAt) / 1000) });
  }

  // ---------- 手机侧 ----------
  if (p === '/api/state') {
    if (!sameToken(tokenOf(req, url), TOKEN)) return json(res, 401, { error: 'token' });
    return json(res, 200, {
      online: online(),
      lastSeen: state.agent.lastSeen,
      host: state.agent.host,
      info: state.agent.info,
      seq: state.seq,
      pending: state.queue.length,
      power: ALLOW_POWER,
      results: Object.values(state.results).sort((a, b) => a.at - b.at)
    });
  }

  if (p === '/api/cmd' && req.method === 'POST') {
    if (!sameToken(tokenOf(req, url), TOKEN)) return json(res, 401, { error: 'token' });
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const cmd = String(body.cmd || '').trim();
    if (!cmd) return json(res, 400, { error: 'no cmd' });
    if (POWER_CMDS.has(cmd) && !ALLOW_POWER) {
      console.log(`[desk] 拒绝电源指令 ${cmd}（DESK_ALLOW_POWER 未开启）`);
      return json(res, 403, {
        error: 'power-disabled',
        message: '电源操作还没开启，这一步不会执行'
      });
    }
    dropStale();
    const item = { id: ++state.seq, cmd, args: body.args || {}, at: Date.now() };
    state.queue.push(item);
    console.log(`[desk] +指令 #${item.id} ${cmd} ${JSON.stringify(item.args).slice(0, 80)}`);
    wakeAll();
    return json(res, 200, { ok: true, id: item.id, online: online() });
  }

  // ---------- 截图 ----------
  // 电脑抓的屏先传上来，手机再按 id 取。不塞进 state 里是因为图片几百 KB，
  // 手机每 2.5 秒轮询一次状态，把图塞进去等于反复下载同一张。
  if (p.startsWith('/api/shot/')) {
    if (!sameToken(tokenOf(req, url), TOKEN)) return json(res, 401, { error: 'token' });
    const id = p.slice('/api/shot/'.length);
    const s = /^[a-f0-9]{8}$/.test(id) ? state.shots.get(id) : null;
    if (!s) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('截图已过期');
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': s.buf.length,
      'Cache-Control': 'no-store'
    });
    return res.end(s.buf);
  }

  // ---------- 电脑侧 ----------
  if (p === '/agent/poll') {
    if (!sameToken(tokenOf(req, url), AGENT_TOKEN)) return json(res, 401, { error: 'token' });
    const since = Number(url.searchParams.get('since') || 0);
    state.agent.lastSeen = Date.now();
    state.agent.seenSeq = Math.max(state.agent.seenSeq, since);
    state.agent.host = url.searchParams.get('host') || state.agent.host;

    // 服务端重启过：state.seq 从 0 重新数，而电脑端的 since 还记得上次的值（比如 4）。
    // 不把它抬上来，接下来分配的 id 全都 <= since，电脑一条都取不到——看起来就是
    // 「手机点了按钮没反应」，得连点好几次把 seq 追平才恢复。
    // 这种情况立刻回一个空响应（不挂 25 秒），客户端会带着新 seq 马上再来一轮。
    if (since > state.seq) {
      state.seq = since;
      return json(res, 200, { cmds: [], seq: state.seq, now: Date.now(), resync: true });
    }
    dropStale();

    const pick = () => state.queue.filter((c) => c.id > since);
    let ready = pick();
    if (ready.length) {
      state.queue = state.queue.filter((c) => c.id > since);
      return json(res, 200, { cmds: ready });
    }

    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.delete(finish);
      const got = pick();
      state.queue = state.queue.filter((c) => c.id > since);
      state.agent.lastSeen = Date.now();
      json(res, 200, { cmds: got, now: Date.now() });
    };
    waiters.add(finish);
    timer = setTimeout(finish, POLL_HOLD_MS);
    // 关掉 keep-alive 的话这里要防客户端提前断开：
    req.on('close', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        waiters.delete(finish);
      }
    });
    return;
  }

  if (p === '/agent/report' && req.method === 'POST') {
    if (!sameToken(tokenOf(req, url), AGENT_TOKEN)) return json(res, 401, { error: 'token' });
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    state.agent.lastSeen = Date.now();
    state.agent.info = body.info || null;
    state.agent.host = (body.info && body.info.host) || state.agent.host;
    return json(res, 200, { ok: true, seq: state.seq });
  }

  if (p === '/agent/result' && req.method === 'POST') {
    if (!sameToken(tokenOf(req, url), AGENT_TOKEN)) return json(res, 401, { error: 'token' });
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    state.agent.lastSeen = Date.now();
    pushResult({
      id: Number(body.id) || 0,
      cmd: String(body.cmd || ''),
      ok: !!body.ok,
      message: String(body.message || '').slice(0, 600),
      data: body.data || null,
      at: Date.now()
    });
    return json(res, 200, { ok: true });
  }

  if (p === '/agent/shot' && req.method === 'POST') {
    if (!sameToken(tokenOf(req, url), AGENT_TOKEN)) return json(res, 401, { error: 'token' });
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    state.agent.lastSeen = Date.now();
    let buf;
    try {
      buf = Buffer.from(String(body.data || ''), 'base64');
    } catch (e) {
      return json(res, 400, { error: 'bad base64' });
    }
    if (!buf || !buf.length) return json(res, 400, { error: 'empty' });
    if (buf.length > MAX_SHOT) return json(res, 413, { error: 'too large' });
    const shotId = crypto.randomBytes(4).toString('hex');
    state.shots.set(shotId, { buf, at: Date.now() });
    if (state.shots.size > KEEP_SHOTS) {
      [...state.shots.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, state.shots.size - KEEP_SHOTS)
        .forEach(([k]) => state.shots.delete(k));
    }
    console.log(`[desk] 收到截图 ${shotId} ${Math.round(buf.length / 1024)}KB`);
    return json(res, 200, { ok: true, shotId });
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[desk] 处理出错', err);
    if (!res.headersSent) json(res, 500, { error: 'internal' });
  });
});

// 长轮询会占着连接，keep-alive 要长于挂起时间，否则复用到一半被掐
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

if (!TOKEN || !AGENT_TOKEN) {
  console.error('[desk] 缺少 DESK_TOKEN / DESK_AGENT_TOKEN，拒绝启动');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`[desk] 监听 http://${HOST}:${PORT}  雪碧图=${SHEET}`);
});

process.on('SIGTERM', () => {
  console.log('[desk] 收到 SIGTERM，退出');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});
