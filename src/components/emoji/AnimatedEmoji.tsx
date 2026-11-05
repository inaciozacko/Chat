import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ANIMATED_CODES } from '../../lib/animatedEmojiData'
import { useChat } from '../../store/chat'
import { cx } from '../../lib/utils'

/**
 * Emojis animados (estilo Microsoft Teams), usando o Noto Emoji do Google (CC BY 4.0).
 * - Todos os emojis aparecem no estilo 3D do Google (imagem estática leve, ~7 KB, com cache).
 * - Os 881 que têm animação ganham a animação Lottie (~60 KB, vetorial) por cima.
 * - O emoji de verdade continua no texto (invisível), então copiar/selecionar funciona normalmente.
 */

const BASE = 'https://fonts.gstatic.com/s/e/notoemoji/latest'

// chave sem o seletor de variação FE0F → código real do arquivo animado
const LOOKUP = new Map<string, string>()
for (const code of ANIMATED_CODES.split(/\s+/)) {
  if (code) LOOKUP.set(code.replace(/_fe0f/g, ''), code)
}

function hexes(emoji: string) {
  return [...emoji].map((c) => c.codePointAt(0)!.toString(16)).filter((c) => c !== 'fe0f')
}

export function animatedCode(emoji: string): string | null {
  return LOOKUP.get(hexes(emoji).join('_')) ?? null
}

/** Imagem estática do emoji (estilo Google), para qualquer emoji */
export function staticEmojiUrl(emoji: string) {
  return `${BASE}/${hexes(emoji)
    .map((h) => h.padStart(4, '0'))
    .join('_')}/emoji.svg`
}

export function charFromCode(code: string) {
  return String.fromCodePoint(...code.split('_').map((h) => parseInt(h, 16)))
}

// ------------------------------------------------------------------ carregamento (com cache e nova tentativa)

type LottieModule = typeof import('lottie-web')['default']
let lottiePromise: Promise<LottieModule> | null = null
function loadLottie() {
  lottiePromise ??= import('lottie-web/build/player/lottie_light').then((m) => m.default)
  lottiePromise.catch(() => (lottiePromise = null))
  return lottiePromise
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const dataCache = new Map<string, Promise<unknown>>()
function loadData(code: string) {
  let p = dataCache.get(code)
  if (!p) {
    p = (async () => {
      // o CDN do Google às vezes responde 502 por instantes: tenta de novo
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fetch(`${BASE}/${code}/lottie.json`)
          if (r.ok) return await r.json()
          if (r.status === 404 || attempt >= 2) throw new Error(String(r.status))
        } catch (e) {
          if (attempt >= 2) throw e
        }
        await wait(800 * (attempt + 1))
      }
    })()
    p.catch(() => dataCache.delete(code))
    dataCache.set(code, p)
  }
  return p
}

const reducedMotion = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// um único observador para todos os emojis da tela
type Watcher = (visible: boolean) => void
const watchers = new WeakMap<Element, Watcher>()
let observer: IntersectionObserver | null = null
function observe(el: Element, fn: Watcher) {
  observer ??= new IntersectionObserver(
    (entries) => entries.forEach((e) => watchers.get(e.target)?.(e.isIntersecting)),
    { rootMargin: '80px' },
  )
  watchers.set(el, fn)
  observer.observe(el)
  return () => {
    watchers.delete(el)
    observer?.unobserve(el)
  }
}

// limite de animações ao mesmo tempo (celulares fracos); as demais ficam paradas até passar o mouse/tocar
const MAX_LIVE = 40
let live = 0

// ------------------------------------------------------------------ componente

type Anim = ReturnType<LottieModule['loadAnimation']>

/**
 * @param mode  'loop'  = mexe sem parar enquanto está na tela (mensagens, barra de reações — como no Teams)
 *              'once'  = toca uma vez ao aparecer e de novo ao passar o mouse/tocar
 *              'hover' = parado; mexe enquanto o mouse está em cima (painel de emojis)
 */
