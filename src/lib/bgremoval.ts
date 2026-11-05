/**
 * Remoção de fundo "melhor esforço" — tenta várias estratégias e escolhe a melhor automaticamente.
 *
 * Imagens estáticas
 *   - "ia":        modelo ISNet rodado 3x (normal, com margem e espelhado) e combinado (média)
 *   - "cor":       detecta a(s) cor(es) de fundo pelas bordas e remove (fundos lisos, logos, desenhos, prints)
 *   - "combinado": IA + cor (a cor limpa sobras de fundo que a IA deixou; a IA protege o objeto)
 *   - "original":  transparência que a imagem já tinha
 *   Cada candidato recebe uma nota (bordas, contorno alinhado às arestas da imagem, cobertura, fragmentação).
 *
 * GIFs
 *   - fundo liso → remoção por cor em todos os quadros (rápido)
 *   - câmera parada → IA em quadros-chave + subtração de fundo (o que se move entra na figurinha)
 *   - câmera em movimento → IA quadro a quadro
 */
import { aiMask, coverage, ownAlpha, type Progress, type Raster } from './sticker'

export type Method = 'combinado' | 'ia' | 'cor' | 'original'
export const METHOD_LABEL: Record<Method, string> = {
  combinado: 'IA + cor',
  ia: 'IA',
  cor: 'Cor do fundo',
  original: 'Transparência original',
}

export type StaticResult = {
  candidates: Partial<Record<Method, Uint8Array>>
  scores: Partial<Record<Method, number>>
  best: Method
}

export type GifResult = { masks: Uint8Array[]; method: string; score: number }

// ------------------------------------------------------------------ utilitários de cor/imagem

/** distância de cor "redmean" (aproximação perceptual barata), 0..~765 */
function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) {
  const rm = (r1 + r2) / 2
  const dr = r1 - r2
  const dg = g1 - g2
  const db = b1 - b2
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
}

function pxDist(a: Uint8ClampedArray, i: number, b: Uint8ClampedArray, j: number) {
  return colorDist(a[i * 4], a[i * 4 + 1], a[i * 4 + 2], b[j * 4], b[j * 4 + 1], b[j * 4 + 2])
}

function borderIndices(w: number, h: number, band: number) {
  const out: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x < band || y < band || x >= w - band || y >= h - band) out.push(y * w + x)
  return out
}

function medianBorderColor(r: Raster): [number, number, number] {
  const idx = borderIndices(r.w, r.h, 1)
  const ch = (c: number) => {
    const v = idx.map((i) => r.rgba[i * 4 + c]).sort((a, b) => a - b)
    return v[v.length >> 1] ?? 255
  }
  return [ch(0), ch(1), ch(2)]
}

function padRaster(r: Raster, pad: number): Raster {
  const [cr, cg, cb] = medianBorderColor(r)
  const w = r.w + pad * 2
  const h = r.h + pad * 2
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) rgba.set([cr, cg, cb, 255], i * 4)
  for (let y = 0; y < r.h; y++) rgba.set(r.rgba.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((y + pad) * w + pad) * 4)
  return { w, h, rgba }
}

function cropMask(m: Uint8Array, w: number, pad: number, ow: number, oh: number) {
  const out = new Uint8Array(ow * oh)
  for (let y = 0; y < oh; y++) out.set(m.subarray((y + pad) * w + pad, (y + pad) * w + pad + ow), y * ow)
  return out
}

function flipRaster(r: Raster): Raster {
  const rgba = new Uint8ClampedArray(r.rgba.length)
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const s = (y * r.w + x) * 4
      const d = (y * r.w + (r.w - 1 - x)) * 4
      rgba[d] = r.rgba[s]
      rgba[d + 1] = r.rgba[s + 1]
      rgba[d + 2] = r.rgba[s + 2]
      rgba[d + 3] = r.rgba[s + 3]
    }
  return { w: r.w, h: r.h, rgba }
}

function flipMask(m: Uint8Array, w: number, h: number) {
  const out = new Uint8Array(m.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + (w - 1 - x)] = m[y * w + x]
  return out
}

function average(masks: Uint8Array[]) {
  const out = new Uint8Array(masks[0].length)
  for (let i = 0; i < out.length; i++) {
    let s = 0
    for (const m of masks) s += m[i]
    out[i] = Math.round(s / masks.length)
  }
  return out
}

