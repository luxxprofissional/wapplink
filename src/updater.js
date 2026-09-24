'use strict'
// Atualizacao automatica pelos Releases do GitHub (luxxprofissional/wapplink).
//
// Windows: electron-updater + NSIS — baixa em segundo plano e instala ao sair
// (ou na hora, se o usuario pedir).
// macOS: o app nao e assinado pela Apple, e o Squirrel.Mac (que o
// electron-updater usa no Mac) recusa app sem assinatura. Entao aqui e na mao:
// le o latest-mac.yml do release, baixa o .zip da arquitetura certa, confere o
// sha512, descompacta com `ditto` e um script solto troca o .app depois que o
// processo morre.

const { app, net, Notification, dialog } = require('electron')
const { execFile, spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

const OWNER = 'luxxprofissional'
const REPO = 'wapplink'
const FIRST_CHECK = 15 * 1000         // espera o app assentar antes do 1o check
const INTERVAL = 4 * 60 * 60 * 1000   // depois, a cada 4h

const IS_MAC = process.platform === 'darwin'

let onChange = () => {}
let quitApp = () => app.quit()
let manual = false        // check pedido pelo menu: avisa mesmo sem novidade
let macPending = null     // { appPath } — .app novo ja extraido, esperando troca

const state = {
  status: 'idle',         // idle | checking | downloading | ready | error
  version: null,          // versao nova, quando houver
  error: null
}

function log (msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'updater.log'),
      `${new Date().toISOString()} ${msg}\n`)
  } catch { /* log e so conveniencia */ }
}

function set (patch) {
  Object.assign(state, patch)
  onChange(state)
}

function ready (version) {
  set({ status: 'ready', version, error: null })
  log(`pronta: ${version}`)
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'WappLink — atualização pronta',
      body: `Versão ${version} baixada. Clique para reiniciar agora (ou ela entra quando você sair).`
    })
    n.on('click', () => install())
    n.show()
  }
  manual = false
}

function fail (err) {
  const msg = err && err.message ? err.message : String(err)
  log(`erro: ${msg}`)
  set({ status: 'error', error: msg })
  if (manual) dialog.showErrorBox('WappLink', `Não deu para procurar atualização:\n${msg}`)
  manual = false
}

function upToDate () {
  set({ status: 'idle', version: null, error: null })
  if (manual) {
    dialog.showMessageBox({
      type: 'info',
      message: 'O WappLink está atualizado.',
      detail: `Versão ${app.getVersion()}`
    })
  }
  manual = false
}

// ---------------------------------------------------------------- Windows

let winUpdater = null

function setupWindows () {
  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = { info: log, warn: log, error: log, debug () {} }
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }))
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version }))
  autoUpdater.on('update-not-available', upToDate)
  autoUpdater.on('update-downloaded', (info) => ready(info.version))
  autoUpdater.on('error', fail)
  winUpdater = autoUpdater
}

// ---------------------------------------------------------------- macOS

const releaseUrl = (file) => `https://github.com/${OWNER}/${REPO}/releases/latest/download/${file}`

