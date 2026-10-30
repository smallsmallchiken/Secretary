'use strict';

/**
 * 生成共享语音池的「预置片段」。
 *
 * 为什么值得做：这两句最常被说 —— 「嗯嗯」「晚安」—— 以前每次都要调一遍付费
 * TTS 接口，几十毫秒到几秒；现在合成一次存进 `.data/media/voice/`，QQ 和微信
 * 两边直接取现成的。常用短句命中率越高，省下的延迟和调用就越多。
 *
 * 只合成池子里还没有的，重复跑不会重复花钱。
 *
 * 用法：
 *   node tools/make-voice-presets.js            用当前配置的音色补齐默认清单
 *   node tools/make-voice-presets.js 晚安 "好耶"  只补指定的句子
 *   node tools/make-voice-presets.js --list     只看池子里已有啥
 */

const path = require('path');
const Module = require('module');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'electron-stub.js');

// 复用桌宠的配置与共享库；测试替身只为让 require('electron') 不炸
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB;
  return originalResolve.call(this, request, ...rest);
};

const config = require(path.join(ROOT, 'src/core/config'));
const media = require(path.join(ROOT, 'src/core/media/library'));

// 中性短句：两套人设都用得上（QQ 傲娇、微信温柔），不会被某一方显得奇怪
const DEFAULTS = [
  '嗯嗯', '哈哈', '好的', '在呢', '晚安',
  '早上好', '收到', '笑死', '好耶', '有点困了',
  '我先溜了', '想你了', '谢谢', '对不起嘛', '你说啥',
  '真的假的', '好无聊', '在忙', '吃饭了吗', '我去了'
];

function ttsCfg() {
  const q = config.get('qq') || {};
  return {
    model: q.ttsModel || 'FunAudioLLM/CosyVoice2-0.5B',
    voice: q.ttsVoice || 'speech:taffy:db3jflecnncc73bu1s30:sjbobdkyjemcbssubaqo'
  };
}

function audioBase(baseUrl, tail) {
  const base = String(baseUrl || 'https://api.siliconflow.cn').replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}${tail}` : `${base}/v1${tail}`;
}

async function synth(text, llmCfg, voice, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    const res = await fetch(audioBase(llmCfg.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmCfg.apiKey}` },
      body: JSON.stringify({ model, input: text, voice, response_format: 'mp3' }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    const presets = media.listPresets();
    console.log(`共享语音池：${media.stats().root}`);
    console.log(`预置片段 ${presets.length} 条：`);
    for (const p of presets) console.log(`  ${p.text}  ->  ${p.id}`);
    return;
  }

  const { model, voice } = ttsCfg();
  const llmCfg = config.getLLM();
  if (!llmCfg || !llmCfg.apiKey) {
    console.error('没有配置 API Key，读 .data/config.json 的 llm.apiKey');
    process.exit(1);
  }

  const wanted = args.filter((a) => !a.startsWith('--'));
  const list = wanted.length ? wanted : DEFAULTS;
  console.log(`音色：${voice}`);
  console.log(`模型：${model}`);
  console.log(`目标：${list.length} 条\n`);

  let made = 0;
  let cached = 0;
  let failed = 0;
  for (const text of list) {
    const exist = media.findVoice(text, voice, model);
    if (exist) {
      cached += 1;
      console.log(`  已有  ${text}`);
      continue;
    }
    try {
      const buf = await synth(text, llmCfg, voice, model);
      const saved = media.putVoice(buf, {
        text,
        voice,
        model,
        kind: 'preset',
        from: 'preset',
        desc: ''
      });
      if (!saved) throw new Error('写库失败');
      made += 1;
      console.log(`  合成  ${text}  (${Math.round(buf.length / 1024)} KB)`);
    } catch (err) {
      failed += 1;
      console.log(`  失败  ${text}  -> ${err.message}`);
    }
  }

  const st = media.stats();
  console.log(`\n新合成 ${made} 条，已有 ${cached} 条，失败 ${failed} 条`);
  console.log(`池子现状：图片 ${st.pics} 张（表情包 ${st.stickers}），语音 ${st.voice} 段（预置 ${st.presets}）`);
  if (failed && !made) process.exit(1);
})().catch((err) => {
  console.error('异常：', err);
  process.exit(2);
});
