'use strict'
// Roda dentro de cada aba do WhatsApp Web. Faz tres coisas:
//  1. clique na notificacao nativa abre a conta certa;
//  2. em painel estreito, esconde a area de conversa vazia pra lista ocupar tudo;
//  3. poe as contas do WappLink na coluna de icones do proprio WhatsApp, no vao
//     vazio entre o Meta AI e a Midia — e manda a cor dessa coluna pro main
//     pintar a barra de titulo igual.
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
  mountSwitcher()
})

// ---------------------------------------------------------------- contas na coluna

// A coluna de icones do WhatsApp e um <header> de 64px com a altura toda; os
// botoes tem 40x40 a cada 44px. As classes sao embaralhadas, entao nada aqui
// depende delas: acha o header pela forma e o vao pelo maior buraco entre botoes.
//
// O seletor vive num shadow root pendurado no <html>, fora do #app: o React do
// WhatsApp nao apaga, e o CSS de um lado nao vaza pro outro.

const SWITCHER_CSS = `
:host { all: initial; }
.box {
  position: fixed;
  z-index: 2147483000;
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  overflow-y: auto;
  scrollbar-width: none;
  font-family: "Roboto Variable", Roboto, "Segoe UI", "Helvetica Neue", sans-serif;
  -webkit-user-select: none;
}
.box.show { display: flex; }
.box::-webkit-scrollbar { width: 0; }

/* sem coluna (tela do QR, carregando): cartao discreto no canto */
.box.float {
  padding: 8px 6px;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: var(--bg);
}

hr {
  flex: 0 0 auto;
  width: 40px;
  margin: 0 0 8px;
  border: 0;
  border-top: 1px solid var(--line);
}
.box.float hr { display: none; }

button {
  position: relative;
  flex: 0 0 auto;
  width: 40px; height: 40px;
  padding: 0; border: 0;
  border-radius: 9999px;
  background: transparent;
  color: var(--icon);
  display: grid; place-items: center;
  cursor: pointer;
  outline: none;
}
button:hover { background: var(--hover); }
button:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
button.active { background: var(--selected); }

.pic {
  width: 28px; height: 28px;
  border-radius: 50%;
  background: center / cover no-repeat;
  display: grid; place-items: center;
  color: #fff;
  font-size: 11px; font-weight: 600; letter-spacing: .3px;
}
.pic.photo span { display: none; }

/* na tela dividida sem ser a focada: so um aro fino */
button.on:not(.active) .pic { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3px var(--ring); }

.badge {
  position: absolute;
  top: -6px; right: -6px;
  min-width: 24px; height: 24px;
  padding: 2px;
  box-sizing: border-box;
  border-radius: 9999px;
  border: 2px solid var(--bg);
  background: #1daa61;
  color: #fff;
  font-size: 12px; font-weight: 545; line-height: 16px;
  text-align: center;
  display: none;
}
.badge.show { display: block; }
.badge.wide { padding: 2px 5px; }

.settings { margin-top: 4px; }
`

// iconezinho de ajustes no mesmo traco dos icones do WhatsApp
const SLIDERS_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
  '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>'

let sw = null          // { host, box }
let swState = null     // o que o main mandou: { show, accounts, mod }
let lastTheme = ''

const initials = (name) => {
  const parts = String(name || '?').trim().split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase()
}

function parseRgb (css) {
  const m = /rgba?\(([^)]+)\)/.exec(css || '')
  if (!m) return null
  const [r, g, b, a = 1] = m[1].split(',').map(Number)
  return a === 0 ? null : [r, g, b]
}

// primeira cor de fundo opaca subindo a partir do elemento
function solidBg (el) {
  for (; el && el !== document.documentElement; el = el.parentElement) {
    const rgb = parseRgb(getComputedStyle(el).backgroundColor)
    if (rgb) return rgb
  }
  return [255, 255, 255]
}

function findNav () {
  for (const h of document.querySelectorAll('#app header')) {
    const r = h.getBoundingClientRect()
    if (r.left < 4 && r.width > 40 && r.width < 100 && r.height > 300) return h
  }
  return null
}

