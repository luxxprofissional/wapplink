'use strict'
// Transcricao de audio do WhatsApp no proprio computador, com o whisper.cpp.
//
// O audio nunca sai da maquina (igual ao celular). Na primeira transcricao o
// modelo e baixado do Hugging Face para a pasta de dados; depois disso
// funciona offline. O whisper-server fica de pe enquanto houver uso — carregar
// o modelo custa ~1,5s — e cai sozinho depois de IDLE_MS parado, pra devolver
// a RAM (~400MB no rapido, ~1GB no melhor).
//
// Medido num Ryzen 7 5700X3D so com CPU, audio de 21s em portugues:
// rapido 3,7s / melhor 12,3s. O Whisper processa em blocos de 30s, entao
// audio curto custa quase o mesmo que um de 30s.

const { app } = require('electron')
const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'
const MODELS = {
  rapido: { file: 'ggml-small-q5_1.bin', mb: 190, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
  melhor: { file: 'ggml-large-v3-turbo-q5_0.bin', mb: 574, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' }
}

const IDLE_MS = 10 * 60 * 1000
const MAX_CACHE = 3000

const exeName = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
const binDir = () => app.isPackaged
  ? path.join(process.resourcesPath, 'whisper')
  : path.join(__dirname, '..', 'vendor', 'whisper', `${process.platform}-${process.arch}`)
const dataDir = () => path.join(app.getPath('userData'), 'whisper')

function available () {
  return fs.existsSync(path.join(binDir(), exeName))
}

// ---------------------------------------------------------------- modelo

const downloads = new Map() // arquivo -> promise em andamento

function modelPath (quality) {
  return path.join(dataDir(), MODELS[quality].file)
}

function ensureModel (quality, onProgress) {
  const model = MODELS[quality]
  const file = modelPath(quality)
  if (fs.existsSync(file)) return Promise.resolve(file)
  if (downloads.has(file)) return downloads.get(file)

  const job = (async () => {
    fs.mkdirSync(dataDir(), { recursive: true })
    const part = file + '.part'
    const res = await fetch(HF + model.file)
    if (!res.ok || !res.body) throw new Error(`não consegui baixar o modelo (HTTP ${res.status})`)
    const total = Number(res.headers.get('content-length')) || model.mb * 1e6
    const hash = crypto.createHash('sha256')
    const out = fs.createWriteStream(part)
    let got = 0
    let lastPct = -1
    try {
      for await (const chunk of res.body) {
        hash.update(chunk)
        got += chunk.length
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve))
        const pct = Math.floor(got * 100 / total)
        if (pct !== lastPct) { lastPct = pct; onProgress(`Baixando o modelo de transcrição (${model.mb} MB, só na 1ª vez)… ${pct}%`) }
      }
      await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())))
    } catch (err) {
      out.destroy()
      fs.rmSync(part, { force: true })
      throw new Error('o download do modelo caiu: ' + err.message)
    }
    if (hash.digest('hex') !== model.sha256) {
      fs.rmSync(part, { force: true })
      throw new Error('o modelo baixado veio corrompido; tente de novo')
    }
    fs.renameSync(part, file)
    return file
  })()

  downloads.set(file, job)
  job.finally(() => downloads.delete(file)).catch(() => {})
  return job
}

// ---------------------------------------------------------------- servidor

let server = null // { child, port, quality, ready }
let idleTimer = null

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function stop () {
  clearTimeout(idleTimer)
  if (server) {
    try { server.child.kill() } catch { /* ja saiu */ }
    server = null
  }
}

function touch () {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(stop, IDLE_MS)
}

async function ensureServer (quality, modelFile) {
  if (server && server.quality === quality) return server.ready
  stop()

  const port = await freePort()
  const threads = Math.max(2, Math.min(8, Math.floor(os.availableParallelism() / 2)))
  const lang = /^pt/i.test(app.getLocale()) ? 'pt' : 'auto'
  const child = spawn(path.join(binDir(), exeName), [
    '-m', modelFile, '-l', lang, '-t', String(threads), '-nt',
    '--host', '127.0.0.1', '--port', String(port)
  ], { cwd: binDir(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })

  // o fim do stderr vira a mensagem de erro se ele morrer subindo
  let tail = ''
  child.stderr.on('data', (d) => { tail = (tail + d).slice(-600) })

  const me = { child, port, quality, ready: null }
  child.on('exit', () => { if (server === me) server = null })
  me.ready = (async () => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('o transcritor fechou ao abrir: ' + tail.trim().split('\n').pop())
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`)
        if (r.ok) return me
      } catch { /* ainda subindo */ }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('o transcritor não respondeu em 60s')
  })()
  server = me
  me.ready.catch(() => { if (server === me) stop() })
  return me.ready
}

// ---------------------------------------------------------------- fila

// um audio por vez: o servidor ja serializa, e assim o progresso de cada
// bolha nao se embaralha
let queue = Promise.resolve()

function transcribe (wav, quality, onProgress) {
  const job = queue.then(async () => {
    if (!available()) throw new Error('transcrição indisponível neste sistema')
    const q = MODELS[quality] ? quality : 'rapido'
    const modelFile = await ensureModel(q, onProgress)
    onProgress('Transcrevendo…')
    const { port } = await ensureServer(q, modelFile)
    touch()

    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
    form.append('response_format', 'json')
    const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form })
    touch()
    if (!res.ok) throw new Error(`o transcritor respondeu HTTP ${res.status}`)
    const body = await res.json()
    if (body.error) throw new Error(String(body.error))
    return String(body.text || '').replace(/\s+/g, ' ').trim()
  })
  queue = job.catch(() => {})
  return job
}

// ---------------------------------------------------------------- cache

// transcricoes ja feitas, por conta + id da mensagem: rolar a conversa
// remonta a bolha e o texto tem que voltar sem transcrever de novo
let cache = null
let cacheTimer = null
const cachePath = () => path.join(app.getPath('userData'), 'transcricoes.json')

function loadCache () {
  if (cache) return cache
  try {
    cache = new Map(Object.entries(JSON.parse(fs.readFileSync(cachePath(), 'utf8'))))
  } catch {
    cache = new Map()
  }
  return cache
}

function getCached (key) {
  return loadCache().get(key)
}

function setCached (key, text) {
  const c = loadCache()
  c.delete(key)
  c.set(key, text)
  while (c.size > MAX_CACHE) c.delete(c.keys().next().value)
  clearTimeout(cacheTimer)
  cacheTimer = setTimeout(flush, 1000)
}

function flush () {
  if (!cacheTimer) return
  clearTimeout(cacheTimer)
  cacheTimer = null
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(Object.fromEntries(cache)))
  } catch (err) {
    console.error('nao consegui salvar as transcricoes:', err.message)
  }
}

// ao sair: grava o que estiver pendente e derruba o servidor
function shutdown () {
  flush()
  stop()
}

module.exports = { available, transcribe, getCached, setCached, shutdown, MODELS }
