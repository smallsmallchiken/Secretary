'use strict';

/**
 * 情境注入：把「每轮对话都在变的事实」拼成一段，插到系统提示词后面。
 *
 * 为什么单独一个模块：persona（性格）只在配置变化时重建，而时间/待办数/
 * 最近的记事每次对话都不同。拼成独立的第二条 system 消息，persona 不用动，
 * 测试也好写。
 *
 * 注入什么：
 *   1. 当前时间（日期 + 星期 + 时分）——「明天提醒我」「今天星期几」这类问题
 *      模型直接就知道，不用再调 get_time 工具浪费一轮。
 *   2. 备忘录未完成数——用户问「我今天有什么事」能答上，干完活可以顺嘴提。
 *   3. 用户记过的事（最近几条未完成的）——「我之前让你记的…」聊天里能自然
 *      接上，而不是每次都要走 recall 工具查一遍。
 *
 * 任何一块取不到都静默跳过：情境是锦上添花，绝不能因为它把对话搞挂。
 */

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function pad(n) {
  return String(n).padStart(2, '0');
}

function build() {
  const parts = [];

  // 1) 当前时间
  try {
    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    parts.push(`当前时间：${date} 星期${WEEK[now.getDay()]} ${hm}`);
  } catch {
    /* Date 不可能抛，防御性保留 */
  }

  // 2) 备忘录待办数
  try {
    const memo = require('./memo');
    const s = memo.stats();
    if (s.open > 0) {
      parts.push(`备忘录：还有 ${s.open} 条未完成待办。用户问「我今天有什么事」时先答这个；平时不要主动罗列。`);
    }
  } catch {
    /* 备忘录取不到不挡对话 */
  }

  // 3) 用户记过的事（优先未完成的，最多 5 条）
  try {
    const notes = require('./tools/notes');
    let rows = notes.query({ undone: true, limit: 5 });
    if (!rows.length) rows = notes.query({ limit: 3 });
    if (rows.length) {
      const items = rows.map((r) => `- ${String(r.text || '').slice(0, 40)}`).join('\n');
      parts.push(
        `用户交代你记过的事（最近几条）：\n${items}\n` +
          '聊天里自然用上；用户问起时直接答，不要说「我帮你查查」。'
      );
    }
  } catch {
    /* 记事取不到不挡对话 */
  }

  if (!parts.length) return '';
  return `当前情境（每小时都会刷新，回答时以此为准）：\n${parts.join('\n')}`;
}

module.exports = { build };
