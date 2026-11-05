/**
 * Motor de figurinhas
 *
 *  Imagem/GIF → quadros (Raster) → máscara "suave" da IA (0..255 por pixel)
 *    → alpha efetivo = sensibilidade + limpeza (pedaços soltos / buracos) + edições manuais (pincel/varinha)
 *    → composição 512x512 (recorte, contorno branco, texto)
 *    → WebP (estática) ou GIF (animada)
 */
import { decompressFrames, parseGIF } from 'gifuct-js'
import { GIFEncoder, applyPalette, quantize } from 'gifenc'

export const SIZE = 512
const MAX_STATIC_SIDE = 1024
const MAX_GIF_SIDE = 512
export const MAX_GIF_FRAMES = 48

export type Raster = { w: number; h: number; rgba: Uint8ClampedArray }
export type Frame = Raster & { delay: number }
export type Source = { w: number; h: number; frames: Frame[]; animated: boolean }

export type MaskSettings = {
  /** 0..100 — maior = remove mais (exige mais certeza da IA para manter o pixel) */
  sensitivity: number
  /** remove ilhas pequenas desconectadas do objeto principal */
  cleanup: boolean
  /** preenche buracos pequenos dentro do objeto */
  fillHoles: boolean
}

export type Progress = (label: string, ratio: number) => void

// ------------------------------------------------------------------ carregamento

export function isGifBlob(b: Blob) {
  return b.type === 'image/gif'
}

export function isAnimatedUrl(url: string | null | undefined) {
  return !!url && /\.gif(\?|#|$)/i.test(url)
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function ctx2d(c: HTMLCanvasElement) {
  return c.getContext('2d', { willReadFrequently: true })!
}

export async function loadSource(blob: Blob): Promise<Source> {
  if (isGifBlob(blob)) {
    const gif = await decodeGif(await blob.arrayBuffer(), MAX_GIF_SIDE, MAX_GIF_FRAMES)
    if (gif.frames.length > 1) return { ...gif, animated: true }
    return { ...gif, animated: false }
  }
  const bmp = await createImageBitmap(blob)
  const scale = Math.min(1, MAX_STATIC_SIDE / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const c = canvas(w, h)
  const x = ctx2d(c)
  x.imageSmoothingQuality = 'high'
  x.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return { w, h, animated: false, frames: [{ w, h, rgba: x.getImageData(0, 0, w, h).data, delay: 0 }] }
}

/** Decodifica um GIF em quadros completos (aplicando "disposal"), reduzindo tamanho e nº de quadros */
export async function decodeGif(buf: ArrayBuffer, maxSide = MAX_GIF_SIDE, maxFrames = Infinity) {
  const gif = parseGIF(buf)
  const parts = decompressFrames(gif, true)
  const W = gif.lsd.width
  const H = gif.lsd.height
  const full = canvas(W, H)
  const fx = ctx2d(full)
  const patchC = canvas(1, 1)
  const px = ctx2d(patchC)
  const scale = Math.min(1, maxSide / Math.max(W, H))
  const w = Math.max(1, Math.round(W * scale))
  const h = Math.max(1, Math.round(H * scale))
  const out = canvas(w, h)
  const ox = ctx2d(out)

  let frames: Frame[] = []
  let restore: ImageData | null = null
  let prev: (typeof parts)[number] | null = null

  for (const f of parts) {
    if (prev) {
      if (prev.disposalType === 2) fx.clearRect(prev.dims.left, prev.dims.top, prev.dims.width, prev.dims.height)
      else if (prev.disposalType === 3 && restore) fx.putImageData(restore, 0, 0)
    }
    restore = f.disposalType === 3 ? fx.getImageData(0, 0, W, H) : null
    patchC.width = f.dims.width
    patchC.height = f.dims.height
    px.putImageData(new ImageData(new Uint8ClampedArray(f.patch), f.dims.width, f.dims.height), 0, 0)
    fx.drawImage(patchC, f.dims.left, f.dims.top)
    ox.clearRect(0, 0, w, h)
    ox.drawImage(full, 0, 0, w, h)
    frames.push({ w, h, rgba: ox.getImageData(0, 0, w, h).data, delay: Math.max(20, f.delay || 100) })
    prev = f
  }

  // muitos quadros: mantém 1 a cada N e soma as durações (a animação continua com o mesmo tempo)
  if (frames.length > maxFrames) {
    const step = Math.ceil(frames.length / maxFrames)
    const reduced: Frame[] = []
    for (let i = 0; i < frames.length; i += step) {
      const group = frames.slice(i, i + step)
      reduced.push({ ...group[0], delay: group.reduce((a, g) => a + g.delay, 0) })
    }
    frames = reduced
  }
  return { w, h, frames }
}

// ------------------------------------------------------------------ IA

function rasterToBlob(r: Raster): Promise<Blob> {
  const c = canvas(r.w, r.h)
  ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.w, r.h), 0, 0)
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'))
}

/** Roda o modelo de segmentação e devolve a máscara suave (alpha 0..255) no tamanho do raster */
export async function aiMask(r: Raster, onProgress?: Progress): Promise<Uint8Array> {
  const { removeBackground } = await import('@imgly/background-removal')
  const result = await removeBackground(await rasterToBlob(r), {
    model: 'isnet_fp16',
    output: { format: 'image/png', quality: 1 },
    progress: (key, current, total) => {
      if (key.startsWith('fetch')) onProgress?.('Baixando modelo de IA (só na primeira vez)…', total ? current / total : 0)
    },
  })
  const bmp = await createImageBitmap(result)
  const c = canvas(r.w, r.h)
  const x = ctx2d(c)
  x.drawImage(bmp, 0, 0, r.w, r.h)
  bmp.close()
  const data = x.getImageData(0, 0, r.w, r.h).data
  const mask = new Uint8Array(r.w * r.h)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3]
  return mask
}

