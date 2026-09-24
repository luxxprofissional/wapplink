'use strict'
// Camada transparente que so existe enquanto uma divisoria esta sendo arrastada.
// Ela fica por cima das contas justamente pra nao perder o mouse quando o
// ponteiro sai dos 8px da divisoria e entra em cima do WhatsApp.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('drag', {
  move: (x, y) => ipcRenderer.send('gutter:move', { x, y }),
  up: () => ipcRenderer.send('gutter:up')
})
