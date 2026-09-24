'use strict'
// Gera os icones a partir do logo (build/logo.png):
//   build/icon.png      256x256 (janela, bandeja no Mac)
//   build/icon.ico      16..256 (Windows)
//   build/icon-mac.png  512x512 (o electron-builder exige >= 512 pro .icns)
//
// O icone e so o balao com a corrente — o texto "Wapp Link" some em 16px.
// Recorta o balao, apaga o brilho verde-escuro em volta e centraliza num
// quadrado transparente.
//
// Roda dentro do Electron (usa nativeImage): npm run icon

const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, '..', 'build')
const PAD = 0.04          // folga em volta do balao, fracao do lado
const DARK = 150          // abaixo disso (luminancia) e brilho/fundo, nao balao
const FRINGE = 235        // entre DARK e isso: borda antisserrilhada

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b

function mark () {
  const src = nativeImage.createFromPath(path.join(dir, 'logo.png'))
  if (src.isEmpty()) throw new Error('build/logo.png nao encontrado')
  const { width: W, height: H } = src.getSize()
  const bmp = src.toBitmap() // BGRA

  // caixa do balao: pixels claros acima do texto (o texto fica no terco de baixo)
  const textTop = Math.round(H * 0.62)
  let x0 = W, y0 = H, x1 = 0, y1 = 0
  for (let y = 0; y < textTop; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (bmp[i + 3] > 200 && lum(bmp[i + 2], bmp[i + 1], bmp[i]) > 200) {
        if (x < x0) x0 = x; if (x > x1) x1 = x
        if (y < y0) y0 = y; if (y > y1) y1 = y
      }
    }
  }
  const side = Math.round(Math.max(x1 - x0, y1 - y0) * (1 + 2 * PAD))
  const cx = Math.round((x0 + x1) / 2)
  const cy = Math.round((y0 + y1) / 2)
  const ox = cx - Math.round(side / 2)
  const oy = cy - Math.round(side / 2)

  // copia o recorte (fora da imagem = transparente)
  const out = Buffer.alloc(side * side * 4, 0)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const sx = ox + x, sy = oy + y
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
      bmp.copy(out, (y * side + x) * 4, (sy * W + sx) * 4, (sy * W + sx) * 4 + 4)
    }
  }

  // inunda a partir das bordas por tudo que e escuro: isso e o brilho, vira
  // transparente. O anel branco do balao segura a inundacao.
  const seen = new Uint8Array(side * side)
  const stack = []
  for (let i = 0; i < side; i++) stack.push(i, (side - 1) * side + i, i * side, i * side + side - 1)
  while (stack.length) {
    const p = stack.pop()
    if (seen[p]) continue
    const i = p * 4
    const l = lum(out[i + 2], out[i + 1], out[i])
    if (out[i + 3] > 0 && l >= DARK) continue
    seen[p] = 1
    out.fill(0, i, i + 4) // pre-multiplicado: transparente tem que ser 0,0,0,0
    const x = p % side, y = (p / side) | 0
    if (x > 0) stack.push(p - 1)
    if (x < side - 1) stack.push(p + 1)
    if (y > 0) stack.push(p - side)
    if (y < side - 1) stack.push(p + side)
  }

  // borda antisserrilhada: pixel meio-escuro colado na area apagada vira
  // branco com alfa proporcional, sem halo verde-escuro
  for (let p = 0; p < side * side; p++) {
    if (seen[p]) continue
    const x = p % side, y = (p / side) | 0
    const edge = (x > 0 && seen[p - 1]) || (x < side - 1 && seen[p + 1]) ||
      (y > 0 && seen[p - side]) || (y < side - 1 && seen[p + side])
    if (!edge) continue
    const i = p * 4
    const l = lum(out[i + 2], out[i + 1], out[i])
    if (l < FRINGE) {
      // o bitmap do nativeImage e pre-multiplicado: branco com alfa A = (A, A, A, A)
      const a = Math.max(0, Math.min(1, (l - DARK) / (FRINGE - DARK)))
      const alpha = Math.round(a * out[i + 3])
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = alpha
    }
  }

  return nativeImage.createFromBitmap(out, { width: side, height: side })
}

const png = (img, n) => img.resize({ width: n, height: n, quality: 'best' }).toPNG()

// ICO com PNG embutido (Vista+), varios tamanhos
function ico (img, sizes) {
  const pngs = sizes.map(n => png(img, n))
  const head = Buffer.alloc(6 + 16 * sizes.length)
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4)
  let offset = head.length
  sizes.forEach((n, k) => {
    const e = 6 + 16 * k
    head[e] = n >= 256 ? 0 : n; head[e + 1] = n >= 256 ? 0 : n
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(pngs[k].length, e + 8); head.writeUInt32LE(offset, e + 12)
    offset += pngs[k].length
  })
  return Buffer.concat([head, ...pngs])
}

app.whenReady().then(() => {
  try {
    const img = mark()
    fs.writeFileSync(path.join(dir, 'icon.png'), png(img, 256))
    fs.writeFileSync(path.join(dir, 'icon-mac.png'), png(img, 512))
    fs.writeFileSync(path.join(dir, 'icon.ico'), ico(img, [16, 24, 32, 48, 64, 128, 256]))
    console.log('ok: build/icon.png, build/icon.ico e build/icon-mac.png')
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
  app.quit()
})