/** Máscara a partir da transparência que a própria imagem já tem (PNG/GIF transparentes) */
export function ownAlpha(r: Raster): Uint8Array {
  const m = new Uint8Array(r.w * r.h)
  for (let i = 0; i < m.length; i++) m[i] = r.rgba[i * 4 + 3]
  return m
}

export function coverage(mask: Uint8Array) {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) n++
  return n / mask.length
}

// ------------------------------------------------------------------ máscara efetiva

/**
 * Componentes conexos (4-vizinhança) sobre um mapa binário.
 * Devolve rótulos por pixel e a área de cada rótulo.
 */
function label(bin: Uint8Array, w: number, h: number, value: 0 | 1) {
  const labels = new Int32Array(w * h).fill(-1)
  const areas: number[] = []
  const touchesBorder: boolean[] = []
  const stack = new Int32Array(w * h)
  for (let start = 0; start < bin.length; start++) {
    if (bin[start] !== value || labels[start] !== -1) continue
    const id = areas.length
    let area = 0
    let border = false
    let sp = 0
    stack[sp++] = start
    labels[start] = id
    while (sp) {
      const p = stack[--sp]
      area++
      const x = p % w
      const y = (p - x) / w
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true
      if (x > 0 && bin[p - 1] === value && labels[p - 1] === -1) (labels[p - 1] = id), (stack[sp++] = p - 1)
      if (x < w - 1 && bin[p + 1] === value && labels[p + 1] === -1) (labels[p + 1] = id), (stack[sp++] = p + 1)
      if (y > 0 && bin[p - w] === value && labels[p - w] === -1) (labels[p - w] = id), (stack[sp++] = p - w)
      if (y < h - 1 && bin[p + w] === value && labels[p + w] === -1) (labels[p + w] = id), (stack[sp++] = p + w)
    }
    areas.push(area)
    touchesBorder.push(border)
  }
  return { labels, areas, touchesBorder }
}

/**
 * Converte a máscara suave da IA no alpha final:
 *  - sensibilidade desloca o ponto de corte (com borda suave de ~40 níveis)
 *  - limpeza remove ilhas pequenas e preenche buracos pequenos
 *  - edições manuais (1 = manter, -1 = apagar) têm a palavra final
 */
