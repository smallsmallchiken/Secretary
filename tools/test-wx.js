'use strict';

/**
 * 微信自动回复开关自测（不启动 Electron 窗口）。
 *
 * 默认只做只读检查：模块加载、配置读取、pid 文件读写、进程探测。
 * 加 --live 才会真的 stop -> start 一遍（会短时间中断正在值守的微信机器人），
 * 用来验证右键菜单那个开关的完整链路。
 *
 * 用法：
 *   node tools/test-wx.js
 *   node tools/test-wx.js --live
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');

// pid 文件写到临时目录，别污染线上 .data
process.env.PET_DATA_DIR = path.join(os.tmpdir(), `secretary-wx-test-${process.pid}`);
fs.rmSync(process.env.PET_DATA_DIR, { recursive: true, force: true });

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};

const wx = require('../src/core/wechat/bot');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('1) 模块与配置');
  const it = wx._internals;
  check('模块加载', typeof wx.toggle === 'function');
  check('py312 环境存在', it.available() === true);
  const cfg = it.readCfg();
  check('读到 bot-db-config.json', !!cfg && typeof cfg === 'object', JSON.stringify(cfg).slice(0, 80));
  check('配置里有 ttsVoice', typeof cfg.ttsVoice === 'string' && cfg.ttsVoice.length > 0);

  console.log('2) pid 文件');
  it.clearPid();
  check('初始读不到 pid', it.readPid() === null);
  it.writePid(43210);
  check('写入后能读回', it.readPid() === 43210);
  it.clearPid();
  check('清除后读不到', it.readPid() === null);

  console.log('3) 进程探活');
  check('自己一定活着', it.alive(process.pid) === true);
  // 一个几乎不可能存在的 pid
  check('不存在的 pid 判定为死', it.alive(999999) === false);
  check('pid 为 null 判定为死', it.alive(null) === false);

  console.log('4) 「应该开着」标记（看门狗据此决定要不要自愈）');
  it.setWant(false);
  check('初始为不想开', it.isWanted() === false);
  it.setWant(true);
  check('置位后为想开', it.isWanted() === true);
  it.setWant(false);
  check('清除后为不想开', it.isWanted() === false);

  console.log('5) 状态探测（会问一次系统进程表，约 1s）');
  const t0 = Date.now();
  const st = await wx.refresh(true);
  const cost = Date.now() - t0;
  check('refresh 返回结构完整', typeof st.running === 'boolean' && 'pid' in st);
  check('探测耗时 < 8s', cost < 8000, `${cost}ms`);
  console.log(`       现状：running=${st.running} pid=${st.pid} 私聊全回=${st.replyToAll} 群模式=${st.groupMode}`);
  check('同步 status 与 refresh 一致', wx.status().running === st.running);
  // refresh 看到进程活着时会自动把标记补上，否则看门狗不知道要不要自愈
  check('运行中会自动认回标记', st.running ? it.isWanted() === true : true);

  if (process.argv.includes('--live')) {
    console.log('6) 真实 stop -> start（--live）');
    const before = st;
    await wx.stop(true);
    await sleep(800);
    const stopped = await wx.refresh(true);
    check('stop 之后进程不在了', stopped.running === false, `pid=${stopped.pid}`);
    check('stop 会清掉标记', it.isWanted() === false);

    await wx.start();
    await sleep(1500);
    const started = await wx.refresh(true);
    check('start 之后进程回来了', started.running === true, `pid=${started.pid}`);
    check('新 pid 与旧 pid 不同或旧的是外部进程', started.pid !== stopped.pid);
    console.log(`       原来是 pid=${before.pid}，现在是 pid=${started.pid}`);
    if (!started.running) {
      console.log('       ⚠ 服务没起来，请手工执行：');
      console.log('         wechat-bot/py312/pythonw.exe -u wechat-bot/bot_db.py watch --live');
    }
  } else {
    console.log('6) 跳过真实启停（加 --live 才跑）');
  }

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  process.exit(2);
});