/** Suaviza só a fronteira (1px) para o recorte por cor não ficar serrilhado */
function featherEdges(m: Uint8Array, w: number, h: number) {
  const out = m.slice()
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const v = m[p]
      if (v !== m[p - 1] || v !== m[p + 1] || v !== m[p - w] || v !== m[p + w])
        out[p] = (m[p] * 4 + m[p - 1] + m[p + 1] + m[p - w] + m[p + w]) >> 3
    }
  return out
}

// ------------------------------------------------------------------ fundo por cor (bordas)

/**
 * Estima as cores de fundo a partir das bordas e remove tudo que é dessa cor e está ligado às bordas,
 * além de "janelas" grandes da mesma cor dentro do objeto (fundo aparecendo entre braço e corpo, etc.).
 * Devolve null quando as bordas são variadas demais (fundo fotográfico) — aí só a IA serve.
 */
export function colorKeyMask(r: Raster): { mask: Uint8Array; confidence: number } | null {
  const { w, h, rgba } = r
  const n = w * h
  const band = Math.max(1, Math.round(Math.min(w, h) * 0.01))
  const border = borderIndices(w, h, band)

  // agrupa as cores da borda (4 bits por canal)
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>()
  let opaque = 0
  for (const i of border) {
    if (rgba[i * 4 + 3] < 20) continue
    opaque++
    const key = ((rgba[i * 4] >> 4) << 8) | ((rgba[i * 4 + 1] >> 4) << 4) | (rgba[i * 4 + 2] >> 4)
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    bin.n++
    bin.r += rgba[i * 4]
    bin.g += rgba[i * 4 + 1]
    bin.b += rgba[i * 4 + 2]
    bins.set(key, bin)
  }
  if (opaque < border.length * 0.2) return null // borda quase toda transparente: use a transparência original

  // junta bins vizinhos em até 4 clusters dominantes
  const sorted = [...bins.values()].sort((a, b) => b.n - a.n)
  const clusters: { r: number; g: number; b: number; n: number; tol: number }[] = []
  for (const bin of sorted) {
    const c = { r: bin.r / bin.n, g: bin.g / bin.n, b: bin.b / bin.n }
    const near = clusters.find((k) => colorDist(k.r, k.g, k.b, c.r, c.g, c.b) < 60)
    if (near) {
      const t = near.n + bin.n
      near.r = (near.r * near.n + bin.r) / t
      near.g = (near.g * near.n + bin.g) / t
      near.b = (near.b * near.n + bin.b) / t
      near.n = t
    } else if (clusters.length < 4 && bin.n >= opaque * 0.04) {
      clusters.push({ ...c, n: bin.n, tol: 0 })
    }
  }
  const main = clusters.filter((c) => c.n >= opaque * 0.08)
  const covered = main.reduce((a, c) => a + c.n, 0) / opaque
  if (!main.length || covered < 0.55) return null

  // tolerância de cada cluster a partir da variação real das cores da borda
  for (const c of main) {
    let sum = 0
    let cnt = 0
    for (const i of border) {
      if (rgba[i * 4 + 3] < 20) continue
      const d = colorDist(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], c.r, c.g, c.b)
      if (d < 120) {
        sum += d * d
        cnt++
      }
    }
    const std = cnt ? Math.sqrt(sum / cnt) : 20
    c.tol = Math.min(150, Math.max(45, 2.5 * std + 30))
  }

  const isBg = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    if (rgba[p * 4 + 3] < 20) {
      isBg[p] = 2
      continue
    }
    for (const c of main) {
      const d = colorDist(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2], c.r, c.g, c.b)
      if (d < c.tol) {
        isBg[p] = d < c.tol * 0.6 ? 2 : 1 // 2 = cor bem próxima do fundo
        break
      }
    }
  }

  // inundação a partir das bordas
  const bg = new Uint8Array(n)
  const stack = new Int32Array(n)
  let sp = 0
  for (const i of border) if (isBg[i] && !bg[i]) (bg[i] = 1), (stack[sp++] = i)
  while (sp) {
    const p = stack[--sp]
    const x = p % w
    if (x > 0 && isBg[p - 1] && !bg[p - 1]) (bg[p - 1] = 1), (stack[sp++] = p - 1)
    if (x < w - 1 && isBg[p + 1] && !bg[p + 1]) (bg[p + 1] = 1), (stack[sp++] = p + 1)
    if (p >= w && isBg[p - w] && !bg[p - w]) (bg[p - w] = 1), (stack[sp++] = p - w)
    if (p < n - w && isBg[p + w] && !bg[p + w]) (bg[p + w] = 1), (stack[sp++] = p + w)
  }

  // "janelas" internas grandes com a cor do fundo também saem
  const seen = new Uint8Array(n)
  const minWindow = n * 0.004
  for (let s = 0; s < n; s++) {
    if (isBg[s] !== 2 || bg[s] || seen[s]) continue
    const region: number[] = []
    sp = 0
    stack[sp++] = s
    seen[s] = 1
    while (sp) {
      const p = stack[--sp]
      region.push(p)
      const x = p % w
      if (x > 0 && isBg[p - 1] === 2 && !seen[p - 1] && !bg[p - 1]) (seen[p - 1] = 1), (stack[sp++] = p - 1)
      if (x < w - 1 && isBg[p + 1] === 2 && !seen[p + 1] && !bg[p + 1]) (seen[p + 1] = 1), (stack[sp++] = p + 1)
      if (p >= w && isBg[p - w] === 2 && !seen[p - w] && !bg[p - w]) (seen[p - w] = 1), (stack[sp++] = p - w)
      if (p < n - w && isBg[p + w] === 2 && !seen[p + w] && !bg[p + w]) (seen[p + w] = 1), (stack[sp++] = p + w)
    }
    if (region.length >= minWindow) for (const p of region) bg[p] = 1
  }

  const mask = new Uint8Array(n)
  for (let p = 0; p < n; p++) mask[p] = bg[p] ? 0 : 255
  let borderBg = 0
  for (const i of border) borderBg += bg[i]
  return { mask: featherEdges(mask, w, h), confidence: borderBg / border.length }
}

