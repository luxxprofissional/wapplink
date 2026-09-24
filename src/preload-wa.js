'use strict'
// Roda dentro de cada aba do WhatsApp Web. Faz duas coisas:
//  1. clique na notificacao nativa abre a conta certa;
//  2. em painel estreito, esconde a area de conversa vazia pra lista ocupar tudo.
const { ipcRenderer, webFrame } = require('electron')

// ---------------------------------------------------------------- notificacao

// O preload vive num mundo isolado, entao a pagina nao enxerga nada daqui.
// Patch da Notification precisa acontecer no mundo principal; a volta e
// pelo DOM, que os dois mundos compartilham.
try {
  webFrame.executeJavaScript(`
(() => {
  const Original = window.Notification
  if (!Original || Original.__zapbox) return
  const Patched = function (title, options) {
    const n = new Original(title, options)
    n.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('zapbox:notification-click'))
    })
    return n
  }
  Patched.__zapbox = true
  Patched.prototype = Original.prototype
  Object.defineProperty(Patched, 'permission', { get: () => Original.permission })
  Patched.requestPermission = (...a) => Original.requestPermission(...a)
  window.Notification = Patched
})()
`).catch(() => { /* pagina ainda sem contexto: nao e fatal */ })
} catch (err) {
  console.warn('ZapBox: nao consegui enganchar a notificacao -', err.message)
}

// ---------------------------------------------------------------- painel estreito

// Seletores mirando so em id estavel (#app, #side, #main) e na classe .two, que
// o WhatsApp mantem ha anos. As demais classes sao embaralhadas a cada build.
//  - .two carrega min-width: 748px, que e quem cria a barra de rolagem lateral;
//  - a coluna da lista e a div que contem #side;
//  - a area de conversa e a irma que vem depois dela;
//  - com uma conversa aberta (#main existe) nada e escondido.
const NARROW_CSS = `
#app .two { min-width: 0 !important; }

#app .two:not(:has(#main)) > div:has(#side) {
  flex: 1 1 auto !important;
  max-width: none !important;
}
#app .two:not(:has(#main)) > div:has(#side) ~ div {
  display: none !important;
}
`

const STYLE_ID = 'zapbox-narrow'
let wanted = false

function apply () {
  if (!document.head) return
  const existing = document.getElementById(STYLE_ID)
  if (wanted && !existing) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = NARROW_CSS
    document.head.appendChild(style)
  } else if (!wanted && existing) {
    existing.remove()
  }
}

ipcRenderer.on('zapbox:narrow', (_e, value) => {
  wanted = !!value
  apply()
})

document.addEventListener('zapbox:notification-click', () => {
  ipcRenderer.send('wa:notification-click')
})

// o WhatsApp e uma SPA: se ele reescrever o head, o estilo volta
document.addEventListener('DOMContentLoaded', () => {
  apply()
  new MutationObserver(apply).observe(document.head, { childList: true })
})