export function Emoji({
  char,
  mode = 'loop',
  className,
}: {
  char: string
  mode?: 'loop' | 'once' | 'hover'
  className?: string
}) {
  const enabled = useChat((s) => s.settings.animatedEmoji !== false)
  const code = enabled ? animatedCode(char) : null
  const box = useRef<HTMLSpanElement>(null)
  const anim = useRef<Anim | null>(null)
  const [ready, setReady] = useState(false)
  const [imgOk, setImgOk] = useState(true)
  const [hovered, setHovered] = useState(false)
  const [visible, setVisible] = useState(false)
  const effMode = mode !== 'hover' && reducedMotion() ? 'hover' : mode

  // visibilidade na tela
  useEffect(() => {
    const el = box.current
    if (!code || !el) return
    return observe(el, setVisible)
  }, [code])

  // a animação existe enquanto estiver na tela (loop/once) ou com o mouse em cima (hover)
  const active = !!code && (effMode === 'hover' ? hovered : visible)

  useEffect(() => {
    const el = box.current
    if (!active || !code || !el) return
    let alive = true
    let counted = false
    ;(async () => {
      try {
        const [lottie, data] = await Promise.all([loadLottie(), loadData(code)])
        if (!alive) return
        const a = lottie.loadAnimation({
          container: el,
          renderer: 'svg',
          loop: effMode !== 'once',
          autoplay: false,
          // cada instância recebe sua cópia: o lottie modifica os dados ao processar
          animationData: structuredClone(data),
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: true },
        })
        anim.current = a
        const onReady = () => alive && setReady(true)
        a.addEventListener('DOMLoaded', onReady)
        if (a.isLoaded) onReady() // o evento pode ter disparado antes do addEventListener
        if (effMode === 'once') a.addEventListener('complete', () => a.goToAndStop(0, true))
        const canPlay = effMode === 'hover' || live < MAX_LIVE
        if (canPlay) {
          live++
          counted = true
          a.play()
        } else a.goToAndStop(0, true)
      } catch {
        /* sem internet: fica a imagem estática */
      }
    })()
    return () => {
      alive = false
      if (counted) live--
      anim.current?.destroy()
      anim.current = null
      setReady(false)
    }
  }, [active, code, effMode])

  const replay = () => {
    const a = anim.current
    if (a && a.isPaused) a.goToAndPlay(0, true)
  }

  if (!imgOk && !code) return <span className={className}>{char}</span>

  return (
    <span
      className={cx('anim-emoji', ready && 'ready', !imgOk && 'no-img', className)}
      onMouseEnter={() => {
        setHovered(true)
        replay()
      }}
      onMouseLeave={() => setHovered(false)}
      onTouchStart={replay}
    >
      <span className="anim-emoji-char">{char}</span>
      {imgOk && (
        <img
          className="anim-emoji-img"
          src={staticEmojiUrl(char)}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          onError={() => setImgOk(false)}
        />
      )}
      <span ref={box} className="anim-emoji-box" aria-hidden="true" />
    </span>
  )
}

// ------------------------------------------------------------------ texto com emojis

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
// emoji "de verdade" (não pega ©, ™, dígitos etc. escritos como texto)
const EMOJI_RE = /\p{Emoji_Presentation}|️|\p{Regional_Indicator}/u
const PICTO_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u

export function isEmojiGrapheme(g: string) {
  return PICTO_RE.test(g) && EMOJI_RE.test(g)
}

/** Troca os emojis de um texto por emojis no estilo Teams (o resto do texto fica igual) */
export function emojify(text: string, mode: 'loop' | 'once' | 'hover' = 'loop'): ReactNode[] {
  if (!PICTO_RE.test(text)) return [text]
  const graphemes = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text)
  const out: ReactNode[] = []
  let buf = ''
  graphemes.forEach((g, i) => {
    if (isEmojiGrapheme(g)) {
      if (buf) out.push(buf)
      buf = ''
      out.push(<Emoji key={i} char={g} mode={mode} />)
    } else buf += g
  })
  if (buf) out.push(buf)
  return out
}
