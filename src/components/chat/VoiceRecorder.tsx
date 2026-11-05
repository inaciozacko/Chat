import { useCallback, useEffect, useRef, useState } from 'react'
import { IconChevronDown, IconLock, IconMic, IconPause, IconTrash } from '../../lib/icons'
import { cx, formatDuration } from '../../lib/utils'

/**
 * Gravação de mensagens de voz (MediaRecorder).
 * Formato: AAC/MP4 quando o navegador grava (toca em todos, inclusive iPhone); senão Opus/WebM.
 */

export type RecState = 'idle' | 'starting' | 'recording' | 'paused'

const MAX_SECONDS = 15 * 60
const MIN_SECONDS = 1

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return ''
  const options = [
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ]
  return options.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? ''
}

function extFor(mime: string) {
  const base = mime.split(';')[0]
  if (base === 'audio/mp4') return 'm4a'
  if (base === 'audio/ogg') return 'ogg'
  return 'webm'
}

type Session = {
  rec: MediaRecorder
  stream: MediaStream
  ctx: AudioContext | null
  chunks: Blob[]
  mime: string
  accumulated: number // ms gravados antes da última pausa
  resumedAt: number
  paused: boolean
  timer: number
}

const seconds = (s: Session) => (s.accumulated + (s.paused ? 0 : Date.now() - s.resumedAt)) / 1000

export function useVoiceRecorder({
  onDone,
  onError,
  onTick,
}: {
  onDone: (file: File, seconds: number) => void
  onError: (msg: string) => void
  onTick?: () => void
}) {
  const [state, setState] = useState<RecState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [levels, setLevels] = useState<number[]>([])
  const session = useRef<Session | null>(null)
  const starting = useRef(false)
  const abortStart = useRef(false)
  // callbacks sempre atualizados sem recriar as funções abaixo
  const cb = useRef({ onDone, onError, onTick })
  useEffect(() => {
    cb.current = { onDone, onError, onTick }
  })

  const finish = useCallback((send: boolean) => {
    const cur = session.current
    if (!cur) {
      if (starting.current) abortStart.current = true // soltou antes de o microfone abrir
      return
    }
    session.current = null
    window.clearInterval(cur.timer)
    cur.ctx?.close().catch(() => {})
    const secs = seconds(cur)
    const done = () => {
      cur.stream.getTracks().forEach((t) => t.stop())
      if (!send) return
      if (secs < MIN_SECONDS) return cb.current.onError('Segure para gravar, solte para enviar')
      const type = (cur.rec.mimeType || cur.mime || 'audio/webm').split(';')[0]
      const blob = new Blob(cur.chunks, { type })
      if (!blob.size) return cb.current.onError('Não foi possível gravar o áudio')
      cb.current.onDone(new File([blob], `audio-${Date.now()}.${extFor(type)}`, { type }), Math.max(1, Math.round(secs)))
    }
    if (cur.rec.state !== 'inactive') {
      cur.rec.onstop = done
      cur.rec.stop()
    } else done()
    setState('idle')
    setElapsed(0)
    setLevels([])
  }, [])

  const start = useCallback(async () => {
    if (session.current || starting.current) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      cb.current.onError('Este navegador não permite gravar áudio')
      return
    }
    starting.current = true
    abortStart.current = false
    setState('starting')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (e) {
      starting.current = false
      setState('idle')
      cb.current.onError(
        (e as DOMException)?.name === 'NotAllowedError'
          ? 'Permita o acesso ao microfone nas configurações do navegador'
          : 'Não foi possível acessar o microfone',
      )
      return
    }
    starting.current = false
    if (abortStart.current) {
      // soltou o botão enquanto o navegador pedia permissão
      stream.getTracks().forEach((t) => t.stop())
      setState('idle')
      return
    }

    const mime = pickMime()
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined)
    } catch {
      rec = new MediaRecorder(stream)
    }
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)

    // medidor de volume para a onda ao vivo
    let ctx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    try {
      ctx = new AudioContext()
      ctx.resume().catch(() => {})
      analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
    } catch {
      ctx = null
    }
    const buf = new Uint8Array(analyser?.fftSize ?? 0)

    const s: Session = { rec, stream, ctx, chunks, mime, accumulated: 0, resumedAt: Date.now(), paused: false, timer: 0 }
    s.timer = window.setInterval(() => {
      if (session.current !== s) return
      const secs = seconds(s)
      setElapsed(secs)
      if (!s.paused) {
        let level = 0.08
        if (analyser) {
          analyser.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128
            sum += v * v
          }
          level = Math.min(1, Math.max(0.08, Math.sqrt(sum / buf.length) * 4))
        }
        setLevels((l) => [...l.slice(-59), level])
        cb.current.onTick?.()
      }
      if (secs >= MAX_SECONDS) finish(true)
    }, 100)

    // se o microfone for desconectado no meio da gravação, envia o que já foi gravado
    stream.getAudioTracks()[0]?.addEventListener('ended', () => session.current === s && finish(true))

    session.current = s
    rec.start(250)
    setState('recording')
  }, [finish])

  const pause = useCallback(() => {
    const s = session.current
    if (!s || s.paused || s.rec.state !== 'recording') return
    try {
      s.rec.pause()
    } catch {
      return
    }
    s.accumulated += Date.now() - s.resumedAt
    s.paused = true
    setState('paused')
  }, [])

  const resume = useCallback(() => {
    const s = session.current
    if (!s || !s.paused) return
    try {
      s.rec.resume()
    } catch {
      return
    }
    s.resumedAt = Date.now()
    s.paused = false
    setState('recording')
  }, [])

  // sai da conversa / fecha a tela: descarta
  useEffect(() => () => finish(false), [finish])

  return {
    state,
    active: state !== 'idle',
    elapsed,
    levels,
    canPause: typeof MediaRecorder !== 'undefined' && 'pause' in MediaRecorder.prototype,
    start,
    pause,
    resume,
    send: () => finish(true),
    cancel: () => finish(false),
  }
}

