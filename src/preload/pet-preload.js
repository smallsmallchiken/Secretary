'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  click: () => ipcRenderer.send('pet:click'),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragMove: () => ipcRenderer.send('pet:drag-move'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  contextMenu: () => ipcRenderer.send('pet:context-menu'),

  onState: (cb) => ipcRenderer.on('pet:state', (_e, payload) => cb(payload)),
  onConfig: (cb) => ipcRenderer.on('pet:config', (_e, payload) => cb(payload)),
  onWander: (cb) => ipcRenderer.on('pet:wander', (_e, payload) => cb(payload)),

  getConfig: () => ipcRenderer.invoke('config:get')
});
