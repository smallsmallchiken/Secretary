#!/usr/bin/env node
'use strict';

/**
 * 服务器端 QQ 值守入口（**不需要 Electron**）。
 *
 * 本地那套是桌宠进程里跑的（main.js 调 qqbot.init），Windows 上还顺带负责拉 NapCat。
 * 迁到 Linux 服务器之后这两个前提都没了：
 *   - 没有 Electron，只有 node
 *   - NapCat 已经在 docker 里跑着，WS 直接连 127.0.0.1:3001，不用谁去拉
 *
 * 所以这里只做三件事：确定数据目录、把收发结果打到日志、收到信号时干净退出
 * （容器/systemd 停我们要能立刻断开，不然 NapCat 那边会留一个僵尸连接）。
 *
 * 用法：
 *   PET_DATA_DIR=/opt/secretary/.data node server/qq-bot.js
 *   node server/qq-bot.js --check     # 只校验配置和 WS 可达性，不进入值守
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// 必须先于任何 require('../src/...') —— config/paths 是第一层被读的模块，
// 它们按 PET_DATA_DIR 决定配置写在哪儿。
if (!process.env.PET_DATA_DIR) process.env.PET_DATA_DIR = path.join(ROOT, '.data');

const config = require('../src/core/config');
const qqbot = require('../src/core/qq/bot');
const { dataDir } = require('../src/core/paths');
const { dbg } = require('../src/core/debug');

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function say(line) {
  process.stdout.write(`[${stamp()}] ${line}\n`);
}

function cfg() {
  const qq = config.get('qq', {}) || {};
  return {
    enabled: qq.enabled === true,
    wsUrl: qq.wsUrl || '',
    token: qq.token ? '已配置' : '空',
    allFriends: !!qq.allFriends,
    whitelist: Array.isArray(qq.whitelist) ? qq.whitelist.length : 0,
    voiceReply: !!qq.voiceReply,
    memes: !!qq.memes
  };
}

async function check() {
  const data = dataDir();
  say(`数据目录 ${data}`);
  say(`这份配置 ${path.join(data, 'config.json')}`);
  const c = cfg();
  say(`qq.enabled=${c.enabled} ws=${c.wsUrl} token=${c.token}`);
  say(`回复范围 allFriends=${c.allFriends} 白名单=${c.whitelist} ` +
      `语音=${c.voiceReply} 表情=${c.memes}`);

  const llmCfg = config.getLLM();
  say(`LLM ${llmCfg.enabled ? '已启用' : '未启用'} ${llmCfg.baseUrl || ''} ${llmCfg.model || ''}`);

  // 试一次 WS 握手（用 client 里的实现，和真值守走同一条路）
  const { OneBotClient } = require('../src/core/qq/client');
  const code = await new Promise((resolve) => {
    let done = false;
    const finish = (text, rc) => {
      if (done) return;
      done = true;
      say(text);
      try {
        client.stop();
      } catch {
        /* ignore */
      }
      resolve(rc);
    };
    const client = new OneBotClient({
      url: c.wsUrl,
      token: config.get('qq.token', ''),
      onStatus: (kind, detail) => {
        if (kind === 'connected') finish('WS 握手成功（NapCat 在，能收发）', 0);
        else if (kind === 'error') finish(`WS 连不上：${detail}`, 1);
      },
      onEvent: () => {}
    });
    setTimeout(() => finish('WS 握手超时（8s）', 2), 8000);
    try {
      client.start();
    } catch (err) {
      finish(`WS 建连失败：${err.message}`, 1);
    }
  });

  return code;
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  say(`=== qq-bot 启动 ${checkOnly ? '(check)' : ''} ===`);
  say(`node ${process.version} / ${process.platform} / 数据目录 ${dataDir()}`);

  if (!fs.existsSync(path.join(dataDir(), 'config.json'))) {
    say('⚠ 没有 config.json，先放一份（参考 config.example.json）');
  }

  if (checkOnly) {
    const code = await check();
    process.exit(code);
  }

  if (!cfg().enabled) {
    say('qq.enabled=false —— 值守没开，退出。要开就去 .data/config.json 里改。');
    process.exit(0);
  }

  // 收发播报：本地那套是弹气泡，服务器上就是日志
  qqbot.init((text) => {
    say(`[播报] ${text}`);
  });

  const st = qqbot.status();
  say(`值守中：${config.get('qq.wsUrl', '')} 白名单 ${(st.whitelist || []).length} 条`);

  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    say(`收到 ${sig}，断开连接`);
    try {
      qqbot.shutdown();
    } catch (err) {
      dbg('[qq-bot] shutdown 异常：', err.message);
    }
    // 给 ws 一点时间发 close 帧，别拖太久
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  // 主进程别因为一个意外 rejection 就悄悄退出（值守没人看着）
  process.on('unhandledRejection', (err) => {
    dbg('[qq-bot] unhandledRejection:', err && (err.stack || err.message || err));
  });
  process.on('uncaughtException', (err) => {
    dbg('[qq-bot] uncaughtException:', err && (err.stack || err.message || err));
    say(`异常：${err && err.message}`);
  });
}

main().catch((err) => {
  say(`启动失败：${err && (err.stack || err.message)}`);
  process.exit(1);
});
