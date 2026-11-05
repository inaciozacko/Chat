import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCall } from './callStore'
import { useChat } from '../../store/chat'
import { IconHangup, IconMic, IconMicOff, IconPhone, IconVideo, IconVideoOff } from '../../lib/icons'
import { Avatar } from '../common'
import { cx, formatDuration } from '../../lib/utils'

function useRingtone(active: boolean, incoming: boolean) {
  useEffect(() => {
    if (!active) return
    let ctx: AudioContext | null = null
    try {
      ctx = new AudioContext()
    } catch {
      return
    }
    const ring = () => {
      if (!ctx) return
      const freqs = incoming ? [523, 659] : [440]
      freqs.forEach((f, i) => {
        const o = ctx!.createOscillator()
        const g = ctx!.createGain()
        o.frequency.value = f
        const t0 = ctx!.currentTime + i * 0.18
        g.gain.setValueAtTime(0.0001, t0)
        g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.03)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + (incoming ? 0.35 : 1.2))
        o.connect(g).connect(ctx!.destination)
        o.start(t0)
        o.stop(t0 + 1.3)
      })
    }
    ring()
    const iv = setInterval(ring, incoming ? 1500 : 3000)
    return () => {
      clearInterval(iv)
      ctx?.close()
    }
  }, [active, incoming])
}

export function CallScreen() {
  const c = useCall()
  const profiles = useChat((s) => s.profiles)
  const localRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [, tick] = useState(0)

  useRingtone(c.phase === 'incoming' || (c.phase === 'outgoing' && c.ringing), c.phase === 'incoming')

  useEffect(() => {
    if (localRef.current) localRef.current.srcObject = c.local
  }, [c.local, c.phase])
  useEffect(() => {
    if (audioRef.current) audioRef.current.srcObject = c.remote
  }, [c.remote, c.phase])
  useEffect(() => {
    if (c.phase !== 'connected') return
    const iv = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(iv)
  }, [c.phase])

  if (c.phase === 'idle') return null
  const peer = profiles[c.peerId ?? '']
  const remoteHasVideo = (c.remote?.getVideoTracks().length ?? 0) > 0
  const status =
    c.phase === 'incoming'
      ? c.video
        ? 'Chamada de vídeo recebida'
        : 'Chamada de voz recebida'
      : c.phase === 'outgoing'
        ? c.ringing
          ? 'Tocando...'
          : 'Chamando...'
        : c.phase === 'connecting'
          ? 'Conectando...'
          : c.phase === 'connected'
            ? formatDuration((Date.now() - (c.startedAt ?? Date.now())) / 1000)
            : c.endReason ?? 'Chamada encerrada'

  return createPortal(
    <div className={cx('call-screen', c.video && 'video')}>
      <audio ref={audioRef} autoPlay />
      {c.video && c.phase === 'connected' && remoteHasVideo ? (
        <video
          ref={(el) => {
            if (el && el.srcObject !== c.remote) el.srcObject = c.remote
          }}
          className="call-remote"
          autoPlay
          playsInline
        />
      ) : (
        <div className="call-center">
          <Avatar url={peer?.avatar_url} size={140} />
          <h2>{peer?.full_name ?? 'Contato'}</h2>
          <div className="call-status">{status}</div>
          <div className="call-e2e">🔒 Chamada ponto a ponto (WebRTC)</div>
        </div>
      )}
      {c.video && c.phase === 'connected' && remoteHasVideo && (
        <div className="call-overlay-info">
          <strong>{peer?.full_name}</strong> · {status}
        </div>
      )}
      {c.video && c.local && c.phase !== 'ended' && (
        <video ref={localRef} className={cx('call-local', !c.camOn && 'off')} autoPlay playsInline muted />
      )}
      <div className="call-controls">
        {c.phase === 'incoming' ? (
          <>
            <button className="call-btn hang" onClick={c.reject} title="Recusar">
              <IconHangup />
            </button>
            <button className="call-btn accept" onClick={c.accept} title="Atender">
              {c.video ? <IconVideo /> : <IconPhone />}
            </button>
          </>
        ) : c.phase === 'ended' ? null : (
          <>
            {c.video && (
              <button className={cx('call-btn', !c.camOn && 'off')} onClick={c.toggleCam} title="Câmera">
                {c.camOn ? <IconVideo /> : <IconVideoOff />}
              </button>
            )}
            <button className={cx('call-btn', !c.micOn && 'off')} onClick={c.toggleMic} title="Microfone">
              {c.micOn ? <IconMic /> : <IconMicOff />}
            </button>
            <button className="call-btn hang" onClick={() => c.hangup()} title="Desligar">
              <IconHangup />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
