import { useEffect, useRef, useState } from 'react'
import { IconMic, IconPause, IconPlay } from '../../lib/icons'
import { Avatar } from '../common'
import { cx, formatDuration } from '../../lib/utils'

// apenas um áudio tocando por vez, como no original
let currentlyPlaying: HTMLAudioElement | null = null

/** Barras pseudo-aleatórias estáveis por URL para simular a forma de onda */
function bars(seed: string, n = 40) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    out.push(0.25 + ((h >>> 0) % 1000) / 1333)
  }
  return out
}

export function AudioPlayer({
  src,
  duration: initialDuration,
  avatar,
  outgoing,
  played,
}: {
  src: string
  duration?: number | null
  avatar?: string | null
  outgoing: boolean
  played?: boolean
}) {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(Number(initialDuration) || 0)
  const [rate, setRate] = useState(1)
  const wave = useRef(bars(src)).current

  useEffect(() => {
    const a = ref.current
    if (!a) return
    const onTime = () => setTime(a.currentTime)
    const onMeta = () => {
      if (isFinite(a.duration) && a.duration > 0) setDuration(a.duration)
    }
    const onEnd = () => {
      setPlaying(false)
      setTime(0)
    }
    const onPause = () => setPlaying(false)
    const onPlay = () => setPlaying(true)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('loadedmetadata', onMeta)
    a.addEventListener('durationchange', onMeta)
    a.addEventListener('ended', onEnd)
    a.addEventListener('pause', onPause)
    a.addEventListener('play', onPlay)
    return () => {
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('loadedmetadata', onMeta)
      a.removeEventListener('durationchange', onMeta)
      a.removeEventListener('ended', onEnd)
      a.removeEventListener('pause', onPause)
      a.removeEventListener('play', onPlay)
    }
  }, [])

  const toggle = () => {
    const a = ref.current!
    if (playing) a.pause()
    else {
      if (currentlyPlaying && currentlyPlaying !== a) currentlyPlaying.pause()
      currentlyPlaying = a
      a.playbackRate = rate
      a.play()
    }
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = ref.current!
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    if (duration) a.currentTime = ratio * duration
    setTime(a.currentTime)
  }

  const progress = duration ? time / duration : 0

  return (
    <div className={cx('audio-player', outgoing && 'out')}>
      <audio ref={ref} src={src} preload="metadata" />
      {!outgoing && (
        <div className="audio-avatar">
          <Avatar url={avatar} size={46} />
          <IconMic size={18} className={cx('audio-mic', played && 'played')} />
        </div>
      )}
      <button className="audio-play" onClick={toggle} aria-label={playing ? 'Pausar' : 'Reproduzir'}>
        {playing ? <IconPause size={30} /> : <IconPlay size={30} />}
      </button>
      <div className="audio-main">
        <div className="audio-wave" onClick={seek}>
          {wave.map((h, i) => (
            <span key={i} className={cx(i / wave.length < progress && 'on')} style={{ height: `${h * 100}%` }} />
          ))}
          <span className="audio-knob" style={{ left: `${progress * 100}%` }} />
        </div>
        <div className="audio-meta">
          <span>{formatDuration(playing || time ? time : duration)}</span>
        </div>
      </div>
      {playing ? (
        <button
          className="audio-rate"
          onClick={() => {
            const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1
            setRate(next)
            if (ref.current) ref.current.playbackRate = next
          }}
        >
          {rate}×
        </button>
      ) : (
        outgoing && (
          <div className="audio-avatar">
            <Avatar url={avatar} size={46} />
            <IconMic size={18} className={cx('audio-mic', played && 'played')} />
          </div>
        )
      )}
    </div>
  )
}
