'use strict'
// Roda dentro de cada aba do WhatsApp Web. Faz quatro coisas:
//  1. clique na notificacao nativa abre a conta certa;
//  2. em painel estreito, esconde a area de conversa vazia pra lista ocupar tudo;
//  3. poe as contas do WappLink na coluna de icones do proprio WhatsApp, no vao
//     vazio entre o Meta AI e a Midia — e manda a cor dessa coluna pro main
//     pintar a barra de titulo igual;
//  4. poe "Transcrever" nas mensagens de voz (o texto sai do Whisper, no main).
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
  mountTranscriber()
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

// ---------------------------------------------------------------- transcricao

// O audio de voz so existe criptografado no servidor do WhatsApp; quem sabe
// baixar e abrir e o proprio codigo dele (modulos WAWebCollections e
// WAWebMediaInMemoryBlobCache — o mesmo caminho do whatsapp-web.js). Isso so
// e alcancavel no mundo principal, entao uma ponte la responde por
// postMessage. Baixar NAO marca o audio como ouvido nem a conversa como lida.
//
// Na tela, a bolha de voz e achada pelo que nao embaralha: a linha da mensagem
// tem data-id (o id curto da mensagem), o player e um role="slider" com
// aria-valuemax (duracao) e a hora fica em data-testid="msg-meta".
try {
  webFrame.executeJavaScript(`
(() => {
  if (window.__wapplinkAudio) return
  window.__wapplinkAudio = true
  addEventListener('message', async (e) => {
    const d = e.data
    if (!d || d.wapplink !== 'audio-req' || typeof d.id !== 'string') return
    const reply = (extra) => window.postMessage(Object.assign({ wapplink: 'audio-res', id: d.id }, extra), location.origin)
    try {
      const { Msg } = window.require('WAWebCollections')
      const msg = Msg.getModelsArray().find(m => m.id && m.id.id === d.id)
      if (!msg || (msg.type !== 'ptt' && msg.type !== 'audio')) return reply({ error: 'não achei esse áudio na conversa' })
      await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true })
      const stage = String((msg.mediaData && msg.mediaData.mediaStage) || '')
      if (stage.includes('ERROR') || stage === 'FETCHING') return reply({ error: 'o WhatsApp não entregou o áudio (' + stage + ')' })
      const obj = msg.mediaObject
      const blob = window.require('WAWebMediaInMemoryBlobCache').InMemoryMediaBlobCache.get(obj && obj.filehash) ||
        (obj && obj.mediaBlob && obj.mediaBlob.forceToBlob())
      if (!blob) return reply({ error: 'o WhatsApp não entregou o áudio' })
      reply({ data: await blob.arrayBuffer() })
    } catch (err) {
      reply({ error: 'o WhatsApp mudou por dentro (' + err.message + ')' })
    }
  })
})()
`).catch(() => { /* pagina ainda sem contexto: nao e fatal */ })
} catch (err) {
  console.warn('WappLink: nao consegui montar a ponte de audio -', err.message)
}

const MSG_ID = /^[A-Za-z0-9_-]{6,80}$/
const audioWaiting = new Map() // id -> { resolve, reject }

addEventListener('message', (e) => {
  const d = e.data
  if (!d || d.wapplink !== 'audio-res') return
  const p = audioWaiting.get(d.id)
  if (!p) return
  audioWaiting.delete(d.id)
  if (d.error) p.reject(new Error(d.error))
  else p.resolve(d.data)
})

function fetchAudio (id) {
  return new Promise((resolve, reject) => {
    audioWaiting.set(id, { resolve, reject })
    window.postMessage({ wapplink: 'audio-req', id }, location.origin)
    setTimeout(() => {
      if (audioWaiting.delete(id)) reject(new Error('o WhatsApp demorou demais pra entregar o áudio'))
    }, 60000)
  })
}

// ogg/opus -> WAV 16kHz mono 16 bits, que e o que o Whisper le. Quem decodifica
// e o proprio Chromium; o contexto em 16kHz ja devolve reamostrado.
async function toWav16k (data) {
  const ctx = new OfflineAudioContext(1, 1, 16000)
  const buf = await ctx.decodeAudioData(data)
  const n = buf.length
  const mono = new Float32Array(n)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c)
    for (let i = 0; i < n; i++) mono[i] += ch[i] / buf.numberOfChannels
  }

  const out = new DataView(new ArrayBuffer(44 + n * 2))
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true)
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true)
  str(36, 'data'); out.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]))
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(out.buffer)
}

