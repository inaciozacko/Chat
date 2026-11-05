/**
 * Pipeline de criação de figurinhas:
 *  1. remove o fundo da imagem no próprio navegador (@imgly/background-removal, modelo ONNX)
 *  2. recorta a área útil (pixels não transparentes)
 *  3. centraliza em 512x512, aplica contorno branco e texto opcional
 *  4. exporta em WebP (formato de figurinha) com fallback para PNG
 */

export type RemoveProgress = (label: string, ratio: number) => void

const SIZE = 512

export async function removeImageBackground(file: Blob, onProgress?: RemoveProgress): Promise<Blob> {
  // import dinâmico: o modelo (~40MB) só é baixado quando o usuário cria a primeira figurinha
  const { removeBackground } = await import('@imgly/background-removal')
  return removeBackground(file, {
    model: 'isnet_fp16',
    output: { format: 'image/png', quality: 1 },
    progress: (key, current, total) => {
      const label = key.startsWith('fetch') ? 'Baixando modelo de IA…' : 'Removendo fundo…'
      onProgress?.(label, total ? current / total : 0)
    },
  })
}

export function loadImage(src: Blob | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = typeof src === 'string' ? src : URL.createObjectURL(src)
  })
}

/** Bounding box dos pixels com alpha > limiar */
function alphaBounds(img: HTMLImageElement) {
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 12) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: width, h: height }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

export type StickerOptions = {
  outline: boolean
  outlineColor?: string
  outlineWidth?: number
  text?: string
  textColor?: string
  /** quando false, mantém a imagem inteira (sem recortar pela transparência) */
  trim?: boolean
  /** recorte circular (útil quando o fundo não foi removido) */
  shape?: 'free' | 'circle' | 'rounded'
}

export async function composeSticker(source: Blob, opts: StickerOptions): Promise<Blob> {
  const img = await loadImage(source)
  const border = opts.outline ? (opts.outlineWidth ?? 14) : 0
  const pad = border + 8
  const box = opts.trim === false ? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight } : alphaBounds(img)

  const avail = SIZE - pad * 2
  const scale = Math.min(avail / box.w, avail / box.h)
  const dw = box.w * scale
  const dh = box.h * scale
  const dx = (SIZE - dw) / 2
  const dy = (SIZE - dh) / 2

  // camada base (imagem recortada, com forma opcional)
  const base = document.createElement('canvas')
  base.width = base.height = SIZE
  const b = base.getContext('2d')!
  b.imageSmoothingQuality = 'high'
  if (opts.shape === 'circle' || opts.shape === 'rounded') {
    b.save()
    b.beginPath()
    if (opts.shape === 'circle') {
      const r = Math.min(dw, dh) / 2
      b.arc(SIZE / 2, SIZE / 2, r, 0, Math.PI * 2)
    } else {
      b.roundRect(dx, dy, dw, dh, Math.min(dw, dh) * 0.12)
    }
    b.clip()
    b.drawImage(img, box.x, box.y, box.w, box.h, dx, dy, dw, dh)
    b.restore()
  } else {
    b.drawImage(img, box.x, box.y, box.w, box.h, dx, dy, dw, dh)
  }

  const out = document.createElement('canvas')
  out.width = out.height = SIZE
  const o = out.getContext('2d')!

  if (border > 0) {
    // contorno: desenha a silhueta deslocada em círculo e pinta de branco
    const sil = document.createElement('canvas')
    sil.width = sil.height = SIZE
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

  return canvasToBlob(out)
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (webp) => {
        if (webp && webp.type === 'image/webp') return resolve(webp)
        canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('Falha ao gerar figurinha'))), 'image/png')
      },
      'image/webp',
      0.92,
    )
  })
}
