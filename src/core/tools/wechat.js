'use strict';

const { clipboard } = require('electron');

/**
 * 微信/QQ 半自动回复。
 *
 * 我们刻意不做自动发送：个人微信没有开放 API，任何 hook / 协议库 / UI 自动化
 * 自动收发都违反用户协议，有封号风险。
 * 这里只负责「把话写好 -> 放剪贴板 -> 你切过去 Ctrl+V」，零风险且足够快。
 */
function prepare(text, options = {}) {
  const content = String(text || '').trim();
  if (!content) throw new Error('要回复什么内容？');

  clipboard.writeText(content);

  const who = options.target ? `给「${options.target}」的` : '';
  return {
    ok: true,
    message: `回复${who}文案已复制到剪贴板，切到微信窗口按 Ctrl+V 直接发送。`,
    data: { text: content, target: options.target || null }
  };
}

module.exports = { prepare };
