import { useEffect, useRef, useState } from 'react'
import { decodeGif } from '../../lib/sticker'

type Decoded = { w: number; h: number; frames: { bmp: ImageBitmap; delay: number }[] }

// cada GIF é baixado e decodificado uma única vez, mesmo aparecendo em várias mensagens
const cache = new Map<string, Promise<Decoded>>()

function load(url: string) {
  let p = cache.get(url)
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.arrayBuffer()
      })
      .then((buf) => decodeGif(buf, 512))
      .then(async (g) => ({
        w: g.w,
        h: g.h,
        frames: await Promise.all(
          g.frames.map(async (f) => ({
            bmp: await createImageBitmap(new ImageData(new Uint8ClampedArray(f.rgba), f.w, f.h)),
            delay: f.delay,
          })),
        ),
      }))
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

/**
 * Figurinha animada (GIF) desenhada em canvas, com controle de repetição:
 *  - trigger "visible": toca `loops` vezes quando aparece na tela e para (clique toca de novo)
 *  - trigger "hover": fica parada no 1º quadro e anima enquanto o mouse está em cima
 */
export function AnimatedSticker({
  url,
  className,
  loops = 3,
  trigger = 'visible',
}: {
  url: string
  className?: string
  loops?: number
  trigger?: 'visible' | 'hover'
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const data = useRef<Decoded | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const playedOnce = useRef(false)
  const [failed, setFailed] = useState(false)

  const draw = (i: number) => {
    const c = ref.current
    const d = data.current
    if (!c || !d) return
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.drawImage(d.frames[i].bmp, 0, 0)
  }

  const stop = (frame?: number) => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    if (frame !== undefined) draw(frame)
  }

  const play = (times: number) => {
    const d = data.current
    if (!d) return
    stop()
    if (d.frames.length < 2) return draw(0)
    let i = 0
    let loop = 0
    const step = () => {
      draw(i)
      const delay = d.frames[i].delay
      i++
      if (i >= d.frames.length) {
        i = 0
        loop++
        // terminou a última volta: fica parado no último quadro, como no original
        if (loop >= times) {
          timer.current = undefined
          return
        }
      }
      timer.current = window.setTimeout(step, delay)
    }
    step()
  }

  useEffect(() => {
    let alive = true
    let io: IntersectionObserver | null = null
    setFailed(false)
    playedOnce.current = false
    load(url)
      .then((d) => {
        if (!alive || !ref.current) return
        data.current = d
        ref.current.width = d.w
        ref.current.height = d.h
        draw(0)
        if (trigger === 'visible') {
          io = new IntersectionObserver(
            ([entry]) => {
              if (entry.isIntersecting && !playedOnce.current) {
                playedOnce.current = true
                play(loops)
              }
            },
            { threshold: 0.5 },
          )
          io.observe(ref.current)
        }
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
      io?.disconnect()
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, trigger, loops])

  if (failed) return <img className={className} src={url} alt="Figurinha" draggable={false} />

  return (
    <canvas
      ref={ref}
      className={className}
      role="img"
      aria-label="Figurinha animada"
      onClick={trigger === 'visible' ? () => play(loops) : undefined}
      onMouseEnter={trigger === 'hover' ? () => play(Infinity) : undefined}
      onMouseLeave={trigger === 'hover' ? () => stop(0) : undefined}
    />
  )
}
