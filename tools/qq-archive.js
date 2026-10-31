#!/usr/bin/env node
'use strict';
/**
 * 查 QQ 归档记录。给人的感觉就是「问一句话」。
 *
 *   node tools/qq-archive.js --overview                 # 我和谁最近在聊、各多少句
 *   node tools/qq-archive.js --who G --limit 30         # 跟 G 最近 30 句
 *   node tools/qq-archive.js --q 设计稿                 # 聊过「设计稿」的记录
 *   node tools/qq-archive.js --from 2026-10-28 --to 2026-10-31
 *   node tools/qq-archive.js --who G --q 饭 --since 2026-10-30
 *   node tools/qq-archive.js --stats                    # 归档了多少天/多少条
 *
 * 选项：
 *   --who    会话 ID 或昵称（包含匹配）
 *   --q      正文关键词，空格分隔=都要命中
 *   --from   起始日期 YYYY-MM-DD（北京时区）
 *   --to     截止日期 YYYY-MM-DD
 *   --since  起始日期/时间的简写（等同 --from）
 *   --type   private | group
 *   --me     只看我发的；--other 只看对方发的
 *   --limit  最多几条，默认 200，0=全部
 *   --json   输出原始 JSON（给程序/agent 用）
 */

const archive = require('../src/core/qq/archive');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'overview' || key === 'stats' || key === 'json' || key === 'me' || key === 'other' || key === 'help') {
      o[key] = true;
    } else {
      o[key] = next;
      i++;
    }
  }
  return o;
}

const o = parseArgs(process.argv.slice(2));

if (o.help) {
  console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*/, ''));
  process.exit(0);
}

if (o.stats) {
  const days = archive.days();
  const all = archive.query({ limit: 0 });
  const ov = archive.overview({ limit: 0 });
  console.log(`归档天数：${days.length} 天${days.length ? `（${days[0]} ~ ${days[days.length - 1]}）` : ''}`);
  console.log(`总条数：${all.length}`);
  console.log(`会话数：${ov.length}`);
  const priv = all.filter((r) => r.c === 'private').length;
  console.log(`其中私聊 ${priv} 条、群聊 ${all.length - priv} 条；我发的 ${all.filter((r) => r.me).length} 条`);
  if (ov.length) {
    console.log('\n最近会话：');
    for (const v of ov.slice(0, 15)) {
      console.log(`  ${v.type === 'group' ? '群' : '私'} ${v.id} ${v.name || ''} — ${v.count} 条，最后 ${archive.fmtTime(v.last)}`);
    }
  }
  process.exit(0);
}

if (o.overview) {
  const ov = archive.overview({ from: o.from, to: o.to, limit: 0 });
  if (!ov.length) {
    console.log('归档里还没有记录。');
    process.exit(0);
  }
  console.log('会话'.padEnd(4) + ' 对象'.padEnd(28) + ' 条数'.padEnd(8) + ' 我'.padEnd(6) + ' 最后一句');
  for (const v of ov) {
    const label = `${v.name || '?'}(${v.id})`.slice(0, 26);
    console.log(
      `${v.type === 'group' ? '群' : '私'}   ${label.padEnd(26)} ${String(v.count).padEnd(8)} ${String(v.mine).padEnd(6)} ${archive.fmtTime(v.last)}`
    );
  }
  process.exit(0);
}

const rows = archive.query({
  from: o.from || o.since,
  to: o.to,
  who: o.who,
  keyword: o.q,
  type: o.type,
  me: o.me ? true : o.other ? false : undefined,
  limit: o.limit === undefined ? 200 : Number(o.limit)
});

if (o.json) {
  console.log(JSON.stringify(rows, null, 1));
} else if (!rows.length) {
  console.log('没查到。试试去掉条件，或先跑 --stats 看归档里有什么。');
} else {
  console.log(archive.render(rows));
  console.log(`\n—— 共 ${rows.length} 条（${archive.fmtTime(rows[0].t)} ~ ${archive.fmtTime(rows[rows.length - 1].t)}）`);
}
