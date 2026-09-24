'use strict'
// Lancar uma versao nova do WappLink para todo mundo.
//
//   1. suba "version" no package.json (ex.: 1.1.0 -> 1.1.1)
//   2. no Windows:  npm run release          (gera o instalador e sobe no rascunho vX.Y.Z)
//   3. no Mac:      npm run release          (gera os .zip e sobe no MESMO rascunho)
//   4. em qualquer um: npm run release:publish  (tira do rascunho -> os apps enxergam)
//
// Enquanto for rascunho ninguem recebe nada. O token vem de GH_TOKEN ou do
// `gh auth login` da maquina.

const { execFileSync, spawnSync } = require('child_process')
const path = require('path')

const OWNER = 'luxxprofissional'
const REPO = 'wapplink'
const root = path.join(__dirname, '..')
const { version } = require('../package.json')
const tag = `v${version}`

function token () {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
  } catch {
    console.error('Sem token do GitHub. Rode `gh auth login` (ou defina GH_TOKEN) e tente de novo.')
    process.exit(1)
  }
}

async function api (method, url, body) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

function build () {
  const platform = { win32: '--win', darwin: '--mac' }[process.platform]
  if (!platform) {
    console.error(`Build só no Windows ou no Mac (aqui é ${process.platform}).`)
    process.exit(1)
  }
  const env = { ...process.env, GH_TOKEN: token() }
  // os icones ficam versionados em build/; so regenere (npm run icon) se o logo mudar
  const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js')
  const r = spawnSync(process.execPath, [cli, platform, '--publish', 'always'], { cwd: root, env, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
  console.log(`\nOK: ${tag} (${platform.slice(2)}) enviado ao rascunho.`)
  console.log('Quando Windows e Mac estiverem lá: npm run release:publish')
}

async function publish () {
  const releases = await api('GET', '/releases?per_page=20')
  const rel = releases.find(r => r.tag_name === tag)
  if (!rel) throw new Error(`Não existe release ${tag}. Rode "npm run release" antes.`)
  if (!rel.draft) return console.log(`${tag} já está publicado.`)

  const names = rel.assets.map(a => a.name)
  const faltando = ['latest.yml', 'latest-mac.yml'].filter(n => !names.includes(n))
  if (faltando.length && !process.argv.includes('--anyway')) {
    console.error(`${tag} ainda não tem: ${faltando.join(', ')}`)
    console.error('Falta o build do ' + faltando.map(n => n === 'latest.yml' ? 'Windows' : 'Mac').join(' e do ') +
      '. Para publicar mesmo assim: npm run release:publish -- --anyway')
    process.exit(1)
  }
  await api('PATCH', `/releases/${rel.id}`, { draft: false })
  console.log(`Publicado ${tag}. Os apps pegam em até 4h (ou na próxima vez que abrirem).`)
}

if (process.argv.includes('--publish')) {
  publish().catch(err => { console.error(err.message); process.exit(1) })
} else {
  build()
}
