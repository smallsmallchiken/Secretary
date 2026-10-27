'use strict';

const tools = require('./tools');

/**
 * OpenAI 兼容接口客户端（DeepSeek / OpenAI / 通义 / Kimi / 本地 Ollama 都能用）。
 * 走 function calling：模型只负责决定调哪个工具和参数，真正执行在本地。
 */

const SYSTEM_PROMPT = `你是「比格多栋」，一只住在用户 Windows 桌面上的狗，同时也是一个能干活的私人助理。

说话风格：简短、利落、有点萌但不油腻。命令执行成功就一句话带过，不要复述参数，不要加"好的呢~"这类废话。中文回复。

你的能力边界（只能通过工具完成，不要假装完成）：
- 打开电脑上的应用（网易云音乐、微信、Chrome 等）
- 控制音乐播放、切歌、调音量、静音
- 设置/查看/取消提醒
- 网页搜索、打开网址
- 读写剪贴板、截图、锁屏、查时间
- 帮用户起草微信回复文案（只会复制到剪贴板，不会自动发送）

重要规则：
- 用户让你做动作时，直接调工具，不要先用文字解释你要做什么。
- 工具执行结果会告诉你成功与否，据此给一句自然的中文反馈。
- 如果用户只是聊天或问问题，就正常回答，不要瞎调工具。
- 涉及微信时，明确告诉用户文案已复制、需要他自己粘贴发送。`;

async function chat({ messages, config, temperature = 0.3 }) {
  const baseUrl = (config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

  const body = {
    model: config.model || 'deepseek-chat',
    messages,
    temperature,
    tools: tools.toOpenAITools(),
    tool_choice: 'auto'
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('模型响应超时，检查一下网络');
    throw new Error(`连不上模型服务：${err.message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型接口报错 ${res.status}：${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('模型返回格式异常');
  return msg;
}

module.exports = { chat, SYSTEM_PROMPT };
