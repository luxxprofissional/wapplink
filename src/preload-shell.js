'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('zap', {
  ready: () => ipcRenderer.send('shell:ready'),
  gutterDown: (index) => ipcRenderer.send('gutter:down', index),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  onGutters: (cb) => ipcRenderer.on('gutters', (_e, gutters) => cb(gutters))
})
