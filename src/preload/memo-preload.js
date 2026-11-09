'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memoAPI', {
  list: () => ipcRenderer.invoke('memo:list'),
  toggle: (id) => ipcRenderer.invoke('memo:toggle', id),
  remove: (id) => ipcRenderer.invoke('memo:remove', id),
  clearDone: () => ipcRenderer.invoke('memo:clear-done'),
  refresh: () => ipcRenderer.invoke('memo:refresh'),
  openDatabase: () => ipcRenderer.invoke('memo:open-database'),
  close: () => ipcRenderer.invoke('memo:close')
});
