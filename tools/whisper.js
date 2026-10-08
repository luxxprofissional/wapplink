'use strict'
// Baixa o whisper.cpp (so o servidor e as DLLs que ele carrega) para
// vendor/whisper/<plataforma>-<arquitetura>. O electron-builder copia essa
// pasta para dentro do instalador (extraResources). Nao fica no git: sao 11MB
// de binario de terceiro; o release.js chama isto antes do build.
//
//   node tools/whisper.js
//
// Versao fixa e hash conferido: trocar RELEASE exige trocar SHA256 junto.

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const RELEASE = 'b5130' // whisper.cpp de 11/09/2026 (mesmo codigo da v1.9.4)
const ZIP = 'whisper-bin-x64.zip'
const SHA256 = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'

// o servidor escolhe sozinho, na hora, a ggml-cpu-*.dll que casa com o
// processador; por isso vao todas
const KEEP = (name) => name === 'whisper-server.exe' || name === 'whisper.dll' ||
  name === 'ggml.dll' || name === 'ggml-base.dll' || /^ggml-cpu-.+\.dll$/.test(name)

const dest = path.join(__dirname, '..', 'vendor', 'whisper', `${process.platform}-${process.arch}`)

async function main () {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log(`whisper: sem binario pronto para ${process.platform}-${process.arch}; a transcricao fica desligada nesse build.`)
    return
  }
  if (fs.existsSync(path.join(dest, 'whisper-server.exe'))) {
    console.log('whisper: ja esta em ' + path.relative(process.cwd(), dest))
    return
  }

  const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/${ZIP}`
  console.log('whisper: baixando ' + url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`)
  const zip = Buffer.from(await res.arrayBuffer())
  const hash = crypto.createHash('sha256').update(zip).digest('hex')
  if (hash !== SHA256) throw new Error(`hash do ${ZIP} nao confere (${hash})`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wapplink-whisper-'))
  try {
    const zipPath = path.join(tmp, ZIP)
    fs.writeFileSync(zipPath, zip)
    // o tar do Windows 10+ (bsdtar) abre .zip; caminho completo porque o tar
    // do Git Bash, se vier antes no PATH, le "C:" como host remoto
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    execFileSync(tar, ['-xf', ZIP], { cwd: tmp })
    const from = path.join(tmp, 'Release')
    fs.mkdirSync(dest, { recursive: true })
    const files = fs.readdirSync(from).filter(KEEP)
    for (const f of files) fs.copyFileSync(path.join(from, f), path.join(dest, f))
    console.log(`whisper: ${files.length} arquivos em ${path.relative(process.cwd(), dest)}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch(err => { console.error('whisper: ' + err.message); process.exit(1) })