export function effectiveAlpha(
  soft: Uint8Array,
  w: number,
  h: number,
  s: MaskSettings,
  edits: Int8Array | null,
): Uint8Array {
  const n = w * h
  const out = new Uint8Array(n)
  // sensibilidade 0 → corte em ~8 (mantém quase tudo que a IA achou), 100 → corte em ~235
  const cut = 8 + (s.sensitivity / 100) * 227
  const band = 40
  const lo = cut - band / 2
  for (let i = 0; i < n; i++) {
    const v = (soft[i] - lo) / band
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
  }

  if (s.cleanup || s.fillHoles) {
    const bin = new Uint8Array(n)
    for (let i = 0; i < n; i++) bin[i] = out[i] > 127 ? 1 : 0
    if (s.cleanup) {
      const { labels, areas } = label(bin, w, h, 1)
      let largest = 0
      for (const a of areas) if (a > largest) largest = a
      // só apaga migalhas de verdade (2,5% do objeto principal) — partes separadas do objeto, como uma mão, ficam
      const min = Math.max(48, largest * 0.025)
      for (let i = 0; i < n; i++) if (labels[i] >= 0 && areas[labels[i]] < min) (out[i] = 0), (bin[i] = 0)
    }
    if (s.fillHoles) {
      const { labels, areas, touchesBorder } = label(bin, w, h, 0)
      const max = n * 0.015
      for (let i = 0; i < n; i++) {
        const l = labels[i]
        if (l >= 0 && !touchesBorder[l] && areas[l] < max) out[i] = 255
      }
    }
  }

  if (edits) for (let i = 0; i < n; i++) if (edits[i]) out[i] = edits[i] > 0 ? 255 : 0
  return out
}

// ------------------------------------------------------------------ ferramentas manuais

/** Varinha mágica: seleciona a região contígua com cor parecida com a do ponto clicado */
export function floodSelect(r: Raster, x: number, y: number, tolerance: number): Uint8Array {
  const { w, h, rgba } = r
  const sel = new Uint8Array(w * h)
  const start = y * w + x
  const sr = rgba[start * 4]
  const sg = rgba[start * 4 + 1]
  const sb = rgba[start * 4 + 2]
  const sa = rgba[start * 4 + 3]
  const tol = (tolerance / 100) * 160
  const tol2 = tol * tol
  const near = (p: number) => {
    const a = rgba[p * 4 + 3]
    if (sa < 20 || a < 20) return sa < 20 && a < 20
    const dr = rgba[p * 4] - sr
    const dg = rgba[p * 4 + 1] - sg
    const db = rgba[p * 4 + 2] - sb
    // distância perceptual simples (pesos de luminância)
    return 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db <= tol2
  }
  const stack = new Int32Array(w * h)
  let sp = 0
  stack[sp++] = start
  sel[start] = 1
  while (sp) {
    const p = stack[--sp]
    const px = p % w
    const py = (p - px) / w
    if (px > 0 && !sel[p - 1] && near(p - 1)) (sel[p - 1] = 1), (stack[sp++] = p - 1)
    if (px < w - 1 && !sel[p + 1] && near(p + 1)) (sel[p + 1] = 1), (stack[sp++] = p + 1)
    if (py > 0 && !sel[p - w] && near(p - w)) (sel[p - w] = 1), (stack[sp++] = p - w)
    if (py < h - 1 && !sel[p + w] && near(p + w)) (sel[p + w] = 1), (stack[sp++] = p + w)
  }
  // expande 1px para não deixar "halo" da cor removida
  const grown = sel.slice()
  for (let p = 0; p < sel.length; p++) {
    if (!sel[p]) continue
    const px = p % w
    if (px > 0) grown[p - 1] = 1
    if (px < w - 1) grown[p + 1] = 1
    if (p >= w) grown[p - w] = 1
    if (p < sel.length - w) grown[p + w] = 1
  }
  return grown
}

/** Pinta um traço de pincel (de a até b) no mapa de edições */
export function paintStroke(
  edits: Int8Array,
  w: number,
  h: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  radius: number,
  value: 1 | -1,
) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius / 3)))
  const r2 = radius * radius
  for (let s = 0; s <= steps; s++) {
    const cx = a.x + ((b.x - a.x) * s) / steps
    const cy = a.y + ((b.y - a.y) * s) / steps
    const x0 = Math.max(0, Math.floor(cx - radius))
    const x1 = Math.min(w - 1, Math.ceil(cx + radius))
    const y0 = Math.max(0, Math.floor(cy - radius))
    const y1 = Math.min(h - 1, Math.ceil(cy + radius))
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) edits[y * w + x] = value
  }
}