// cor e fonte vem herdadas da bolha (o shadow root nao reseta), entao segue
// claro/escuro do WhatsApp sem nenhum ajuste nosso
const TR_CSS = `
:host { display: block; }
.box { margin: 4px 2px 2px; font-size: 13px; line-height: 18px; }
.text {
  font-size: 14.2px; line-height: 19px;
  white-space: pre-wrap; overflow-wrap: anywhere;
  -webkit-user-select: text; user-select: text; cursor: text;
}
.muted { opacity: .62; }
button {
  all: unset;
  cursor: pointer;
  opacity: .62;
  font-size: 13px;
}
button:hover { opacity: 1; text-decoration: underline; }
button:focus-visible { opacity: 1; text-decoration: underline; }
`

let trAvailable = false
const trState = new Map()        // id -> { phase: idle|busy|done|error, text, status }
const trRoots = new WeakMap()    // host -> shadow root

function mountTranscriber () {
  ipcRenderer.invoke('wa:transcribe-available').then((ok) => {
    trAvailable = !!ok
    if (!trAvailable) return
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      setTimeout(() => { pending = false; scanAudios() }, 250)
    }
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
    schedule()
  }).catch(() => { /* main sem o handler: segue sem transcricao */ })
}

function commonAncestor (a, b) {
  for (let el = a; el; el = el.parentElement) if (el.contains(b)) return el
  return null
}

function scanAudios () {
  const main = document.getElementById('main')
  if (!main) return
  for (const slider of main.querySelectorAll('[data-id] [role="slider"][aria-valuemax]')) {
    const row = slider.closest('[data-id]')
    const id = row.getAttribute('data-id')
    if (!MSG_ID.test(id) || row.querySelector('wapplink-transcricao')) continue
    const meta = row.querySelector('[data-testid="msg-meta"]')
    const spot = meta && commonAncestor(slider, meta)
    if (!spot || spot === row || !row.contains(spot)) continue

    const host = document.createElement('wapplink-transcricao')
    host.setAttribute('data-msg', id)
    const root = host.attachShadow({ mode: 'closed' })
    trRoots.set(host, root)
    // clique aqui nao e clique na mensagem (o WhatsApp abriria menu/selecao)
    for (const ev of ['click', 'mousedown', 'dblclick', 'contextmenu']) {
      host.addEventListener(ev, (e) => e.stopPropagation())
    }
    spot.appendChild(host)

    if (!trState.has(id)) {
      trState.set(id, { phase: 'idle' })
      ipcRenderer.invoke('wa:transcript-get', id).then((text) => {
        if (text && trState.get(id).phase === 'idle') setTr(id, { phase: 'done', text })
      }).catch(() => {})
    }
    renderTr(host)
  }
}

function setTr (id, st) {
  trState.set(id, st)
  for (const host of document.querySelectorAll('wapplink-transcricao')) {
    if (host.getAttribute('data-msg') === id) renderTr(host)
  }
}

function renderTr (host) {
  const root = trRoots.get(host)
  if (!root) return
  const id = host.getAttribute('data-msg')
  const st = trState.get(id) || { phase: 'idle' }
  root.textContent = ''
  const style = document.createElement('style')
  style.textContent = TR_CSS
  const box = document.createElement('div')
  box.className = 'box'
  root.append(style, box)

  const button = (label) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.addEventListener('click', () => startTranscription(id))
    return b
  }

  if (st.phase === 'idle') {
    box.appendChild(button('Transcrever'))
  } else if (st.phase === 'busy') {
    const s = document.createElement('span')
    s.className = 'muted'
    s.textContent = st.status || 'Transcrevendo…'
    box.appendChild(s)
  } else if (st.phase === 'done') {
    const t = document.createElement('div')
    t.className = st.text ? 'text' : 'muted'
    t.textContent = st.text || 'Nenhuma fala reconhecida.'
    box.appendChild(t)
  } else {
    const s = document.createElement('span')
    s.className = 'muted'
    s.textContent = 'Não deu pra transcrever: ' + st.status + '. '
    box.append(s, button('Tentar de novo'))
  }
}

async function startTranscription (id) {
  if ((trState.get(id) || {}).phase === 'busy') return
  setTr(id, { phase: 'busy', status: 'Baixando o áudio…' })
  try {
    const wav = await toWav16k(await fetchAudio(id))
    const text = await ipcRenderer.invoke('wa:transcribe', id, wav)
    setTr(id, { phase: 'done', text })
  } catch (err) {
    // o invoke embrulha a mensagem: "Error invoking remote method '...': Error: ..."
    const msg = String(err && err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    setTr(id, { phase: 'error', status: msg })
  }
}

ipcRenderer.on('wapp:transcribe-progress', (_e, id, status) => {
  if ((trState.get(id) || {}).phase === 'busy') setTr(id, { phase: 'busy', status })
})
