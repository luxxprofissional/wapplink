'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('zap', {
  ready: () => ipcRenderer.send('settings:ready'),
  close: () => ipcRenderer.send('settings:close'),
  mode: (mode) => ipcRenderer.send('settings:mode', mode),
  select: (id) => ipcRenderer.send('settings:select', id),
  togglePane: (id) => ipcRenderer.send('settings:toggle-pane', id),
  add: () => ipcRenderer.send('settings:add'),
  remove: (id) => ipcRenderer.send('settings:remove', id),
  reorder: (id, index) => ipcRenderer.send('settings:reorder', id, index),
  rename: (id, name) => ipcRenderer.send('settings:rename', id, name),
  color: (id, color) => ipcRenderer.send('settings:color', id, color),
  avatar: (id) => ipcRenderer.send('settings:avatar', id),
  avatarClear: (id) => ipcRenderer.send('settings:avatar-clear', id),
  reload: (id) => ipcRenderer.send('settings:reload', id),
  logout: (id) => ipcRenderer.send('settings:logout', id),
  closeToTray: (value) => ipcRenderer.send('settings:close-to-tray', value),
  listOnly: (value) => ipcRenderer.send('settings:list-only', value),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state))
})