/** Imagem para o editor: área mantida normal, área removida em vermelho translúcido (opcional) */
export function renderEditor(r: Raster, alpha: Uint8Array, showRemoved: boolean): ImageData {
  const out = new Uint8ClampedArray(r.rgba.length)
  for (let i = 0; i < alpha.length; i++) {
    const o = i * 4
    const a = alpha[i]
    const src = r.rgba[o + 3]
    if (showRemoved && a < 128) {
      out[o] = (r.rgba[o] * 0.45 + 255 * 0.55) | 0
      out[o + 1] = (r.rgba[o + 1] * 0.45 + 40 * 0.55) | 0
      out[o + 2] = (r.rgba[o + 2] * 0.45 + 60 * 0.55) | 0
      out[o + 3] = Math.max((a * src) / 255, src * 0.4)
    } else {
      out[o] = r.rgba[o]
      out[o + 1] = r.rgba[o + 1]
      out[o + 2] = r.rgba[o + 2]
      out[o + 3] = (a * src) / 255
    }
  }
  return new ImageData(out, r.w, r.h)
}

// ------------------------------------------------------------------ composição final

export type StickerOptions = {
  outline: boolean
  outlineColor?: string
  outlineWidth?: number
  text?: string
  textColor?: string
  /** recorta pela transparência (bounding box do objeto) */
  trim: boolean
  shape?: 'free' | 'circle' | 'rounded'
}

function applyAlpha(r: Raster, alpha: Uint8Array | null): HTMLCanvasElement {
  const c = canvas(r.w, r.h)
  const data = new Uint8ClampedArray(r.rgba)
  if (alpha) for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = (data[i * 4 + 3] * alpha[i]) / 255
  ctx2d(c).putImageData(new ImageData(data, r.w, r.h), 0, 0)
  return c
}

type Box = { x: number; y: number; w: number; h: number }

