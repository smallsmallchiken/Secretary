'use strict';

const tools = require('./tools');

/**
 * OpenAI 兼容接口客户端（DeepSeek / OpenAI / 通义 / Kimi / 本地 Ollama 都能用）。
 * 走 function calling：模型只负责决定调哪个工具和参数，真正执行在本地。
 *
 * 系统提示词不在这里——由 `persona.js` 按用户配置的性格和格式要求生成。
 */

async function chat({ messages, config, temperature = 0.3, allowTools = true }) {
  const baseUrl = (config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

  const body = {
    model: config.model || 'deepseek-chat',
    messages,
    temperature
  };
  if (allowTools) {
    body.tools = tools.toOpenAITools();
    body.tool_choice = 'auto';
  }

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

module.exports = { chat };