// ------------------------------------------------------------------ nota de qualidade

/**
 * Nota 0..1 para uma máscara. Calculada numa versão reduzida (≤160px) para ser rápida.
 *  - fundo deve tocar as bordas; objeto não deve
 *  - o contorno deve passar por arestas reais da imagem (gradiente alto)
 *  - cobertura razoável (nem vazio nem tudo)
 *  - poucos pedaços soltos
 */
export function scoreMask(r: Raster, mask: Uint8Array): number {
  const s = Math.min(1, 160 / Math.max(r.w, r.h))
  const w = Math.max(8, Math.round(r.w * s))
  const h = Math.max(8, Math.round(r.h * s))
  const lum = new Float32Array(w * h)
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(r.w - 1, Math.floor(x / s))
      const sy = Math.min(r.h - 1, Math.floor(y / s))
      const i = sy * r.w + sx
      lum[y * w + x] = 0.299 * r.rgba[i * 4] + 0.587 * r.rgba[i * 4 + 1] + 0.114 * r.rgba[i * 4 + 2]
      m[y * w + x] = mask[i] > 127 ? 1 : 0
    }

  let fg = 0
  for (let i = 0; i < m.length; i++) fg += m[i]
  const cov = fg / m.length
  if (cov < 0.01 || cov > 0.985) return 0.05

  let borderN = 0
  let borderBg = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        borderN++
        if (!m[y * w + x]) borderBg++
      }

  // gradiente (Sobel simplificado)
  const grad = new Float32Array(w * h)
  let gSum = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const gx = lum[p + 1] - lum[p - 1] + 0.5 * (lum[p - w + 1] - lum[p - w - 1] + lum[p + w + 1] - lum[p + w - 1])
      const gy = lum[p + w] - lum[p - w] + 0.5 * (lum[p + w - 1] - lum[p - w - 1] + lum[p + w + 1] - lum[p - w + 1])
      grad[p] = Math.hypot(gx, gy)
      gSum += grad[p]
    }
  const gMean = gSum / (w * h) || 1
  let bSum = 0
  let bN = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      if (m[p] && (!m[p - 1] || !m[p + 1] || !m[p - w] || !m[p + w])) {
        // melhor gradiente na vizinhança 3x3 (tolera contorno 1px fora da aresta)
        let g = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) g = Math.max(g, grad[p + dy * w + dx])
        bSum += g
        bN++
      }
    }
  const edge = bN ? Math.min(1, bSum / bN / (gMean * 3)) : 0

  // pedaços do objeto com área relevante
  const lab = new Int32Array(w * h).fill(-1)
  const stack = new Int32Array(w * h)
  let pieces = 0
  for (let st = 0; st < m.length; st++) {
    if (!m[st] || lab[st] >= 0) continue
    let area = 0
    let sp = 0
    stack[sp++] = st
    lab[st] = st
    while (sp) {
      const p = stack[--sp]
      area++
      const x = p % w
      if (x > 0 && m[p - 1] && lab[p - 1] < 0) (lab[p - 1] = st), (stack[sp++] = p - 1)
      if (x < w - 1 && m[p + 1] && lab[p + 1] < 0) (lab[p + 1] = st), (stack[sp++] = p + 1)
      if (p >= w && m[p - w] && lab[p - w] < 0) (lab[p - w] = st), (stack[sp++] = p - w)
      if (p < m.length - w && m[p + w] && lab[p + w] < 0) (lab[p + w] = st), (stack[sp++] = p + w)
    }
    if (area > m.length * 0.004) pieces++
  }

  const covScore = cov < 0.04 ? cov / 0.04 : cov > 0.9 ? Math.max(0, (0.985 - cov) / 0.085) : 1
  const frag = 1 / (1 + 0.35 * Math.max(0, pieces - 1))
  return 0.32 * (borderBg / borderN) + 0.33 * edge + 0.2 * covScore + 0.15 * frag
}