function mountSwitcher () {
  if (sw) return
  const host = document.createElement('wapplink-contas')
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = SWITCHER_CSS
  const box = document.createElement('div')
  box.className = 'box'
  root.append(style, box)
  document.documentElement.appendChild(host)
  sw = { host, box }

  // a coluna muda de tamanho com a janela e o WhatsApp remonta tudo quando
  // loga/desloga — reposiciona por observacao, com uma rede de seguranca
  // o WhatsApp muta o DOM sem parar (e as 3+ contas rodam em segundo plano):
  // no maximo uma medicao a cada 150ms
  let pending = false
  const schedule = () => {
    if (pending) return
    pending = true
    setTimeout(() => { pending = false; place() }, 150)
  }
  addEventListener('resize', schedule)
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
  setInterval(schedule, 1500)

  render()
  schedule()
}

function place () {
  if (!sw) return
  const { box } = sw
  const nav = findNav()
  const rgb = nav ? solidBg(nav) : solidBg(document.querySelector('#app') || document.body)
  const dark = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) < 128
  const bg = `rgb(${rgb.join(',')})`

  const theme = bg + (dark ? '|d' : '|l')
  if (theme !== lastTheme) {
    lastTheme = theme
    ipcRenderer.send('wa:theme', { bg, dark })
    const ink = dark ? '255,255,255' : '0,0,0'
    box.style.setProperty('--bg', bg)
    box.style.setProperty('--icon', `rgba(${ink},.6)`)
    box.style.setProperty('--line', `rgba(${ink},.1)`)
    box.style.setProperty('--hover', `rgba(${ink},.06)`)
    box.style.setProperty('--selected', `rgba(${ink},.1)`)
    box.style.setProperty('--ring', `rgba(${ink},.35)`)
    box.style.setProperty('--accent', '#1daa61')
  }

  if (!swState || !swState.show) { box.classList.remove('show'); return }

  if (nav) {
    // o vao e o maior buraco vertical entre dois botoes da coluna
    const btns = [...nav.querySelectorAll('button')]
      .map(b => b.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0)
      .sort((a, b) => a.top - b.top)
    let top = 0, bottom = 0, gap = -1, left = 12
    for (let i = 0; i + 1 < btns.length; i++) {
      const g = btns[i + 1].top - btns[i].bottom
      if (g > gap) { gap = g; top = btns[i].bottom; bottom = btns[i + 1].top; left = btns[i].left }
    }
    if (gap > 60) {
      box.classList.remove('float')
      box.style.left = left + 'px'
      box.style.top = (top + 12) + 'px'
      box.style.maxHeight = Math.max(0, bottom - top - 24) + 'px'
      box.classList.add('show')
      return
    }
  }

  box.classList.add('float', 'show')
  box.style.left = '12px'
  box.style.top = '12px'
  box.style.maxHeight = 'calc(100vh - 24px)'
}

function render () {
  if (!sw) return
  const { box } = sw
  box.textContent = ''
  if (!swState) return

  box.appendChild(document.createElement('hr'))

  swState.accounts.forEach((acc, i) => {
    const b = document.createElement('button')
    b.className = (acc.active ? 'active' : '') + (acc.onScreen ? ' on' : '')
    const n = i + 1
    b.title = acc.name + (n <= 9 ? `  (${swState.mod}+${n})` : '') +
      (swState.split ? `\n${swState.mod}+clique: pôr/tirar da tela` : '')

    const pic = document.createElement('span')
    pic.className = 'pic' + (acc.avatar ? ' photo' : '')
    if (acc.avatar) pic.style.backgroundImage = `url("${acc.avatar}")`
    else pic.style.backgroundColor = acc.color
    const txt = document.createElement('span')
    txt.textContent = initials(acc.name)
    pic.appendChild(txt)
    b.appendChild(pic)

    const badge = document.createElement('span')
    const count = acc.badge || 0
    badge.className = 'badge' + (count ? ' show' : '') + (count > 9 ? ' wide' : '')
    badge.textContent = count > 99 ? '99+' : String(count)
    b.appendChild(badge)

    b.addEventListener('click', (e) => {
      ipcRenderer.send((e.ctrlKey || e.metaKey) ? 'wa:toggle' : 'wa:select', acc.id)
    })
    box.appendChild(b)
  })

  const s = document.createElement('button')
  s.className = 'settings'
  s.title = `Contas e tela  (${swState.mod}+,)`
  s.innerHTML = SLIDERS_SVG
  s.addEventListener('click', () => ipcRenderer.send('wa:settings'))
  box.appendChild(s)

  place()
}

ipcRenderer.on('wapp:switcher', (_e, state) => {
  swState = state
  if (state.reportTheme) lastTheme = '' // forca reenviar a cor no proximo place()
  render()
})