function newer (a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

// latest-mac.yml e simples o bastante pra nao precisar de parser YAML
function parseLatest (text) {
  const version = (text.match(/^version:\s*['"]?([^'"\s]+)/m) || [])[1]
  const files = []
  const re = /-\s+url:\s*(\S+)\s*\n\s+sha512:\s*(\S+)/g
  let m
  while ((m = re.exec(text))) files.push({ url: m[1], sha512: m[2] })
  return { version, files }
}

// o bundle em execucao: .../WappLink.app/Contents/MacOS/WappLink
const currentBundle = () => path.resolve(process.execPath, '..', '..', '..')

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, (err, _out, stderr) => err ? reject(new Error(stderr || err.message)) : resolve())
})

async function checkMac () {
  set({ status: 'checking', error: null })

  const res = await net.fetch(releaseUrl('latest-mac.yml'), { cache: 'no-store' })
  // 404 = ainda nao existe release com build de Mac
  if (res.status === 404) return upToDate()
  if (!res.ok) throw new Error(`latest-mac.yml: HTTP ${res.status}`)
  const latest = parseLatest(await res.text())
  if (!latest.version || !newer(latest.version, app.getVersion())) return upToDate()

  // electron-builder: WappLink-1.2.0-arm64-mac.zip (Apple Silicon) e WappLink-1.2.0-mac.zip (Intel)
  const zips = latest.files.filter(f => f.url.endsWith('.zip'))
  const file = process.arch === 'arm64'
    ? zips.find(f => f.url.includes('arm64'))
    : zips.find(f => !f.url.includes('arm64'))
  if (!file) throw new Error(`release ${latest.version} sem .zip para ${process.arch}`)

  const bundle = currentBundle()
  if (!bundle.endsWith('.app')) throw new Error(`app fora de um .app: ${bundle}`)
  fs.accessSync(path.dirname(bundle), fs.constants.W_OK)

  set({ status: 'downloading', version: latest.version })
  log(`baixando ${file.url}`)

  const dir = path.join(app.getPath('temp'), 'wapplink-update')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const zipPath = path.join(dir, path.basename(file.url))

  const dl = await net.fetch(
    `https://github.com/${OWNER}/${REPO}/releases/download/v${latest.version}/${file.url}`)
  if (!dl.ok) throw new Error(`${file.url}: HTTP ${dl.status}`)
  const hash = crypto.createHash('sha512')
  const body = Readable.fromWeb(dl.body)
  body.on('data', (chunk) => hash.update(chunk))
  await pipeline(body, fs.createWriteStream(zipPath))
  if (hash.digest('base64') !== file.sha512) throw new Error('sha512 não confere — download corrompido')

  const out = path.join(dir, 'app')
  await run('/usr/bin/ditto', ['-x', '-k', zipPath, out])
  const name = fs.readdirSync(out).find(n => n.endsWith('.app'))
  if (!name) throw new Error('o .zip não tem um .app dentro')

  macPending = { appPath: path.join(out, name) }
  ready(latest.version)
}

// troca o .app depois que este processo morrer; relaunch=false quando o
// usuario so esta saindo
function swapMac (relaunch) {
  const script = `
    while kill -0 "$1" 2>/dev/null; do sleep 0.3; done
    APP="$2"; NEW="$3"
    rm -rf "$APP.old"
    if mv "$APP" "$APP.old" && mv "$NEW" "$APP"; then
      rm -rf "$APP.old"
    elif [ -d "$APP.old" ] && [ ! -d "$APP" ]; then
      mv "$APP.old" "$APP"
    fi
    xattr -dr com.apple.quarantine "$APP" 2>/dev/null
    [ "$4" = 1 ] && open "$APP"
  `
  const child = spawn('/bin/sh', ['-c', script, 'wapplink-swap',
    String(process.pid), currentBundle(), macPending.appPath, relaunch ? '1' : '0'],
  { detached: true, stdio: 'ignore' })
  child.unref()
  log(`troca agendada (relaunch=${relaunch})`)
  macPending = null
}

// ---------------------------------------------------------------- API

async function check (fromMenu = false) {
  if (!app.isPackaged) {
    if (fromMenu) dialog.showMessageBox({ type: 'info', message: 'Atualização só funciona no app instalado.' })
    return
  }
  if (['checking', 'downloading', 'ready'].includes(state.status)) return
  manual = fromMenu
  try {
    if (IS_MAC) await checkMac()
    else await winUpdater.checkForUpdates()
  } catch (err) {
    fail(err)
  }
}

function install () {
  if (state.status !== 'ready') return
  log(`instalando ${state.version}`)
  if (IS_MAC) {
    swapMac(true)
    quitApp()
  } else {
    // isSilent=true: sem telas do instalador; isForceRunAfter=true: reabre sozinho
    setImmediate(() => winUpdater.quitAndInstall(true, true))
  }
}

// no Mac a troca na saida e nossa; no Windows o autoInstallOnAppQuit cuida
function onQuit () {
  if (IS_MAC && macPending) swapMac(false)
}

function init (opts) {
  onChange = opts.onChange || onChange
  quitApp = opts.quit || quitApp
  if (!app.isPackaged) return
  if (!IS_MAC) setupWindows()
  setTimeout(() => check(), FIRST_CHECK)
  setInterval(() => check(), INTERVAL)
}

module.exports = { init, check, install, onQuit, state }
