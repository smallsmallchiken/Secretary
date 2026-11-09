'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mediaAPI', {
  list: (opts) => ipcRenderer.invoke('media:list', opts || {}),
  sync: () => ipcRenderer.invoke('media:sync'),
  openDir: () => ipcRenderer.invoke('media:open-dir'),
  close: () => ipcRenderer.invoke('media:close')
});
