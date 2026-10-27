'use strict';

const apps = require('./apps');
const media = require('./media');
const system = require('./system');
const reminder = require('./reminder');
const wechat = require('./wechat');
const config = require('../config');

/**
 * 工具注册表。
 * 同一份定义同时供「本地规则引擎」和「LLM function calling」使用，
 * 保证两条路径的行为完全一致。
 */

const TOOLS = [
  {
    name: 'open_app',
    label: '打开应用',
    description: '在电脑上打开一个应用程序，比如网易云音乐、微信、Chrome、记事本、计算器、VS Code。',
    parameters: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: '应用名称，例如「网易云音乐」「微信」「Chrome」' }
      },
      required: ['app_name']
    },
    async run({ app_name }) {
      // 用户可以在配置的 appAliases 里写死路径，优先级最高
      // 形如 { "网易云": "D:\\software\\restore-app\\CloudMusic\\cloudmusic.exe" }
      const aliases = config.get('appAliases', {}) || {};
      return apps.openApp(app_name, aliases);
    }
  },
  {
    name: 'media_control',
    label: '媒体控制',
    description: '控制当前正在播放的媒体，包括播放、暂停、切歌、调音量、静音。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['toggle', 'play', 'pause', 'next', 'prev', 'stop', 'mute', 'volume_up', 'volume_down'],
          description: 'toggle=播放/暂停切换，next=下一首，prev=上一首，mute=静音切换'
        }
      },
      required: ['action']
    },
    async run({ action }) {
      return media.control(action);
    }
  },
  {
    name: 'get_time',
    label: '查询时间',
    description: '获取当前的日期、星期和具体时间。',
    parameters: { type: 'object', properties: {} },
    async run() {
      return system.run('time');
    }
  },
  {
    name: 'web_search',
    label: '网页搜索',
    description: '在浏览器里搜索一个关键词或问题。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query']
    },
    async run({ query }) {
      return system.run('search', { query });
    }
  },
  {
    name: 'open_url',
    label: '打开网址',
    description: '在默认浏览器中打开一个具体的网址。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整 URL，包含 https://' } },
      required: ['url']
    },
    async run({ url }) {
      return system.run('open_url', { url });
    }
  },
  {
    name: 'open_path',
    label: '打开路径',
    description: '打开一个文件或文件夹路径。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '要打开的完整路径' } },
      required: ['path']
    },
    async run({ path }) {
      return system.run('open_path', { path });
    }
  },
  {
    name: 'clipboard_write',
    label: '写入剪贴板',
    description: '把一段文字复制到系统剪贴板，方便用户直接粘贴。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要复制的文字' } },
      required: ['text']
    },
    async run({ text }) {
      return system.run('clipboard_write', { text });
    }
  },
  {
    name: 'clipboard_read',
    label: '读取剪贴板',
    description: '读取当前系统剪贴板里的文字内容。',
    parameters: { type: 'object', properties: {} },
    async run() {
      return system.run('clipboard_read');
    }
  },
  {
    name: 'take_screenshot',
    label: '截图',
    description: '截取当前全屏并保存到桌面。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '可选的保存路径，不填就存桌面' } }
    },
    async run({ path }) {
      return system.run('screenshot', { path });
    }
  },
  {
    name: 'lock_screen',
    label: '锁屏',
    description: '立即锁定 Windows 屏幕。',
    parameters: { type: 'object', properties: {} },
    async run() {
      return system.run('lock');
    }
  },
  {
    name: 'set_reminder',
    label: '设置提醒',
    description: '在指定时间提醒用户做某件事，到点会弹系统通知并且桌宠会跳出来。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒的内容，例如「喝水」「开会」' },
        at: {
          type: 'string',
          description: '提醒时间，必须是包含完整日期的 ISO 8601 本地时间，例如 2026-11-05T15:00:00，不要只给时分'
        }
      },
      required: ['text', 'at']
    },
    async run({ text, at }) {
      return reminder.add(text, at);
    }
  },
  {
    name: 'list_reminders',
    label: '查看提醒',
    description: '列出所有还没到时间的提醒。',
    parameters: { type: 'object', properties: {} },
    async run() {
      const items = reminder.list();
      if (!items.length) return { ok: true, message: '现在没有待办的提醒' };
      const text = items.map((x) => `${x.local} ${x.text}`).join('；');
      return { ok: true, message: `你有 ${items.length} 条提醒：${text}`, data: items };
    }
  },
  {
    name: 'cancel_reminder',
    label: '取消提醒',
    description: '取消一条提醒，按 id 或按内容取消；清空全部必须显式传 all: true。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提醒 id' },
        text: { type: 'string', description: '提醒内容的关键词，取消所有包含它的提醒' },
        all: { type: 'boolean', description: '为 true 时清空全部提醒，必须用户明确要求' }
      }
    },
    async run({ id, text, all } = {}) {
      if (id) return reminder.cancel(id);
      if (text) return reminder.cancelByText(text);
      if (all) return reminder.clearAll();
      throw new Error('要取消哪一条？给我提醒 id 或内容；要清空全部请明确说「清空所有提醒」');
    }
  },
  {
    name: 'wechat_draft',
    label: '微信回复草稿',
    description:
      '帮用户准备好微信/QQ 的回复文案并复制到剪贴板。注意：不会自动发送，用户需要自己粘贴。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要回复的完整文案' },
        target: { type: 'string', description: '回复对象的名字，可选' }
      },
      required: ['content']
    },
    async run({ content, target }) {
      return wechat.prepare(content, { target });
    }
  }
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

function get(name) {
  return byName.get(name);
}

/** 转成 OpenAI 兼容的 tools 定义 */
function toOpenAITools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

async function execute(name, args) {
  const tool = get(name);
  if (!tool) throw new Error(`没有这个能力：${name}`);
  return tool.run(args || {});
}

module.exports = { TOOLS, get, execute, toOpenAITools };
