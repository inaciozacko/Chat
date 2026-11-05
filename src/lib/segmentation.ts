/**
 * Motor de segmentação (o "cérebro" da remoção de fundo).
 *
 *  1º  BiRefNet (onnx-community/BiRefNet_lite-ONNX, licença MIT) via Transformers.js
 *      - placa de vídeo (WebGPU) quando disponível: modelo fp16 (~115 MB), ~1 s por imagem
 *      - senão, processador (WASM): modelo fp32 (~224 MB), mais lento
 *      Bem mais preciso que o ISNet para separar o objeto principal (pessoas, bichos, desenhos, objetos).
 *  2º  ISNet (@imgly/background-removal) como reserva, se o BiRefNet não carregar neste aparelho.
 *
 * Os modelos são baixados uma única vez e ficam no cache do navegador.
 */
import type { Progress, Raster } from './sticker'

export type Engine = {
  name: string
  /** WebGPU: rápido o bastante para processar todos os quadros de um GIF */
  fast: boolean
  run: (r: Raster) => Promise<Uint8Array>
}

const BIREFNET = 'onnx-community/BiRefNet_lite-ONNX'

let enginePromise: Promise<Engine> | null = null
let progressListener: Progress | undefined

export function getEngine(onProgress?: Progress): Promise<Engine> {
  progressListener = onProgress
  if (!enginePromise) {
    enginePromise = loadEngine().catch((e) => {
      enginePromise = null // permite tentar de novo depois
      throw e
    })
  }
  return enginePromise
}

async function hasWebGPU() {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    return !!gpu && !!(await gpu.requestAdapter())
  } catch {
    return false
  }
}

async function loadEngine(): Promise<Engine> {
  const webgpu = await hasWebGPU()
  const attempts: ('webgpu' | 'wasm')[] = webgpu ? ['webgpu', 'wasm'] : ['wasm']
  for (const device of attempts) {
    try {
      return await loadBiRefNet(device)
    } catch (e) {
      console.warn(`BiRefNet (${device}) indisponível:`, e)
    }
  }
  return loadISNet()
}

async function loadBiRefNet(device: 'webgpu' | 'wasm'): Promise<Engine> {
  const { AutoModel, AutoProcessor, RawImage, env } = await import('@huggingface/transformers')
  env.allowLocalModels = false
  const label = device === 'webgpu' ? 'Baixando IA de alta precisão (só na primeira vez)…' : 'Baixando IA de alta precisão (só na primeira vez, ~220 MB)…'
  const progress_callback = (p: { status: string; progress?: number }) => {
    if (p.status === 'progress_total' && typeof p.progress === 'number') progressListener?.(label, p.progress / 100)
  }
  const model = await AutoModel.from_pretrained(BIREFNET, {
    device,
    dtype: device === 'webgpu' ? 'fp16' : 'fp32',
    progress_callback,
  })
  const processor = await AutoProcessor.from_pretrained(BIREFNET, { progress_callback })

  const run = async (r: Raster) => {
    const image = new RawImage(new Uint8ClampedArray(r.rgba), r.w, r.h, 4).rgb()
    const { pixel_values } = await processor(image)
    const { output_image } = await model({ input_image: pixel_values })
    const matte = await RawImage.fromTensor(output_image[0].sigmoid().mul(255).to('uint8')).resize(r.w, r.h)
    const out = new Uint8Array(r.w * r.h)
    const ch = matte.channels
    for (let i = 0; i < out.length; i++) out[i] = matte.data[i * ch]
    return out
  }

  // teste rápido: algumas placas de vídeo ficam sem memória só na hora de rodar
  progressListener?.('Preparando a IA…', 1)
  await run({ w: 64, h: 64, rgba: new Uint8ClampedArray(64 * 64 * 4).fill(200) })
  return { name: 'BiRefNet', fast: device === 'webgpu', run }
}

async function loadISNet(): Promise<Engine> {
  const { aiMask } = await import('./sticker')
  return { name: 'ISNet', fast: false, run: (r) => aiMask(r, progressListener) }
}
