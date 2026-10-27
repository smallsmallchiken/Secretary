'use strict';

const { tapVirtualKey } = require('./ps');

/** Windows 虚拟键码 */
const VK = {
  MEDIA_NEXT: 0xb0,
  MEDIA_PREV: 0xb1,
  MEDIA_STOP: 0xb2,
  MEDIA_PLAY_PAUSE: 0xb3,
  VOLUME_MUTE: 0xad,
  VOLUME_DOWN: 0xae,
  VOLUME_UP: 0xaf
};

/**
 * 媒体与音量控制。
 * 走系统级媒体键，所以对网易云音乐、QQ音乐、浏览器里的视频全都有效。
 */
async function control(action) {
  switch (action) {
    case 'play':
    case 'pause':
    case 'toggle':
      await tapVirtualKey(VK.MEDIA_PLAY_PAUSE);
      return { ok: true, message: '好，已切换播放/暂停' };
    case 'next':
      await tapVirtualKey(VK.MEDIA_NEXT);
      return { ok: true, message: '切到下一首了' };
    case 'prev':
    case 'previous':
      await tapVirtualKey(VK.MEDIA_PREV);
      return { ok: true, message: '退回上一首' };
    case 'stop':
      await tapVirtualKey(VK.MEDIA_STOP);
      return { ok: true, message: '停了' };
    case 'mute':
      await tapVirtualKey(VK.VOLUME_MUTE);
      return { ok: true, message: '已切换静音' };
    case 'volume_up':
      await tapVirtualKey(VK.VOLUME_UP, 5); // 每档 2%，5 档约 +10%
      return { ok: true, message: '音量调大了约 10%' };
    case 'volume_down':
      await tapVirtualKey(VK.VOLUME_DOWN, 5);
      return { ok: true, message: '音量调小了约 10%' };
    default:
      throw new Error(`不认识的媒体指令：${action}`);
  }
}

module.exports = { control, VK };
