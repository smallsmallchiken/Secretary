'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

/**
 * 配置持久化。
 * 开发态写到项目内的 .data/config.json（遵守"所有产出一律放工作区"的约定）；
 * 打包后写到系统标准的 userData 目录。
 */

const DEFAULT_CONFIG = {
  // LLM（可选）。留空则走内置本地规则引擎，开箱即用。
  llm: {
    enabled: false,
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat'
  },
  pet: {
    scale: 0.85,
    // 右下角停靠
    anchor: 'bottom-right',
    marginRight: 40,
    marginBottom: 72
  },
  behavior: {
    // 待机时自动切换小动作
    autoIdle: true,
    // 是否允许宠物自己溜达
    allowWander: true
  },
  shortcuts: {
    // 和桌宠对话
    toggle: 'Alt+W',
    // 显示 / 隐藏桌宠（不退出进程）
    petToggle: 'Alt+Q',
    // 放大 / 缩小桌宠
    scaleUp: 'Alt+Up',
    scaleDown: 'Alt+Down'
  },
  autoLaunch: false,
  // 性格与回复格式
  persona: {
    // 预设：黏人 / 利落 / 损友 / 元气
    preset: '黏人',
    // 回复长度：short / normal / detailed
    length: 'short',
    // 是否允许 emoji（气泡是纯文本渲染）
    emoji: false,
    // 桌宠自称
    name: '比格多栋',
    // 非空时覆盖预设的性格描述，完全自定义
    custom: '',
    // 额外的补充要求，比如口头禅
    signature: ''
  },
  // 常用应用别名，用户可自行补充
  appAliases: {},
  // QQ 自动回复（连 NapCat 协议端）。白名单为空时即使开关打开也不会回复任何人
  qq: {
    enabled: false,
    wsUrl: 'ws://127.0.0.1:3001',
    token: '',
    whitelist: [],
    perChatIntervalSeconds: 20,
    maxConsecutive: 3,
    maxPerHour: 20,
    dedupeWindowSeconds: 60
  }
};

let cache = null;
let configPath = null;

function resolveConfigPath() {
  if (configPath) return configPath;
  const base = dataDir();
  configPath = path.join(base, 'config.json');
  return configPath;
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  const p = resolveConfigPath();
  let onDisk = {};
  try {
    if (fs.existsSync(p)) {
      onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (err) {
    console.error('[config] 读取失败，使用默认配置：', err.message);
  }
  cache = deepMerge(DEFAULT_CONFIG, onDisk);
  return cache;
}

function save() {
  const p = resolveConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
  return p;
}

function get(keyPath, fallback) {
  const cfg = load();
  if (!keyPath) return cfg;
  return keyPath.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), cfg) ?? fallback;
}

function set(patch) {
  load();
  cache = deepMerge(cache, patch);
  save();
  return cache;
}

function getAll() {
  return load();
}

/** 模型配置。允许用环境变量 PET_LLM_API_KEY 覆盖 Key，避免明文写进配置文件 */
function getLLM() {
  const llm = { ...get('llm', {}) };
  const envKey = process.env.PET_LLM_API_KEY;
  if (envKey) llm.apiKey = envKey;
  return llm;
}

module.exports = { get, set, getAll, getLLM, save, DEFAULT_CONFIG };
