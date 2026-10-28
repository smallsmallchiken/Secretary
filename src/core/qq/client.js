'use strict';

const WebSocket = require('ws');

/**
 * OneBot 11 正向 WebSocket 客户端（连 NapCat）。
 *
 * 职责单一：连接、重连、事件分发、API 调用（action/echo/响应配对）。
 * 不懂任何业务——白名单/限流/生成回复都在 bot.js。
 *
 * OneBot 11 协议要点：
 *   上行事件  { post_type: 'message', message_type: 'private', ... }
 *   API 调用  { action, params, echo }  ->  { status, retcode, data, echo }
 */

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const API_TIMEOUT_MS = 15000;

class OneBotClient {
  constructor({ url, token, onEvent, onStatus } = {}) {
    this.url = url || 'ws://127.0.0.1:3001';
    this.token = token || '';
    this.onEvent = onEvent || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.echoSeq = 0;
    this.pending = new Map(); // echo -> { resolve, reject, timer }
    this.reconnectTimer = null;
    this.stopped = true;
    this.selfId = null; // 登录的 QQ 号，登录后由 bot 层调 get_login_info 填
    this._fails = 0; // 连续重连失败次数，驱动指数退避
    this._lastFrameAt = 0; // 最后一帧（含心跳）时间，喂看门狗
    this._watchdog = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._stopWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('连接已关闭'));
    }
    this.pending.clear();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.selfId = null;
    this.onStatus('stopped');
  }

  get connected() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try {
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
      ws = new WebSocket(this.url, { headers });
    } catch (err) {
      this.onStatus('error', err.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('message', () => {
      this._lastFrameAt = Date.now();
    });
    ws.on('open', () => {
      this._lastFrameAt = Date.now();
      this._fails = 0;
      this.onStatus('connected');
    });

    ws.on('message', (raw) => {
      let payload;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        return; // 非 JSON 帧（比如心跳字符串），忽略
      }
      if (payload.echo) {
        const p = this.pending.get(payload.echo);
        if (p) {
          this.pending.delete(payload.echo);
          clearTimeout(p.timer);
          if (payload.retcode === 0) p.resolve(payload.data);
          else p.reject(new Error(`API ${payload.status || 'failed'} retcode=${payload.retcode}`));
        }
        return;
      }
      if (payload.post_type) {
        try {
          this.onEvent(payload);
        } catch (err) {
          // 事件处理抛错绝不能让连接崩掉
          this.onStatus('error', `事件处理异常: ${err.message}`);
        }
      }
    });

    ws.on('error', (err) => {
      if (!this.stopped) this.onStatus('error', err.message);
    });

    ws.on('close', () => {
      this._stopWatchdog();
      this.ws = null;
      if (!this.stopped) {
        this._fails++;
        this.onStatus('disconnected');
        this._scheduleReconnect();
      }
    });

    // 看门狗：NapCat 每隔几秒会推心跳，太久没任何帧说明连接已僵尸，
    // 主动掐掉触发重连（实测强杀 NapCat 时 close 事件可能不来）
    this._stopWatchdog();
    this._watchdog = setInterval(() => {
      if (this.stopped || !this.connected) return;
      if (Date.now() - this._lastFrameAt > 90000) {
        this.onStatus('error', '90 秒没有任何数据，判定连接僵尸化，强制重连');
        try {
          this.ws.terminate();
        } catch {
          /* close 兜底 */
        }
      }
    }, 30000);
  }

  _stopWatchdog() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, Math.min(4, this._fails)));
    this.onStatus('reconnecting', `${Math.round(delay / 1000)}s 后重试`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  /** 调 OneBot API。返回 data 字段。 */
  callApi(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('与 NapCat 的连接还没就绪'));
        return;
      }
      const echo = `pet-${++this.echoSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`API ${action} 超时`));
      }, API_TIMEOUT_MS);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  /** 便捷方法：发私聊文本消息 */
  sendPrivateText(userId, text) {
    return this.callApi('send_private_msg', {
      user_id: userId,
      message: [{ type: 'text', data: { text } }]
    });
  }

  /** 便捷方法：发群聊文本消息 */
  sendGroupText(groupId, text) {
    return this.callApi('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'text', data: { text } }]
    });
  }

  /** 登录信息（QQ 号 + 昵称） */
  getLoginInfo() {
    return this.callApi('get_login_info');
  }
}

module.exports = { OneBotClient };
