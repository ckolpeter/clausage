'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  i18n: () => ipcRenderer.invoke('i18n'),
  // 小工具
  getState: () => ipcRenderer.invoke('get-state'),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, state, opts) => cb(state, opts)),
  refresh: () => ipcRenderer.send('refresh'),
  login: () => ipcRenderer.send('login'),
  openSettings: () => ipcRenderer.send('open-settings'),
  openHistory: () => ipcRenderer.send('open-history'),
  openIssue: () => ipcRenderer.send('open-issue'),
  history: {
    get: () => ipcRenderer.invoke('history:get'),
    clear: () => ipcRenderer.invoke('history:clear'),
    exportCSV: () => ipcRenderer.invoke('history:export'),
  },
  hide: () => ipcRenderer.send('hide'),
  contextMenu: () => ipcRenderer.send('context-menu'),
  toggleCompact: () => ipcRenderer.send('toggle-compact'),
  resize: (h) => ipcRenderer.send('resize', h),
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: () => ipcRenderer.send('accounts:add'),
    login: (part) => ipcRenderer.send('accounts:login', part),
    remove: (part) => ipcRenderer.invoke('accounts:remove', part),
  },
  // 設定視窗
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    setSessionKey: (k) => ipcRenderer.invoke('settings:session-key', k),
    listOrgs: () => ipcRenderer.invoke('settings:list-orgs'),
    login: () => ipcRenderer.send('settings:login'),
    logout: () => ipcRenderer.send('settings:logout'),
  },
});
