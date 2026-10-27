'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuAPI', {
  onRender: (cb) => ipcRenderer.on('menu:render', (_e, items) => cb(items)),
  pick: (id) => ipcRenderer.send('menu:pick', id),
  close: () => ipcRenderer.send('menu:close'),
  resize: (width, height) => ipcRenderer.send('menu:resize', { width, height })
});
