'use strict';

// 工具层（开应用 / 剪贴板 / 截图…）全部依赖 electron 的 API，纯 Node 环境下
// require 就会 MODULE_NOT_FOUND。**服务器上的 QQ 值守就是纯 Node**（不需要任何
// 本地工具），所以这里容错加载：拿不到就当没有工具，只做普通对话。
let tools = null;
try {
  tools = require('./tools');
} catch (err) {
  tools = null;
}

/**
 * OpenAI 兼容接口客户端（DeepSeek / OpenAI / 通义 / Kimi / 本地 Ollama 都能用）。
 * 走 function calling：模型只负责决定调哪个工具和参数，真正执行在本地。
 *
 * 系统提示词不在这里——由 `persona.js` 按用户配置的性格和格式要求生成。
 */

async function chat({ messages, config, temperature = 0.3, allowTools = true, extra = null }) {
  const baseUrl = (config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

  const body = {
    model: config.model || 'deepseek-chat',
    messages,
    temperature
  };
  // 透传频率/存在惩罚等采样参数：聊天场景用它压「别得寸进尺」这类口头禅复读
  if (extra && typeof extra === 'object') {
    for (const k of ['top_p', 'frequency_penalty', 'presence_penalty', 'max_tokens']) {
      if (extra[k] !== undefined && extra[k] !== null) body[k] = extra[k];
    }
  }
  if (allowTools && tools) {
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
