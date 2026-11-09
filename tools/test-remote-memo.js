'use strict';

/**
 * 电脑端「清单 → 备忘录 → 手机上看到的列表」这条链路的离线测试。
 *
 * 不起 Electron、不碰真数据：PET_DATA_DIR 指到临时目录，HTTP 用本地假服务。
 * 要验的是三件事：
 *   1) 从服务端取到的 daily.md 能落盘并解析成待办（解析只有 memo.parseDaily 一份）
 *   2) 内容没变不重复解析，也就不会把用户勾掉的重新变回未完成
 *   3) packMemo 的排序与截断（未完成在前、已完成后置、最多 40 条、正文 140 字）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-memo-'));
process.env.PET_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'daily'), { recursive: true });

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

/* ---------------- 假服务器：只提供 /api/daily ---------------- */
const DAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
let served = '';
let hits = 0;

const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/daily')) {
    hits++;
    const body = JSON.stringify({ day: DAY, md: served, at: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }
  res.writeHead(404).end('{}');
});

function todoMd(n, tag) {
  const lines = ['## 一、今天要处理的事', ''];
  for (let i = 1; i <= n; i++) {
    lines.push(`- [ ] ${tag}第 ${i} 件事｜QQ · 大肥鱼 · 0${i % 10}:1${i % 10}`);
  }
  lines.push('', '## 二、全量流水', '', '- 这一段的条目不算待办');
  return lines.join('\n') + '\n';
}

function main() {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      fs.writeFileSync(
        path.join(TMP, 'config.json'),
        JSON.stringify({
          remote: { enabled: false, base: `http://127.0.0.1:${port}`, token: 'agent' }
        }),
        'utf8'
      );

      const origResolve = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (request === 'electron') return STUB;
        return origResolve.call(this, request, ...rest);
      };

      const remote = require(path.join(ROOT, 'src', 'main', 'remote.js'));
      const memo = require(path.join(ROOT, 'src', 'core', 'memo.js'));
      const rt = remote._internals;

      console.log('\n[1] 清单原文能落到本地并变成待办');
      served = todoMd(3, '甲');
      const r1 = await rt.pullDaily();
      check('拉到了', r1.pulled === true, JSON.stringify(r1));
      check('新增 3 条', r1.added === 3, String(r1.added));
      const file = path.join(TMP, 'daily', DAY, 'daily.md');
      check('本地有这一天的 daily.md', fs.existsSync(file));
      check('文件内容就是服务端那份', fs.readFileSync(file, 'utf8') === served);
      const l1 = memo.list();
      check('待办里真的多了 3 条', l1.items.length === 3, String(l1.items.length));
      check('「全量流水」段没被当成待办', !l1.items.some((x) => /不算待办/.test(x.text)));

      console.log('\n[2] 内容没变就不重复解析（勾掉的状态不会被冲回去）');
      const id = l1.items[0].id;
      memo.toggle(id);
      check('先勾掉一条', memo.list().stats.done === 1);
      const before = hits;
      const r2 = await rt.pullDaily();
      check('内容相同 → 不写盘不解析', r2.pulled === false);
      check('请求照发（得先拿到内容才能比）', hits === before + 1, `${before} -> ${hits}`);
      check('没有重复条目', memo.list().items.length === 3, String(memo.list().items.length));
      check('勾掉的那条还是勾着的', memo.list().stats.done === 1);

      console.log('\n[3] 清单变了才重新解析');
      served = todoMd(4, '乙');
      const r3 = await rt.pullDaily();
      check('这次拉到了', r3.pulled === true);
      check('新增 4 条', r3.added === 4, String(r3.added));
      check('原来那条勾选状态保留', memo.list().stats.done === 1);

      console.log('\n[4] 给手机的列表：排序、截断');
      const p = rt.packMemo();
      check('未完成排在前面', p.items[0].done === false);
      check('已完成的排在最后', p.items[p.items.length - 1].done === true);
      check('条数等于总数（没超 40）', p.items.length === 7, String(p.items.length));
      check('stats 跟着走', p.stats.total === 7 && p.stats.done === 1, JSON.stringify(p.stats));
      check('字段收敛过（不带 doneAt/created）', !('doneAt' in p.items[0]));

      console.log('\n[5] 条目太多时只带 40 条，且未完成优先');
      served = todoMd(60, '丙');
      await rt.pullDaily();
      const big = rt.packMemo();
      check('截到 40 条', big.items.length === 40, String(big.items.length));
      check('前 39 条都是未完成', big.items.slice(0, 39).every((x) => !x.done));

      console.log('\n[6] 服务端挂了也不炸');
      const oldBase = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));
      void oldBase;
      srv.close();
      const r4 = await rt.pullDaily();
      check('拉不到就安静回 added:0', r4.pulled === false && r4.added === 0);
      const p2 = rt.packMemo();
      check('本地待办还在，手机不会变空白', p2.items.length > 0);

      fs.rmSync(TMP, { recursive: true, force: true });
      console.log(`\n电脑端备忘录链路：${pass} 通过，${fail} 失败`);
      resolve(fail ? 1 : 0);
    });
  });
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
