'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('zap', {
  ready: () => ipcRenderer.send('shell:ready'),
  select: (id) => ipcRenderer.send('shell:select', id),
  togglePane: (id) => ipcRenderer.send('shell:toggle-pane', id),
  settings: () => ipcRenderer.send('shell:settings'),
  gutterDown: (index) => ipcRenderer.send('gutter:down', index),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  onBadges: (cb) => ipcRenderer.on('badges', (_e, badges) => cb(badges)),
  onGutters: (cb) => ipcRenderer.on('gutters', (_e, gutters) => cb(gutters)),
  onFrames: (cb) => ipcRenderer.on('frames', (_e, frames) => cb(frames))
})