export type VoiceRecorder = ReturnType<typeof useVoiceRecorder>

function Wave({ levels }: { levels: number[] }) {
  const bars = Array.from({ length: 60 }, (_, i) => levels[levels.length - 60 + i] ?? 0)
  return (
    <div className="rec-wave" aria-hidden="true">
      {bars.map((v, i) => (
        <span key={i} style={{ height: `${Math.max(8, v * 100)}%`, opacity: v ? 1 : 0.35 }} />
      ))}
    </div>
  )
}

/** Barra com o áudio travado (computador, ou celular depois de deslizar para cima) */
export function RecordingBar({ rec }: { rec: VoiceRecorder }) {
  return (
    <div className="rec-bar">
      <button className="icon-btn" onClick={rec.cancel} title="Descartar" aria-label="Descartar áudio">
        <IconTrash />
      </button>
      <span className={cx('rec-dot', rec.state === 'paused' && 'paused')} />
      <span className="rec-time">{formatDuration(rec.elapsed)}</span>
      <Wave levels={rec.levels} />
      {rec.canPause &&
        (rec.state === 'paused' ? (
          <button className="icon-btn rec-resume" onClick={rec.resume} title="Continuar gravando">
            <IconMic />
          </button>
        ) : (
          <button className="icon-btn rec-pause" onClick={rec.pause} title="Pausar" disabled={rec.state !== 'recording'}>
            <IconPause />
          </button>
        ))}
    </div>
  )
}

/** Barra enquanto segura o botão no celular: tempo + "deslize para cancelar" */
export function HoldBar({ rec, dx }: { rec: VoiceRecorder; dx: number }) {
  return (
    <div className="rec-bar holding">
      <span className="rec-mic-blink">
        <IconMic size={22} />
      </span>
      <span className="rec-time">{rec.state === 'starting' ? '0:00' : formatDuration(rec.elapsed)}</span>
      <span className="rec-slide" style={{ transform: `translateX(${Math.min(0, dx)}px)`, opacity: Math.max(0.2, 1 + dx / 140) }}>
        ‹ Deslize para cancelar
      </span>
    </div>
  )
}

/** Cadeado acima do botão (deslize para cima para gravar sem segurar) */
export function LockHint({ dy }: { dy: number }) {
  const lift = Math.min(0, Math.max(-60, dy))
  return (
    <div className="rec-lock" style={{ transform: `translateY(${lift}px)` }}>
      <IconLock size={18} />
      <IconChevronDown size={18} style={{ transform: 'rotate(180deg)' }} />
    </div>
  )
}
