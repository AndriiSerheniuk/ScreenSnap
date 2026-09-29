'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** The renderer never touches Node or spawns anything — it only calls these. */
contextBridge.exposeInMainWorld('api', {
  listDevices: () => ipcRenderer.invoke('devices:list'),
  toolStatus: () => ipcRenderer.invoke('devices:tools'),
  getVersion: () => ipcRenderer.invoke('app:version'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  chooseOutputDir: () => ipcRenderer.invoke('settings:chooseDir'),

  startRecording: (deviceId) => ipcRenderer.invoke('capture:start', deviceId),
  stopRecording: (deviceId) => ipcRenderer.invoke('capture:stop', deviceId),
  takeScreenshot: (deviceId) => ipcRenderer.invoke('capture:screenshot', deviceId),
  activeRecordings: () => ipcRenderer.invoke('capture:active'),

  fitWindowHeight: (contentHeight) => ipcRenderer.invoke('window:fit', contentHeight),

  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),

  revealInFinder: (filePath) => ipcRenderer.invoke('shell:reveal', filePath),
  openPath: (filePath) => ipcRenderer.invoke('shell:open', filePath),
});
