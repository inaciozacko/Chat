/**
 * Helpers de câmera (frontal/traseira) usados pela câmera do chat e pelas chamadas de vídeo.
 */

export type Facing = 'user' | 'environment'

const SIZE = { width: { ideal: 1280 }, height: { ideal: 720 } }

/** Celular/tablet abre na traseira (como no app original); computador, na webcam */
export function defaultFacing(): Facing {
  try {
    return matchMedia('(pointer: coarse)').matches ? 'environment' : 'user'
  } catch {
    return 'user'
  }
}

export async function countCameras(): Promise<number> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'videoinput').length
  } catch {
    return 0
  }
}

/**
 * Abre só o vídeo da câmera pedida.
 * 1) tenta exatamente a câmera frontal/traseira (celulares);
 * 2) se o aparelho não informa o lado (webcams), passa para a próxima câmera da lista;
 * 3) por último, qualquer câmera.
 * Importante: no celular, pare a câmera atual ANTES de chamar (muitos aparelhos não abrem duas ao mesmo tempo).
 */
export async function openCamera(facing: Facing, previousDeviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { ...SIZE, facingMode: { exact: facing } } })
  } catch (e) {
    if ((e as DOMException)?.name === 'NotAllowedError') throw e
  }
  if (previousDeviceId) {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
    if (cams.length > 1) {
      const i = cams.findIndex((c) => c.deviceId === previousDeviceId)
      const next = cams[(i + 1) % cams.length]
      try {
        return await navigator.mediaDevices.getUserMedia({ video: { ...SIZE, deviceId: { exact: next.deviceId } } })
      } catch {
        /* cai no pedido genérico */
      }
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: { ...SIZE, facingMode: { ideal: facing } } })
}

/** A imagem deve aparecer espelhada? (só a câmera frontal, como num espelho) */
export function isMirrored(stream: MediaStream | null, facing: Facing): boolean {
  const reported = stream?.getVideoTracks()[0]?.getSettings().facingMode
  if (reported === 'user') return true
  if (reported === 'environment') return false
  return facing === 'user'
}

export function deviceIdOf(stream: MediaStream | null): string | undefined {
  return stream?.getVideoTracks()[0]?.getSettings().deviceId
}
