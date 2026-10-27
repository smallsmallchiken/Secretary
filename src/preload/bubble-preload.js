'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubbleAPI', {
  send: (text) => ipcRenderer.invoke('bubble:send', text),
  hide: (force = false) => ipcRenderer.invoke('bubble:hide', !!force),
  openExternal: (url) => ipcRenderer.invoke('bubble:open-external', url),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  configPath: () => ipcRenderer.invoke('config:path'),

  listReminders: () => ipcRenderer.invoke('reminder:list'),
  cancelReminder: (id) => ipcRenderer.invoke('reminder:cancel', id),

  appInfo: () => ipcRenderer.invoke('app:info'),
  quit: () => ipcRenderer.invoke('app:quit'),

  resize: (height) => ipcRenderer.invoke('bubble:resize', height),
  setMode: (mode) => ipcRenderer.invoke('bubble:mode', mode),

  onFocusInput: (cb) => ipcRenderer.on('bubble:focus-input', () => cb()),
  onPush: (cb) => ipcRenderer.on('bubble:push', (_e, payload) => cb(payload)),
  onOpenSettings: (cb) => ipcRenderer.on('bubble:open-settings', () => cb()),
  contextMenu: () => ipcRenderer.send('bubble:context-menu'),

  onLayout: (cb) => ipcRenderer.on('bubble:layout', (_e, payload) => cb(payload))
});