function alphaBox(alpha: Uint8Array | null, w: number, h: number, into?: Box | null): Box | null {
  if (!alpha) return { x: 0, y: 0, w, h }
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (alpha[y * w + x] > 20) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
  if (maxX < 0) return into ?? null
  if (into) {
    minX = Math.min(minX, into.x)
    minY = Math.min(minY, into.y)
    maxX = Math.max(maxX, into.x + into.w - 1)
    maxY = Math.max(maxY, into.y + into.h - 1)
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Compõe um quadro 512x512 (recorte, forma, contorno, texto) */
function composeFrame(src: HTMLCanvasElement, box: Box, opts: StickerOptions): HTMLCanvasElement {
  const border = opts.outline ? (opts.outlineWidth ?? 14) : 0
  const pad = border + 8
  const avail = SIZE - pad * 2
  const scale = Math.min(avail / box.w, avail / box.h)
  const dw = box.w * scale
  const dh = box.h * scale
  const dx = (SIZE - dw) / 2
  const dy = (SIZE - dh) / 2

  const base = canvas(SIZE, SIZE)
  const b = base.getContext('2d')!
  b.imageSmoothingQuality = 'high'
  if (opts.shape === 'circle' || opts.shape === 'rounded') {
    b.save()
    b.beginPath()
    if (opts.shape === 'circle') b.arc(SIZE / 2, SIZE / 2, Math.min(dw, dh) / 2, 0, Math.PI * 2)
    else b.roundRect(dx, dy, dw, dh, Math.min(dw, dh) * 0.12)
    b.clip()
    b.drawImage(src, box.x, box.y, box.w, box.h, dx, dy, dw, dh)
    b.restore()
  } else {
    b.drawImage(src, box.x, box.y, box.w, box.h, dx, dy, dw, dh)
  }

  const out = canvas(SIZE, SIZE)
  const o = out.getContext('2d')!
  if (border > 0) {
    const sil = canvas(SIZE, SIZE)
    const s = sil.getContext('2d')!
    const steps = 36
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      s.drawImage(base, Math.cos(a) * border, Math.sin(a) * border)
    }
    s.drawImage(base, 0, 0)
    s.globalCompositeOperation = 'source-in'
    s.fillStyle = opts.outlineColor ?? '#ffffff'
    s.fillRect(0, 0, SIZE, SIZE)
    o.save()
    o.shadowColor = 'rgba(0,0,0,0.25)'
    o.shadowBlur = 6
    o.shadowOffsetY = 2
    o.drawImage(sil, 0, 0)
    o.restore()
  }
  o.drawImage(base, 0, 0)

  if (opts.text?.trim()) {
    const text = opts.text.trim().toUpperCase()
    let fontSize = 64
    o.font = `900 ${fontSize}px Impact, "Arial Black", sans-serif`
    while (o.measureText(text).width > SIZE - 40 && fontSize > 20) {
      fontSize -= 2
      o.font = `900 ${fontSize}px Impact, "Arial Black", sans-serif`
    }
    o.textAlign = 'center'
    o.textBaseline = 'bottom'
    o.lineJoin = 'round'
    o.lineWidth = Math.max(6, fontSize / 6)
    o.strokeStyle = '#000'
    o.strokeText(text, SIZE / 2, SIZE - 14)
    o.fillStyle = opts.textColor ?? '#fff'
    o.fillText(text, SIZE / 2, SIZE - 14)
  }
  return out
}

/** Prévia de um único quadro já composto (rápida, para a tela de edição) */
export function previewFrame(frame: Raster, alpha: Uint8Array | null, opts: StickerOptions): HTMLCanvasElement | null {
  const box = opts.trim ? alphaBox(alpha, frame.w, frame.h) : { x: 0, y: 0, w: frame.w, h: frame.h }
  if (!box) return null
  return composeFrame(applyAlpha(frame, alpha), box, opts)
}

/** Gera o arquivo final. Estática → WebP (fallback PNG). Animada → GIF. */
export async function buildSticker(
  source: Source,
  alphas: (Uint8Array | null)[],
  opts: StickerOptions,
  onProgress?: Progress,
): Promise<Blob> {
  if (!source.animated) {
    const c = previewFrame(source.frames[0], alphas[0], opts)
    if (!c) throw new Error('A figurinha ficou vazia. Diminua a sensibilidade ou restaure com o pincel.')
    return canvasToBlob(c)
  }

  // caixa comum a todos os quadros para a animação não "tremer"
  let box: Box | null = null
  if (opts.trim) for (let i = 0; i < source.frames.length; i++) box = alphaBox(alphas[i], source.w, source.h, box)
  else box = { x: 0, y: 0, w: source.w, h: source.h }
  if (!box) throw new Error('A figurinha ficou vazia. Diminua a sensibilidade ou restaure com o pincel.')

  const gif = GIFEncoder()
  for (let i = 0; i < source.frames.length; i++) {
    onProgress?.(`Gerando animação… quadro ${i + 1}/${source.frames.length}`, i / source.frames.length)
    const c = composeFrame(applyAlpha(source.frames[i], alphas[i]), box, opts)
    const data = c.getContext('2d')!.getImageData(0, 0, SIZE, SIZE).data
    // GIF só tem transparência total ou nenhuma: binariza o alpha
    for (let p = 3; p < data.length; p += 4) {
      if (data[p] < 128) data[p - 3] = data[p - 2] = data[p - 1] = data[p] = 0
      else data[p] = 255
    }
    const palette = quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true, clearAlpha: true })
    const index = applyPalette(data, palette, 'rgba4444')
    const transparentIndex = palette.findIndex((c) => c[3] === 0)
    gif.writeFrame(index, SIZE, SIZE, {
      palette,
      delay: source.frames[i].delay,
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(0, transparentIndex),
      dispose: 2,
    })
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)) // não travar a interface
  }
  gif.finish()
  return new Blob([gif.bytes().slice()], { type: 'image/gif' })
}

function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob(
      (webp) => {
        if (webp && webp.type === 'image/webp') return resolve(webp)
        c.toBlob((png) => (png ? resolve(png) : reject(new Error('Falha ao gerar figurinha'))), 'image/png')
      },
      'image/webp',
      0.92,
    )
  })
}
