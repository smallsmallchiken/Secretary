'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

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
    toggle: 'Control+Shift+Space'
  },
  autoLaunch: false,
  // 常用应用别名，用户可自行补充
  appAliases: {}
};

let cache = null;
let configPath = null;

function resolveConfigPath() {
  if (configPath) return configPath;
  const base = app.isPackaged
    ? app.getPath('userData')
    : path.join(app.getAppPath(), '.data');
  fs.mkdirSync(base, { recursive: true });
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

module.exports = { get, set, getAll, save, DEFAULT_CONFIG };