// ------------------------------------------------------------------ imagens estáticas

export async function autoMaskStatic(r: Raster, onProgress?: Progress, alive = () => true): Promise<StaticResult> {
  const candidates: StaticResult['candidates'] = {}

  const own = ownAlpha(r)
  const ownCov = coverage(own)
  if (ownCov > 0.01 && ownCov < 0.97) candidates.original = own

  const key = colorKeyMask(r)
  if (key && key.confidence > 0.5) candidates.cor = key.mask

  // IA em 3 variações (normal, com margem, espelhada) e média
  const step = (i: number, label: string) => onProgress?.(label, i / 3)
  const masks: Uint8Array[] = []
  step(0, 'Analisando a imagem com IA… (1/3)')
  masks.push(await aiMask(r, onProgress))
  if (!alive()) throw new Error('cancelado')
  try {
    step(1, 'Analisando a imagem com IA… (2/3)')
    const pad = Math.round(Math.max(r.w, r.h) * 0.12)
    const padded = padRaster(r, pad)
    masks.push(cropMask(await aiMask(padded), padded.w, pad, r.w, r.h))
    if (!alive()) throw new Error('cancelado')
    step(2, 'Analisando a imagem com IA… (3/3)')
    masks.push(flipMask(await aiMask(flipRaster(r)), r.w, r.h))
  } catch (e) {
    if ((e as Error).message === 'cancelado') throw e
    /* uma variação falhou: segue com as que deram certo */
  }
  const ia = average(masks)
  candidates.ia = ia

  if (candidates.cor) {
    const k = candidates.cor
    const fused = new Uint8Array(ia.length)
    for (let i = 0; i < ia.length; i++) {
      if (k[i] < 128 && ia[i] < 230) fused[i] = Math.min(ia[i], k[i]) // cor de fundo + IA em dúvida → sai
      else if (k[i] >= 128 && ia[i] > 50) fused[i] = Math.max(ia[i], 200) // IA viu algo e não é cor de fundo → fica
      else fused[i] = ia[i]
    }
    candidates.combinado = fused
  }

  onProgress?.('Escolhendo o melhor recorte…', 1)
  const scores: StaticResult['scores'] = {}
  for (const [k, m] of Object.entries(candidates) as [Method, Uint8Array][]) scores[k] = scoreMask(r, m)
  // pequenas preferências em caso de empate técnico
  if (scores.original !== undefined) scores.original += 0.06
  if (scores.combinado !== undefined) scores.combinado += 0.02

  const order: Method[] = ['original', 'combinado', 'ia', 'cor']
  let best: Method = 'ia'
  for (const k of order) if (scores[k] !== undefined && scores[k]! > (scores[best] ?? -1)) best = k
  return { candidates, scores, best }
}

// ------------------------------------------------------------------ GIFs

