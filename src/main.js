'use strict'

const {
  app, BrowserWindow, WebContentsView, session, Menu, Tray,
  shell, ipcMain, dialog, nativeImage, screen
} = require('electron')
const path = require('path')
const fs = require('fs')
const updater = require('./updater')

const APP_ID = 'com.luxx.zapbox'
const WA_URL = 'https://web.whatsapp.com/'
const RAIL = 72        // largura da coluna de contas
const GUTTER = 8       // espessura da divisoria entre paineis
const FRAME = 3        // moldura colorida em volta de cada painel dividido
const NARROW = 760     // abaixo disso o painel esconde a area de conversa vazia
const MIN_PANE = 260   // menor largura/altura util de um painel
const MAX_ACCOUNTS = 8 // teto por causa de RAM: cada conta e um WhatsApp Web inteiro

const IS_MAC = process.platform === 'darwin'

// O app se chamava ZapBox. Quem ja tem a pasta antiga continua nela — e la que
// estao as sessoes do WhatsApp, as contas e as fotos. Instalacao nova usa WappLink.
const legacyData = path.join(app.getPath('appData'), 'ZapBox')
if (!app.commandLine.hasSwitch('user-data-dir') && fs.existsSync(legacyData)) {
  app.setPath('userData', legacyData)
}

// so existe no Windows; no macOS a funcao nem esta definida
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

