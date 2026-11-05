/**
 * Remoção de fundo "melhor esforço" — tenta várias estratégias e escolhe a melhor automaticamente.
 *
 * A IA é o BiRefNet (ver segmentation.ts), com o ISNet como reserva.
 *
 * Imagens estáticas
 *   - "ia":        IA na imagem normal + espelhada (média)
 *   - "cor":       detecta a(s) cor(es) de fundo pelas bordas e remove (fundos lisos, logos, desenhos, prints)
 *   - "combinado": IA + cor, conservador: só apaga onde as duas concordam que é fundo
 *   - "original":  transparência que a imagem já tinha
 *   Cada candidato recebe uma nota (bordas, contorno alinhado às arestas da imagem, cobertura, fragmentação).
 *
 * GIFs
 *   - IA em todos os quadros (placa de vídeo) ou em até 16 quadros-chave (processador)
 *   - suavização no tempo: um quadro em que o objeto "sumiu" é corrigido pelos vizinhos
 *   - fundo liso: a cor só limpa sobras onde a IA também diz que é fundo (nunca apaga o objeto)
 */
import { coverage, ownAlpha, type Progress, type Raster } from './sticker'
import { getEngine } from './segmentation'

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

/** Funde IA e cor de forma CONSERVADORA: só apaga onde a cor diz "fundo" e a IA também acha que é fundo */
function fuse(ia: Uint8Array, key: Uint8Array) {
  const out = new Uint8Array(ia.length)
  for (let i = 0; i < ia.length; i++) {
    if (key[i] < 128 && ia[i] < 110) out[i] = Math.min(ia[i], key[i]) // os dois concordam: fundo
    else if (key[i] >= 128 && ia[i] > 50) out[i] = Math.max(ia[i], 210) // IA viu algo que não é cor de fundo: fica
    else out[i] = ia[i] // na dúvida, vale a IA (protege o objeto principal)
  }
  return out
}

export async function autoMaskStatic(r: Raster, onProgress?: Progress, alive = () => true): Promise<StaticResult> {
  const candidates: StaticResult['candidates'] = {}

  const own = ownAlpha(r)
  const ownCov = coverage(own)
  if (ownCov > 0.01 && ownCov < 0.97) candidates.original = own

  const key = colorKeyMask(r)
  if (key && key.confidence > 0.5) candidates.cor = key.mask

  onProgress?.('Carregando a IA…', 0)
  const engine = await getEngine(onProgress)
  if (!alive()) throw new Error('cancelado')

  // IA: imagem normal + espelhada (média das duas corrige erros de um lado só).
  // No modelo reserva (ISNet) também roda com margem em volta, que ajuda quando o objeto encosta na borda.
  const masks: Uint8Array[] = []
  onProgress?.(`Separando o objeto principal (${engine.name})…`, 0.2)
  masks.push(await engine.run(r))
  if (!alive()) throw new Error('cancelado')
  try {
    onProgress?.(`Conferindo o recorte (${engine.name})…`, 0.55)
    masks.push(flipMask(await engine.run(flipRaster(r)), r.w, r.h))
    if (engine.name === 'ISNet') {
      if (!alive()) throw new Error('cancelado')
      const pad = Math.round(Math.max(r.w, r.h) * 0.12)
      const padded = padRaster(r, pad)
      masks.push(cropMask(await engine.run(padded), padded.w, pad, r.w, r.h))
    }
  } catch (e) {
    if ((e as Error).message === 'cancelado') throw e
    /* variação extra falhou: segue com o que já tem */
  }
  candidates.ia = average(masks)
  if (candidates.cor) candidates.combinado = fuse(candidates.ia, candidates.cor)

  onProgress?.('Escolhendo o melhor recorte…', 1)
  const scores: StaticResult['scores'] = {}
  for (const [k, m] of Object.entries(candidates) as [Method, Uint8Array][]) scores[k] = scoreMask(r, m)
  // preferências: a IA nova é a referência; "cor" sozinha só ganha com folga (ela pode comer partes do objeto)
  if (scores.original !== undefined) scores.original += 0.06
  if (scores.ia !== undefined) scores.ia += engine.name === 'BiRefNet' ? 0.05 : 0
  if (scores.combinado !== undefined) scores.combinado += 0.03
  if (scores.cor !== undefined) scores.cor -= 0.06

  const order: Method[] = ['original', 'ia', 'combinado', 'cor']
  let best: Method = 'ia'
  for (const k of order) if (scores[k] !== undefined && scores[k]! > (scores[best] ?? -1)) best = k
  return { candidates, scores, best }
}

// ------------------------------------------------------------------ GIFs

/**
 * Suavização no tempo: mediana do quadro com os vizinhos.
 * Se a IA "perder" o objeto em um quadro isolado (ou inventar um pedaço), os vizinhos corrigem.
 */
export function temporalMedian(masks: Uint8Array[]): Uint8Array[] {
  const n = masks.length
  if (n < 3) return masks
  return masks.map((cur, i) => {
    const a = masks[(i - 1 + n) % n] // GIF é em loop: o vizinho do 1º é o último
    const b = masks[(i + 1) % n]
    const out = new Uint8Array(cur.length)
    for (let p = 0; p < cur.length; p++) {
      const x = a[p]
      const y = cur[p]
      const z = b[p]
      out[p] = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z))
    }
    return out
  })
}

export async function autoMaskGif(frames: Raster[], onProgress?: Progress, alive = () => true): Promise<GifResult> {
  const n = frames.length

  // 1) já transparente
  const ownCov = coverage(ownAlpha(frames[0]))
  if (ownCov > 0.01 && ownCov < 0.97) {
    const masks = frames.map(ownAlpha)
    return { masks, method: 'Transparência original', score: scoreMask(frames[0], masks[0]) }
  }

  // 2) IA. Com placa de vídeo roda em TODOS os quadros (mais fiel); no processador, em até 16 quadros-chave
  onProgress?.('Carregando a IA…', 0)
  const engine = await getEngine(onProgress)
  const keyCount = engine.fast ? n : Math.min(n, 16)
  const keys = [...new Set(Array.from({ length: keyCount }, (_, i) => Math.round((i * (n - 1)) / Math.max(1, keyCount - 1))))]
  const keyMasks = new Map<number, Uint8Array>()
  for (let k = 0; k < keys.length; k++) {
    if (!alive()) throw new Error('cancelado')
    onProgress?.(`Separando o objeto principal… quadro ${k + 1} de ${keys.length}`, k / keys.length)
    keyMasks.set(keys[k], await engine.run(frames[keys[k]]))
  }
  let masks = frames.map((_, i) => {
    const exact = keyMasks.get(i)
    if (exact) return exact
    const nearest = keys.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a))
    return keyMasks.get(nearest)!
  })

  // 3) suavização no tempo (corrige quadros em que o objeto "sumiu")
  masks = temporalMedian(masks)

  // 4) fundo liso: a cor ajuda a limpar sobras, mas só onde a IA também diz que é fundo
  const sample = colorKeyMask(frames[0])
  let method = keys.length === n ? `IA ${engine.name} em todos os quadros` : `IA ${engine.name} em ${keys.length} quadros-chave`
  if (sample && sample.confidence > 0.85) {
    masks = masks.map((m, i) => {
      const k = i === 0 ? sample : colorKeyMask(frames[i])
      return k ? fuse(m, k.mask) : m
    })
    method += ' + cor do fundo'
  }
  return { masks, method, score: scoreMask(frames[0], masks[0]) }
}