export async function autoMaskGif(frames: Raster[], onProgress?: Progress, alive = () => true): Promise<GifResult> {
  const n = frames.length
  const { w, h } = frames[0]
  const size = w * h

  // 1) já transparente
  const own0 = ownAlpha(frames[0])
  const ownCov = coverage(own0)
  if (ownCov > 0.01 && ownCov < 0.97) {
    const masks = frames.map(ownAlpha)
    return { masks, method: 'Transparência original', score: scoreMask(frames[0], masks[0]) }
  }

  // 2) fundo liso → cor em todos os quadros
  onProgress?.('Analisando o fundo do GIF…', 0)
  const sample = [...new Set([0, n >> 1, n - 1])]
  let keyScore = 0
  let keyOk = true
  for (const i of sample) {
    const k = colorKeyMask(frames[i])
    if (!k || k.confidence < 0.8) {
      keyOk = false
      break
    }
    keyScore += scoreMask(frames[i], k.mask)
  }
  keyScore /= sample.length
  if (keyOk && keyScore >= 0.6) {
    const masks: Uint8Array[] = []
    for (let i = 0; i < n; i++) {
      onProgress?.(`Removendo fundo por cor… quadro ${i + 1} de ${n}`, i / n)
      masks.push(colorKeyMask(frames[i])?.mask ?? new Uint8Array(size).fill(255))
      if (i % 6 === 5) await new Promise((r) => setTimeout(r, 0))
    }
    return { masks, method: 'Cor do fundo', score: keyScore }
  }

  // 3) câmera parada? monta o "fundo limpo" (mediana dos quadros)
  let plate: Uint8ClampedArray | null = null
  let staticBg = false
  if (n >= 4) {
    const pick = Array.from({ length: Math.min(n, 15) }, (_, i) => frames[Math.floor((i * n) / Math.min(n, 15))])
    plate = new Uint8ClampedArray(size * 4)
    const vals = new Uint8Array(pick.length)
    for (let p = 0; p < size; p++) {
      for (let c = 0; c < 3; c++) {
        for (let k = 0; k < pick.length; k++) vals[k] = pick[k].rgba[p * 4 + c]
        vals.sort()
        plate[p * 4 + c] = vals[vals.length >> 1]
      }
      plate[p * 4 + 3] = 255
    }
    const border = borderIndices(w, h, 1)
    let still = 0
    for (const p of border) {
      let ok = true
      for (const f of pick) if (pxDist(f.rgba, p, plate, p) > 45) (ok = false)
      if (ok) still++
    }
    staticBg = still / border.length > 0.85
  }

  // 4) IA nos quadros-chave (câmera parada) ou em todos (câmera em movimento)
  const keyCount = staticBg ? Math.min(n, 10) : n
  const keyIdx = Array.from({ length: keyCount }, (_, i) => Math.round((i * (n - 1)) / Math.max(1, keyCount - 1)))
  const uniqueKeys = [...new Set(keyIdx)]
  const keyMasks = new Map<number, Uint8Array>()
  for (let k = 0; k < uniqueKeys.length; k++) {
    if (!alive()) throw new Error('cancelado')
    onProgress?.(`Removendo fundo com IA… quadro ${k + 1} de ${uniqueKeys.length}`, k / uniqueKeys.length)
    keyMasks.set(uniqueKeys[k], await aiMask(frames[uniqueKeys[k]]))
  }

  if (!staticBg || !plate) {
    const masks = frames.map((_, i) => keyMasks.get(i)!)
    return { masks, method: 'IA quadro a quadro', score: scoreMask(frames[0], masks[0]) }
  }

  // 5) propaga: máscara do quadro-chave mais próximo + o que se moveu em relação ao fundo limpo,
  //    tirando "fantasmas" (lugar onde o objeto estava no quadro-chave mas agora mostra o fundo)
  const masks: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const nearest = uniqueKeys.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a))
    const km = keyMasks.get(nearest)!
    if (nearest === i) {
      masks.push(km)
      continue
    }
    const f = frames[i].rgba
    const kf = frames[nearest].rgba
    const out = new Uint8Array(size)
    for (let p = 0; p < size; p++) {
      const dNow = pxDist(f, p, plate, p)
      let v = km[p]
      if (v > 127 && dNow < 25 && pxDist(kf, p, plate, p) > 45) v = 0 // fantasma
      if (dNow > 50) v = Math.max(v, 230) // movimento
      out[p] = v
    }
    masks.push(out)
    if (i % 6 === 5) await new Promise((r) => setTimeout(r, 0))
  }
  return { masks, method: 'IA + movimento', score: scoreMask(frames[0], masks[0]) }
}