// UA limpo: WhatsApp Web nao gosta de token "Electron" na string.
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${process.versions.chrome} Safari/537.36`

// ---------------------------------------------------------------- config

const DEFAULTS = {
  accounts: [
    { id: 'conta-1', name: 'Conta 1', color: '#5b8def' },
    { id: 'conta-2', name: 'Conta 2', color: '#2fa15f' },
    { id: 'conta-3', name: 'Conta 3', color: '#c98a3b' }
  ],
  activeId: 'conta-1',
  layout: { mode: 'focus', panes: ['conta-1'], sizes: [1] },
  listOnly: true,   // painel estreito mostra so a lista de conversas
  closeToTray: true,
  bounds: { width: 1180, height: 820 }
}

const PALETTE = ['#5b8def', '#2fa15f', '#c98a3b', '#b4626f', '#7d6bd4', '#4aa3a3']

let cfg = JSON.parse(JSON.stringify(DEFAULTS))

const configPath = () => path.join(app.getPath('userData'), 'config.json')
const avatarDir = () => path.join(app.getPath('userData'), 'avatars')

function loadConfig () {
  try {
    // o replace tira BOM: um config salvo por editor/PowerShell vem com ele e
    // o JSON.parse quebraria, zerando as contas do usuario em silencio
    const text = fs.readFileSync(configPath(), 'utf8').replace(/^﻿/, '')
    cfg = { ...cfg, ...JSON.parse(text) }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('config ilegivel, usando o padrao:', err.message)
  }

  if (!Array.isArray(cfg.accounts) || !cfg.accounts.length) {
    cfg.accounts = JSON.parse(JSON.stringify(DEFAULTS.accounts))
  }
  cfg.accounts = cfg.accounts.slice(0, MAX_ACCOUNTS).map((a, i) => ({
    id: String(a.id || 'conta-' + (i + 1)),
    name: String(a.name || 'Conta ' + (i + 1)).slice(0, 24),
    color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : PALETTE[i % PALETTE.length]
  }))
  cfg.layout = { ...DEFAULTS.layout, ...(cfg.layout || {}) }
  normalizeLayout()
}

let saveTimer = null
function saveConfig () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
    } catch (err) {
      console.error('nao consegui salvar config:', err.message)
    }
  }, 300)
}

// panes so pode conter conta existente; sizes sempre casa com panes e soma 1
function normalizeLayout () {
  const ids = new Set(cfg.accounts.map(a => a.id))
  let panes = (cfg.layout.panes || []).filter(id => ids.has(id))
  panes = [...new Set(panes)]
  if (!panes.length) panes = [ids.has(cfg.activeId) ? cfg.activeId : cfg.accounts[0].id]
  if (cfg.layout.mode === 'focus') panes = [panes[0]]

  let sizes = Array.isArray(cfg.layout.sizes) ? cfg.layout.sizes.slice(0, panes.length) : []
  while (sizes.length < panes.length) sizes.push(1 / panes.length)
  const sum = sizes.reduce((a, b) => a + (Number(b) > 0 ? Number(b) : 0), 0)
  sizes = sum > 0 ? sizes.map(s => (Number(s) > 0 ? Number(s) : 0) / sum) : panes.map(() => 1 / panes.length)

  cfg.layout.panes = panes
  cfg.layout.sizes = sizes
  if (!ids.has(cfg.activeId)) cfg.activeId = panes[0]
}

// ---------------------------------------------------------------- estado

let win = null
let settingsWin = null
let tray = null
let dragLayer = null
let dragIndex = -1
let dialogOpen = false
let quitting = false

const views = new Map()    // id -> WebContentsView
const badges = new Map()   // id -> numero de nao lidas
const avatars = new Map()  // id -> data URL da foto

// macOS nao le .ico
const iconPath = path.join(__dirname, '..', 'build', IS_MAC ? 'icon.png' : 'icon.ico')

const account = (id) => cfg.accounts.find(a => a.id === id)

// ---------------------------------------------------------------- avatares

function loadAvatars () {
  for (const acc of cfg.accounts) {
    const file = path.join(avatarDir(), acc.id + '.png')
    try {
      if (!fs.existsSync(file)) continue
      const img = nativeImage.createFromPath(file)
      if (!img.isEmpty()) avatars.set(acc.id, img.toDataURL())
    } catch { /* foto ilegivel: cai no monograma */ }
  }
}

async function pickAvatar (id) {
  if (!account(id)) return
  dialogOpen = true
  let result
  try {
    result = await dialog.showOpenDialog(settingsWin || win, {
      title: 'Escolher foto da conta',
      properties: ['openFile'],
      filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
    })
  } finally {
    dialogOpen = false
  }
  if (!result || result.canceled || !result.filePaths[0]) return

  let img = nativeImage.createFromPath(result.filePaths[0])
  if (img.isEmpty()) {
    dialog.showErrorBox('Foto da conta', 'Não consegui ler essa imagem.')
    return
  }
  // recorte central quadrado antes de reduzir, senao a foto distorce
  const size = img.getSize()
  const side = Math.min(size.width, size.height)
  img = img.crop({
    x: Math.round((size.width - side) / 2),
    y: Math.round((size.height - side) / 2),
    width: side,
    height: side
  })
  img = img.resize({ width: 128, height: 128, quality: 'best' })

  try {
    fs.mkdirSync(avatarDir(), { recursive: true })
    fs.writeFileSync(path.join(avatarDir(), id + '.png'), img.toPNG())
  } catch (err) {
    dialog.showErrorBox('Foto da conta', 'Não consegui salvar a foto: ' + err.message)
    return
  }
  avatars.set(id, img.toDataURL())
  pushState()
}

function clearAvatar (id) {
  avatars.delete(id)
  try { fs.unlinkSync(path.join(avatarDir(), id + '.png')) } catch { /* ja nao existia */ }
  pushState()
}

// ---------------------------------------------------------------- views

function buildView (acc) {
  const ses = session.fromPartition('persist:' + acc.id)
  ses.setUserAgent(UA)
  try { ses.setSpellCheckerLanguages(['pt-BR']) } catch { /* idioma indisponivel */ }

  const allowed = new Set([
    'notifications', 'media', 'audioCapture', 'videoCapture',
    'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock'
  ])
  ses.setPermissionRequestHandler((_wc, permission, done) => done(allowed.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, 'preload-wa.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false // contas fora da tela continuam recebendo
    }
  })
  view.setBackgroundColor('#111b21')

  const wc = view.webContents
  wc.setUserAgent(UA)

  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith('https://web.whatsapp.com')) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  wc.on('page-title-updated', (_event, title) => {
    const m = /\((\d+)\+?\)/.exec(title || '')
    const count = m ? parseInt(m[1], 10) : 0
    if ((badges.get(acc.id) || 0) !== count) {
      badges.set(acc.id, count)
      pushBadges()
    }
  })

  // recarregar a pagina apaga o estilo injetado; reavisa a largura
  wc.on('did-finish-load', () => wc.send('zapbox:narrow', isNarrow(view.getBounds().width)))

  wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) setTimeout(() => wc.loadURL(WA_URL), 4000)
  })
  wc.on('render-process-gone', () => setTimeout(() => wc.loadURL(WA_URL), 1500))

  views.set(acc.id, view)
  win.contentView.addChildView(view)
  return view
}

function destroyView (id) {
  const view = views.get(id)
  if (!view) return
  try { win.contentView.removeChildView(view) } catch { /* ja removida */ }
  try { view.webContents.close() } catch { /* ja fechada */ }
  views.delete(id)
  badges.delete(id)
}

function showView (view, visible) {
  if (!view) return
  if (typeof view.setVisible === 'function') view.setVisible(visible)
  else if (visible) win.contentView.addChildView(view)
  else win.contentView.removeChildView(view)
}

// ---------------------------------------------------------------- layout

// so vale na tela dividida: em foco a conta ocupa tudo e a conversa tem espaco
function isNarrow (width) {
  return cfg.listOnly && cfg.layout.panes.length > 1 && width < NARROW
}

function computeLayout () {
  const { width, height } = win.getContentBounds()
  const area = { x: RAIL, y: 0, width: Math.max(0, width - RAIL), height }
  const panes = cfg.layout.panes
  const n = panes.length
  const rects = []
  const gutters = []

  if (n <= 1 || cfg.layout.mode === 'focus') {
    rects.push({ id: panes[0], ...area })
    return { rects, gutters }
  }

  const horizontal = cfg.layout.mode === 'cols'
  const span = (horizontal ? area.width : area.height) - GUTTER * (n - 1)
  if (span <= 0) {
    rects.push({ id: panes[0], ...area })
    return { rects, gutters }
  }

  let cursor = horizontal ? area.x : area.y
  panes.forEach((id, i) => {
    const last = i === n - 1
    const end = horizontal ? area.x + area.width : area.y + area.height
    const len = last ? end - cursor : Math.round(span * cfg.layout.sizes[i])
    rects.push(horizontal
      ? { id, x: cursor, y: area.y, width: len, height: area.height }
      : { id, x: area.x, y: cursor, width: area.width, height: len })
    cursor += len
    if (!last) {
      gutters.push(horizontal
        ? { index: i, dir: 'cols', x: cursor, y: area.y, width: GUTTER, height: area.height }
        : { index: i, dir: 'rows', x: area.x, y: cursor, width: area.width, height: GUTTER })
      cursor += GUTTER
    }
  })
  return { rects, gutters }
}

function applyLayout () {
  if (!win || win.isDestroyed()) return
  normalizeLayout()
  const { rects, gutters } = computeLayout()
  const onScreen = new Set(rects.map(r => r.id))

  for (const [id, view] of views) showView(view, onScreen.has(id))

  // com mais de um painel, a view recua 3px pra sobrar a moldura da cor da
  // conta - o que aparece na folga e o fundo da pagina do rail, embaixo
  const inset = rects.length > 1 ? FRAME : 0
  const frames = []
  for (const r of rects) {
    const view = views.get(r.id)
    if (!view) continue
    const width = r.width - inset * 2
    view.setBounds({ x: r.x + inset, y: r.y + inset, width, height: r.height - inset * 2 })
    view.webContents.send('zapbox:narrow', isNarrow(width))
    if (inset) {
      const acc = account(r.id)
      frames.push({ ...r, color: acc ? acc.color : '#5b8def', active: r.id === cfg.activeId })
    }
  }
  win.webContents.send('frames', frames)
  if (dragLayer) {
    const { width, height } = win.getContentBounds()
    dragLayer.setBounds({ x: RAIL, y: 0, width: Math.max(0, width - RAIL), height })
  }
  win.webContents.send('gutters', gutters)
}

function resizePanes (px, py) {
  const n = cfg.layout.panes.length
  if (dragIndex < 0 || dragIndex >= n - 1) return
  const { width, height } = win.getContentBounds()
  const horizontal = cfg.layout.mode === 'cols'
  const span = (horizontal ? width - RAIL : height) - GUTTER * (n - 1)
  if (span <= 0) return

  const sizes = cfg.layout.sizes.slice()
  let before = 0
  for (let i = 0; i < dragIndex; i++) before += sizes[i]
  const origin = (horizontal ? RAIL : 0) + before * span + dragIndex * GUTTER

  const pair = sizes[dragIndex] + sizes[dragIndex + 1]
  const min = Math.min(MIN_PANE / span, pair / 2)
  let first = ((horizontal ? px : py) - origin) / span
  first = Math.max(min, Math.min(pair - min, first))

  sizes[dragIndex] = first
  sizes[dragIndex + 1] = pair - first
  cfg.layout.sizes = sizes
  applyLayout()
}

function setMode (mode) {
  if (!['focus', 'cols', 'rows'].includes(mode)) return
  cfg.layout.mode = mode
  if (mode === 'focus') {
    cfg.layout.panes = [cfg.activeId]
    cfg.layout.sizes = [1]
  }
  applyLayout()
  saveConfig()
  pushState()
  focusActive()
}

// clique simples: em foco troca a conta; dividido, troca o painel focado
function selectAccount (id) {
  if (!account(id)) return
  const panes = cfg.layout.panes
  if (cfg.layout.mode === 'focus') {
    cfg.layout.panes = [id]
    cfg.layout.sizes = [1]
  } else if (!panes.includes(id)) {
    const at = Math.max(0, panes.indexOf(cfg.activeId))
    panes[at] = id
  }
  cfg.activeId = id
  applyLayout()
  saveConfig()
  pushState()
  focusActive()
}

// ctrl+clique: poe/tira a conta da tela dividida
function togglePane (id) {
  if (!account(id)) return
  if (cfg.layout.mode === 'focus') {
    setMode('cols')
    if (cfg.layout.panes.includes(id)) return
  }
  const panes = cfg.layout.panes
  const at = panes.indexOf(id)
  if (at >= 0) {
    if (panes.length === 1) return
    panes.splice(at, 1)
    cfg.layout.sizes.splice(at, 1)
    if (cfg.activeId === id) cfg.activeId = panes[Math.min(at, panes.length - 1)]
  } else {
    panes.push(id)
    cfg.layout.sizes = panes.map(() => 1 / panes.length)
    cfg.activeId = id
  }
  applyLayout()
  saveConfig()
  pushState()
  focusActive()
}

function focusActive () {
  const view = views.get(cfg.activeId)
  if (view && cfg.layout.panes.includes(cfg.activeId)) view.webContents.focus()
}

// ---------------------------------------------------------------- estado -> telas

function stateFor () {
  return {
    accounts: cfg.accounts.map(a => ({
      id: a.id,
      name: a.name,
      color: a.color,
      avatar: avatars.get(a.id) || null,
      onScreen: cfg.layout.panes.includes(a.id),
      active: a.id === cfg.activeId
    })),
    layout: { mode: cfg.layout.mode, panes: cfg.layout.panes.slice() },
    palette: PALETTE,
    maxAccounts: MAX_ACCOUNTS,
    closeToTray: cfg.closeToTray,
    listOnly: cfg.listOnly
  }
}

function pushState () {
  const state = stateFor()
  if (win && !win.isDestroyed()) win.webContents.send('state', state)
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('state', state)
  buildAppMenu()
  buildTrayMenu()
}

function pushBadges () {
  const map = {}
  let total = 0
  for (const acc of cfg.accounts) {
    const n = badges.get(acc.id) || 0
    map[acc.id] = n
    total += n
  }
  if (win && !win.isDestroyed()) win.webContents.send('badges', map)
  if (tray) tray.setToolTip(total ? `WappLink — ${total} não lidas` : 'WappLink')
  try { app.badgeCount = total } catch { /* Windows nao tem badge de dock */ }
  buildTrayMenu()
}

// ---------------------------------------------------------------- contas

function nextAccountId () {
  let n = cfg.accounts.length + 1
  const taken = new Set(cfg.accounts.map(a => a.id))
  while (taken.has('conta-' + n)) n++
  return 'conta-' + n
}

function addAccount () {
  if (cfg.accounts.length >= MAX_ACCOUNTS) return
  const id = nextAccountId()
  const acc = { id, name: 'Conta ' + (cfg.accounts.length + 1), color: PALETTE[cfg.accounts.length % PALETTE.length] }
  cfg.accounts.push(acc)
  const view = buildView(acc)
  view.webContents.loadURL(WA_URL)
  saveConfig()
  selectAccount(id)
}

async function removeAccount (id) {
  const acc = account(id)
  if (!acc || cfg.accounts.length <= 1) return
  dialogOpen = true
  let response
  try {
    ({ response } = await dialog.showMessageBox(settingsWin || win, {
      type: 'warning',
      buttons: ['Cancelar', 'Remover'],
      defaultId: 0,
      cancelId: 0,
      title: 'Remover conta',
      message: `Remover "${acc.name}"?`,
      detail: 'A sessão dessa conta é apagada do computador. Você pode adicionar de novo depois, mas vai precisar ler o QR code outra vez.'
    }))
  } finally {
    dialogOpen = false
  }
  if (response !== 1) return

  destroyView(id)
  cfg.accounts = cfg.accounts.filter(a => a.id !== id)
  cfg.layout.panes = cfg.layout.panes.filter(p => p !== id)
  if (cfg.activeId === id) cfg.activeId = cfg.accounts[0].id
  avatars.delete(id)
  try { fs.unlinkSync(path.join(avatarDir(), id + '.png')) } catch { /* sem foto */ }
  try { await session.fromPartition('persist:' + id).clearStorageData() } catch { /* nada a limpar */ }
  applyLayout()
  saveConfig()
  pushState()
}

function reorderAccounts (id, toIndex) {
  const from = cfg.accounts.findIndex(a => a.id === id)
  if (from < 0) return
  const to = Math.max(0, Math.min(cfg.accounts.length - 1, toIndex))
  if (from === to) return
  const [moved] = cfg.accounts.splice(from, 1)
  cfg.accounts.splice(to, 0, moved)
  saveConfig()
  pushState()
}

// ---------------------------------------------------------------- ipc

ipcMain.on('shell:ready', () => { pushState(); pushBadges(); applyLayout() })
ipcMain.on('shell:select', (_e, id) => selectAccount(id))
ipcMain.on('shell:toggle-pane', (_e, id) => togglePane(id))
ipcMain.on('shell:settings', () => toggleSettings())

ipcMain.on('gutter:down', (_e, index) => startGutterDrag(index))
ipcMain.on('gutter:move', (_e, pos) => resizePanes(RAIL + pos.x, pos.y))
ipcMain.on('gutter:up', () => endGutterDrag())

ipcMain.on('settings:ready', () => pushState())
ipcMain.on('settings:close', () => { if (settingsWin) settingsWin.hide() })
ipcMain.on('settings:mode', (_e, mode) => setMode(mode))
ipcMain.on('settings:select', (_e, id) => selectAccount(id))
ipcMain.on('settings:toggle-pane', (_e, id) => togglePane(id))
ipcMain.on('settings:add', () => addAccount())
ipcMain.on('settings:remove', (_e, id) => removeAccount(id))
ipcMain.on('settings:reorder', (_e, id, index) => reorderAccounts(id, index))
ipcMain.on('settings:avatar', (_e, id) => pickAvatar(id))
ipcMain.on('settings:avatar-clear', (_e, id) => clearAvatar(id))
ipcMain.on('settings:close-to-tray', (_e, value) => { cfg.closeToTray = !!value; saveConfig(); pushState() })

ipcMain.on('settings:list-only', (_e, value) => {
  cfg.listOnly = !!value
  saveConfig()
  applyLayout()
  pushState()
})

ipcMain.on('settings:rename', (_e, id, name) => {
  const acc = account(id)
  const clean = String(name || '').trim().slice(0, 24)
  if (!acc || !clean) return
  acc.name = clean
  saveConfig()
  pushState()
})

ipcMain.on('settings:color', (_e, id, color) => {
  const acc = account(id)
  if (!acc || !/^#[0-9a-f]{6}$/i.test(String(color))) return
  acc.color = color
  saveConfig()
  pushState()
})

ipcMain.on('settings:reload', (_e, id) => {
  const view = views.get(id)
  if (view) view.webContents.loadURL(WA_URL)
})

ipcMain.on('settings:logout', async (_e, id) => {
  const acc = account(id)
  if (!acc) return
  dialogOpen = true
  let response
  try {
    ({ response } = await dialog.showMessageBox(settingsWin || win, {
      type: 'warning',
      buttons: ['Cancelar', 'Desconectar'],
      defaultId: 0,
      cancelId: 0,
      title: 'Desconectar conta',
      message: `Desconectar "${acc.name}"?`,
      detail: 'A sessão é apagada e você vai precisar ler o QR code de novo nessa conta.'
    }))
  } finally {
    dialogOpen = false
  }
  if (response !== 1) return
  await session.fromPartition('persist:' + id).clearStorageData()
  const view = views.get(id)
  if (view) view.webContents.loadURL(WA_URL)
})

// clique na notificacao nativa -> abre a conta que recebeu
ipcMain.on('wa:notification-click', (event) => {
  for (const [id, view] of views) {
    if (view.webContents === event.sender) {
      if (win) {
        if (!win.isVisible()) win.show()
        if (win.isMinimized()) win.restore()
        win.focus()
      }
      selectAccount(id)
      return
    }
  }
})

// ---------------------------------------------------------------- arrasto da divisoria

function startGutterDrag (index) {
  if (dragLayer || index < 0 || index >= cfg.layout.panes.length - 1) return
  dragIndex = index
  const { width, height } = win.getContentBounds()
  dragLayer = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-drag.js'),
      contextIsolation: true,
      sandbox: true,
      transparent: true
    }
  })
  dragLayer.setBackgroundColor('#00000000')
  dragLayer.setBounds({ x: RAIL, y: 0, width: Math.max(0, width - RAIL), height })
  win.contentView.addChildView(dragLayer)
  dragLayer.webContents.loadFile(path.join(__dirname, 'drag.html'), {
    query: { dir: cfg.layout.mode }
  })
}

function endGutterDrag () {
  dragIndex = -1
  if (!dragLayer) return
  try { win.contentView.removeChildView(dragLayer) } catch { /* ja removida */ }
  try { dragLayer.webContents.close() } catch { /* ja fechada */ }
  dragLayer = null
  saveConfig()
}

// ---------------------------------------------------------------- menus

function activeWc () {
  const view = views.get(cfg.activeId)
  return view ? view.webContents : null
}

function zoom (delta) {
  const wc = activeWc()
  if (!wc) return
  wc.setZoomLevel(delta === 0 ? 0 : Math.max(-3, Math.min(3, wc.getZoomLevel() + delta)))
}

// mesmo item no menu do app e no da bandeja
function updateMenuItem () {
  const s = updater.state
  if (s.status === 'ready') return { label: `Reiniciar e atualizar para ${s.version}`, click: () => updater.install() }
  if (s.status === 'downloading') return { label: `Baixando atualização ${s.version}...`, enabled: false }
  if (s.status === 'checking') return { label: 'Procurando atualização...', enabled: false }
  return { label: `Procurar atualização (versão ${app.getVersion()})`, click: () => updater.check(true) }
}

function buildAppMenu () {
  const contas = cfg.accounts.slice(0, 9).map((a, i) => ({
    label: a.name,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => selectAccount(a.id)
  }))

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Recarregar conta', accelerator: 'CmdOrCtrl+R', click: () => activeWc()?.loadURL(WA_URL) },
        {
          label: 'Recarregar todas',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => { for (const v of views.values()) v.webContents.loadURL(WA_URL) }
        },
        { type: 'separator' },
        { label: 'Contas e tela...', accelerator: 'CmdOrCtrl+,', click: () => toggleSettings() },
        updateMenuItem(),
        { type: 'separator' },
        { label: 'Minimizar para a bandeja', accelerator: 'CmdOrCtrl+W', click: () => win && win.hide() },
        { label: 'Sair', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit() } }
      ]
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' }
      ]
    },
    {
      label: 'Contas',
      submenu: [
        ...contas,
        { type: 'separator' },
        {
          label: 'Próxima conta',
          accelerator: 'Ctrl+Tab',
          click: () => {
            const i = cfg.accounts.findIndex(a => a.id === cfg.activeId)
            selectAccount(cfg.accounts[(i + 1) % cfg.accounts.length].id)
          }
        },
        {
          label: 'Pôr/tirar da tela dividida',
          accelerator: 'CmdOrCtrl+D',
          click: () => togglePane(cfg.activeId)
        }
      ]
    },
    {
      label: 'Tela',
      submenu: [
        { label: 'Uma conta (foco)', type: 'radio', checked: cfg.layout.mode === 'focus', accelerator: 'CmdOrCtrl+Alt+1', click: () => setMode('focus') },
        { label: 'Lado a lado (colunas)', type: 'radio', checked: cfg.layout.mode === 'cols', accelerator: 'CmdOrCtrl+Alt+2', click: () => setMode('cols') },
        { label: 'Empilhado (linhas)', type: 'radio', checked: cfg.layout.mode === 'rows', accelerator: 'CmdOrCtrl+Alt+3', click: () => setMode('rows') },
        { type: 'separator' },
        {
          label: 'Dividir por igual',
          accelerator: 'CmdOrCtrl+Alt+0',
          click: () => {
            cfg.layout.sizes = cfg.layout.panes.map(() => 1 / cfg.layout.panes.length)
            applyLayout()
            saveConfig()
          }
        },
        { type: 'separator' },
        { label: 'Aumentar zoom', accelerator: 'CmdOrCtrl+Plus', click: () => zoom(0.5) },
        { label: 'Diminuir zoom', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { label: 'Zoom normal', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { type: 'separator' },
        { label: 'Ferramentas do desenvolvedor', accelerator: 'F12', click: () => activeWc()?.openDevTools({ mode: 'detach' }) }
      ]
    }
  ]))
}

function buildTrayMenu () {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir WappLink', click: () => showWindow() },
    { type: 'separator' },
    ...cfg.accounts.map(a => {
      const n = badges.get(a.id) || 0
      return { label: a.name + (n ? `  (${n})` : ''), click: () => { showWindow(); selectAccount(a.id) } }
    }),
    { type: 'separator' },
    {
      label: 'Fechar minimiza para a bandeja',
      type: 'checkbox',
      checked: cfg.closeToTray,
      click: (item) => { cfg.closeToTray = item.checked; saveConfig(); pushState() }
    },
    updateMenuItem(),
    { label: 'Sair', click: () => { quitting = true; app.quit() } }
  ]))
}

// ---------------------------------------------------------------- janelas

function showWindow () {
  if (!win) return
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
}

function placeSettings () {
  const b = win.getBounds()
  const width = 380
  const height = Math.min(660, Math.max(420, b.height - 80))
  const area = screen.getDisplayMatching(b).workArea
  let x = b.x + RAIL + 12
  let y = b.y + Math.max(40, b.height - height - 56)
  x = Math.max(area.x, Math.min(x, area.x + area.width - width))
  y = Math.max(area.y, Math.min(y, area.y + area.height - height))
  settingsWin.setBounds({ x, y, width, height })
}

function createSettings () {
  settingsWin = new BrowserWindow({
    parent: win,
    width: 380,
    height: 620,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#10161d',
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  settingsWin.loadFile(path.join(__dirname, 'settings.html'))
  settingsWin.setMenu(null)

  // some sozinha quando perde o foco - menos quando e um dialogo nosso que roubou
  settingsWin.on('blur', () => {
    if (!dialogOpen && settingsWin && settingsWin.isVisible()) settingsWin.hide()
  })
  settingsWin.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    settingsWin.hide()
  })
}

function toggleSettings () {
  if (!settingsWin || settingsWin.isDestroyed()) createSettings()
  if (settingsWin.isVisible()) {
    settingsWin.hide()
    return
  }
  placeSettings()
  pushState()
  settingsWin.show()
  settingsWin.focus()
}

function createWindow () {
  win = new BrowserWindow({
    width: cfg.bounds.width,
    height: cfg.bounds.height,
    x: cfg.bounds.x,
    y: cfg.bounds.y,
    minWidth: 940,
    minHeight: 620,
    title: 'WappLink',
    icon: iconPath,
    backgroundColor: '#0d1116',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  win.loadFile(path.join(__dirname, 'shell.html'))
  win.once('ready-to-show', () => win.show())

  cfg.accounts.forEach((acc, i) => {
    const view = buildView(acc)
    setTimeout(() => view.webContents.loadURL(WA_URL), i * 1500)
  })
  applyLayout()

  const relayout = () => applyLayout()
  win.on('resize', relayout)
  win.on('maximize', () => setTimeout(relayout, 0))
  win.on('unmaximize', () => setTimeout(relayout, 0))
  win.on('enter-full-screen', relayout)
  win.on('leave-full-screen', relayout)

  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
    cfg.bounds = win.getBounds()
    saveConfig()
  }
  win.on('resized', remember)
  win.on('moved', remember)

  win.on('close', (event) => {
    if (!quitting && cfg.closeToTray) {
      event.preventDefault()
      if (settingsWin && settingsWin.isVisible()) settingsWin.hide()
      win.hide()
    }
  })
  win.on('closed', () => { win = null })
}

function createTray () {
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'))
  // na barra de menu do Mac o icone em 256px nao cabe
  if (IS_MAC) image = image.resize({ width: 18, height: 18 })
  tray = new Tray(image)
  tray.setToolTip('WappLink')
  tray.on('click', () => {
    if (win && win.isVisible() && !win.isMinimized()) win.hide()
    else showWindow()
  })
  buildTrayMenu()
}

// ---------------------------------------------------------------- boot

// ZAPBOX_ALLOW_MULTI=1 e valvula de teste: permite subir uma segunda instancia
// (com --user-data-dir proprio) sem esbarrar na trava de instancia unica
const singleInstance = process.env.ZAPBOX_ALLOW_MULTI === '1' || app.requestSingleInstanceLock()

if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    loadConfig()
    loadAvatars()
    createWindow()
    createSettings()
    createTray()
    buildAppMenu()
    updater.init({
      onChange: () => { buildAppMenu(); buildTrayMenu() },
      quit: () => { quitting = true; app.quit() }
    })
  })

  app.on('window-all-closed', () => { /* fica na bandeja */ })
  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', () => updater.onQuit())
  app.on('activate', () => { if (!win) createWindow(); else showWindow() })
}
