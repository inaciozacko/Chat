import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '../../store/chat'
import {
  aiMask,
  buildSticker,
  coverage,
  effectiveAlpha,
  floodSelect,
  loadSource,
  ownAlpha,
  paintStroke,
  previewFrame,
  renderEditor,
  type MaskSettings,
  type Source,
  type StickerOptions,
} from '../../lib/sticker'
import {
  IconBrush,
  IconCircle,
  IconClose,
  IconCrop,
  IconEraser,
  IconImage,
  IconPause,
  IconPlay,
  IconSend,
  IconText,
  IconUndo,
  IconWand,
} from '../../lib/icons'
import { Modal, Spinner, useFilePicker } from '../common'
import { cx } from '../../lib/utils'

const EMOJIS = ['😀', '😂', '🥰', '😎', '😢', '😡', '👍', '🙏', '🔥', '🎉', '❤️', '🤔']
type Tool = 'view' | 'erase' | 'restore' | 'wand'

export function StickerCreator() {
  const s = useChat()
  const [file, setFile] = useState<Blob | null>(s.stickerCreator?.file ?? null)
  const [source, setSource] = useState<Source | null>(null)
  const [aiOn, setAiOn] = useState(true)
  const [aiMasks, setAiMasks] = useState<Uint8Array[] | null>(null)
  const [progress, setProgress] = useState<{ label: string; ratio: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [settings, setSettings] = useState<MaskSettings>({ sensitivity: 50, cleanup: true, fillHoles: true })
  const [tool, setTool] = useState<Tool>('view')
  const [brush, setBrush] = useState(28)
  const [tolerance, setTolerance] = useState(22)
  const [showRemoved, setShowRemoved] = useState(true)
  const [frameIndex, setFrameIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [style, setStyle] = useState<Omit<StickerOptions, 'trim'>>({ outline: true, text: '', shape: 'free' })
  const [showText, setShowText] = useState(false)
  const [emoji, setEmoji] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0) // muda a cada edição manual
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  const edits = useRef<Int8Array | null>(null)
  const undo = useRef<Int8Array[]>([])
  const drawing = useRef<{ x: number; y: number } | null>(null)
  const editorRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const job = useRef(0)

  const close = () => {
    job.current++
    s.set({ stickerCreator: null })
  }
  const pick = useFilePicker('image/*', ([f]) => setFile(f))

  // 1) carrega imagem/GIF
  useEffect(() => {
    if (!file) {
      pick()
      return
    }
    const id = ++job.current
    setSource(null)
    setAiMasks(null)
    setError(null)
    setHint(null)
    setFrameIndex(0)
    setProgress({ label: 'Abrindo imagem…', ratio: 0 })
    loadSource(file)
      .then((src) => {
        if (id !== job.current) return
        edits.current = new Int8Array(src.w * src.h)
        undo.current = []
        setVersion((v) => v + 1)
        setSource(src)
        // GIF: IA quadro a quadro é lenta, então começa desligada (muitos GIFs já têm fundo transparente)
        const transparent = coverage(ownAlpha(src.frames[0])) < 0.98
        setAiOn(!src.animated && !transparent)
        if (src.animated) setPlaying(true)
        if (transparent) setHint('A imagem já tem fundo transparente. Ajuste com o pincel ou a varinha se precisar.')
      })
      .catch((e) => {
        console.error(e)
        if (id === job.current) setError('Não foi possível abrir essa imagem.')
      })
      .finally(() => id === job.current && setProgress(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  // 2) roda a IA quando ligada (uma vez por imagem; em GIFs, quadro a quadro)
  useEffect(() => {
    if (!source || !aiOn || aiMasks) return
    const id = ++job.current
    ;(async () => {
      try {
        const masks: Uint8Array[] = []
        const n = source.frames.length
        for (let i = 0; i < n; i++) {
          if (id !== job.current) return
          setProgress({ label: n > 1 ? `Removendo fundo… quadro ${i + 1} de ${n}` : 'Removendo fundo…', ratio: i / n })
          masks.push(
            await aiMask(source.frames[i], (label, ratio) => id === job.current && setProgress({ label, ratio })),
          )
        }
        if (id !== job.current) return
        setAiMasks(masks)
        const cov = coverage(masks[0])
        if (cov < 0.03)
          setHint('A IA quase não encontrou um objeto. Diminua a sensibilidade, ou desligue a IA e use a varinha no fundo.')
        else if (cov > 0.96)
          setHint('A IA não conseguiu separar o fundo desta imagem. Use a varinha mágica clicando no fundo, ou a borracha.')
        else setHint(null)
      } catch (e) {
        console.error(e)
        if (id === job.current) {
          setError('Não foi possível remover o fundo automaticamente. Use a varinha mágica ou a borracha.')
          setAiOn(false)
        }
      } finally {
        if (id === job.current) setProgress(null)
      }
    })()
  }, [source, aiOn, aiMasks])

  // máscara base de cada quadro: IA (se ligada e pronta) ou a transparência original da imagem
  const baseMasks = useMemo(() => {
    if (!source) return null
    if (aiOn) return aiMasks
    return source.frames.map(ownAlpha)
  }, [source, aiOn, aiMasks])

  const fi = Math.min(frameIndex, (source?.frames.length ?? 1) - 1)

  const alpha = useMemo(() => {
    if (!source || !baseMasks) return null
    return effectiveAlpha(baseMasks[fi], source.w, source.h, settings, edits.current)
    // version: recalcula após pinceladas
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, baseMasks, fi, settings, version])

  const opts: StickerOptions = useMemo(() => ({ ...style, trim: style.shape === 'free' }), [style])

  // 3) desenha editor e prévia
  useEffect(() => {
    const c = editorRef.current
    if (!c || !source) return
    const frame = source.frames[fi]
    c.width = source.w
    c.height = source.h
    const ctx = c.getContext('2d')!
    if (!alpha) ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.w, frame.h), 0, 0)
    else ctx.putImageData(renderEditor(frame, alpha, showRemoved), 0, 0)
  }, [source, fi, alpha, showRemoved])

  useEffect(() => {
    const c = previewRef.current
    if (!c || !source || !alpha) return
    const raf = requestAnimationFrame(() => {
      const out = previewFrame(source.frames[fi], alpha, opts)
      const ctx = c.getContext('2d')!
      ctx.clearRect(0, 0, c.width, c.height)
      if (out) ctx.drawImage(out, 0, 0, c.width, c.height)
    })
    return () => cancelAnimationFrame(raf)
  }, [source, fi, alpha, opts])

  // animação na prévia do editor (GIF)
  useEffect(() => {
    if (!playing || !source?.animated || drawing.current) return
    const t = window.setTimeout(
      () => setFrameIndex((i) => (i + 1) % source.frames.length),
      source.frames[fi].delay,
    )
    return () => window.clearTimeout(t)
  }, [playing, source, fi])

  // ------------------------------------------------------------ ferramentas
  const toImage = (e: React.PointerEvent) => {
    const c = editorRef.current!
    const r = c.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) * c.width) / r.width,
      y: ((e.clientY - r.top) * c.height) / r.height,
      scale: c.width / r.width,
    }
  }

  const pushUndo = () => {
    if (!edits.current) return
    undo.current.push(edits.current.slice())
    if (undo.current.length > 25) undo.current.shift()
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!source || !edits.current || tool === 'view' || progress) return
    e.preventDefault()
    setPlaying(false)
    const p = toImage(e)
    const x = Math.floor(p.x)
    const y = Math.floor(p.y)
    if (x < 0 || y < 0 || x >= source.w || y >= source.h) return
    pushUndo()
    if (tool === 'wand') {
      const sel = floodSelect(source.frames[fi], x, y, tolerance)
      const value = e.shiftKey || e.button === 2 ? 1 : -1
      for (let i = 0; i < sel.length; i++) if (sel[i]) edits.current[i] = value
      setVersion((v) => v + 1)
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = p
    paintStroke(edits.current, source.w, source.h, p, p, (brush / 2) * p.scale, tool === 'erase' ? -1 : 1)
    setVersion((v) => v + 1)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // o cursor do pincel é posicionado dentro da área (stage), não do canvas centralizado
    const r = e.currentTarget.parentElement!.getBoundingClientRect()
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
    if (!drawing.current || !source || !edits.current) return
    const p = toImage(e)
    paintStroke(edits.current, source.w, source.h, drawing.current, p, (brush / 2) * p.scale, tool === 'erase' ? -1 : 1)
    drawing.current = p
    setVersion((v) => v + 1)
  }

  const onPointerUp = () => {
    drawing.current = null
  }

  const doUndo = useCallback(() => {
    const prev = undo.current.pop()
    if (prev && edits.current) {
      edits.current.set(prev)
      setVersion((v) => v + 1)
    }
  }, [])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        doUndo()
      }
    }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [doUndo])

  const resetEdits = () => {
    if (!edits.current) return
    pushUndo()
    edits.current.fill(0)
    setVersion((v) => v + 1)
  }

  // ------------------------------------------------------------ salvar
  const save = async (andSend: boolean) => {
    if (!source || !baseMasks) return
    setBusy(true)
    setError(null)
    try {
      const alphas = source.frames.map((_, i) =>
        effectiveAlpha(baseMasks[i], source.w, source.h, settings, edits.current),
      )
      const blob = await buildSticker(source, alphas, opts, (label, ratio) => setProgress({ label, ratio }))
      setProgress(null)
      const st = await s.saveSticker(blob, emoji)
      if (!st) return
      if (andSend && s.activeId) await s.sendMessage(s.activeId, { type: 'sticker', media_url: st.image_url })
      s.showToast(andSend ? 'Figurinha enviada e salva' : 'Figurinha salva')
      close()
    } catch (e) {
      setProgress(null)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const ready = !!source && !!baseMasks && !progress
  const brushTool = tool === 'erase' || tool === 'restore'

  return (
    <Modal onClose={close} className="sticker-creator">
      <div className="sc-header">
        <button className="icon-btn" onClick={close} aria-label="Fechar">
          <IconClose />
        </button>
        <h3>
          Criar figurinha
          {source?.animated && <span className="sc-badge">Animada · {source.frames.length} quadros</span>}
        </h3>
        <button className="btn-text" onClick={pick}>
          <IconImage size={18} /> Trocar imagem
        </button>
      </div>

      <div className="sc-body">
        <div className="sc-left">
          <div className={cx('sc-stage checker', `tool-${tool}`)}>
            {source ? (
              <canvas
                ref={editorRef}
                className="sc-editor"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={() => setCursor(null)}
                onContextMenu={(e) => tool === 'wand' && e.preventDefault()}
              />
            ) : (
              !progress && (
                <button className="btn-primary" onClick={pick}>
                  Escolher imagem ou GIF
                </button>
              )
            )}
            {brushTool && cursor && !progress && (
              <span
                className={cx('brush-cursor', tool)}
                style={{ left: cursor.x, top: cursor.y, width: brush, height: brush }}
              />
            )}
            {progress && (
              <div className="sc-progress">
                <Spinner size={38} />
                <div>{progress.label}</div>
                <div className="bar">
                  <div style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
                </div>
              </div>
            )}
          </div>

          <div className="sc-toolbar">
            {(
              [
                ['view', 'Visualizar', <IconImage key="v" size={18} />],
                ['erase', 'Borracha', <IconEraser key="e" size={18} />],
                ['restore', 'Restaurar', <IconBrush key="r" size={18} />],
                ['wand', 'Varinha', <IconWand key="w" size={18} />],
              ] as [Tool, string, React.ReactNode][]
            ).map(([k, label, icon]) => (
              <button
                key={k}
                className={cx('sc-toolbtn', tool === k && 'on', k)}
                onClick={() => setTool(k)}
                disabled={!source}
                title={label}
              >
                {icon}
                <span>{label}</span>
              </button>
            ))}
            <span className="sc-sep" />
            <button className="icon-btn small" onClick={doUndo} title="Desfazer (Ctrl+Z)" disabled={!source}>
              <IconUndo size={18} />
            </button>
          </div>

          {brushTool && (
            <label className="sc-range">
              <span>Tamanho do pincel</span>
              <input type="range" min={6} max={90} value={brush} onChange={(e) => setBrush(+e.target.value)} />
            </label>
          )}
          {tool === 'wand' && (
            <label className="sc-range">
              <span>Tolerância de cor</span>
              <input
                type="range"
                min={2}
                max={70}
                value={tolerance}
                onChange={(e) => setTolerance(+e.target.value)}
              />
            </label>
          )}
          <div className="sc-hint">
            {tool === 'wand'
              ? 'Clique no fundo para apagar a área daquela cor. Shift+clique (ou botão direito) restaura.'
              : tool === 'erase'
                ? 'Pinte o que deve sair da figurinha.'
                : tool === 'restore'
                  ? 'Pinte por cima das áreas vermelhas para trazê-las de volta.'
                  : hint ?? 'Use a borracha, o restaurar ou a varinha para ajustar o recorte.'}
          </div>

          {source?.animated && (
            <div className="sc-frames">
              <button className="icon-btn small" onClick={() => setPlaying((p) => !p)} title={playing ? 'Pausar' : 'Reproduzir'}>
                {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
              </button>
              <input
                type="range"
                min={0}
                max={source.frames.length - 1}
                value={fi}
                onChange={(e) => {
                  setPlaying(false)
                  setFrameIndex(+e.target.value)
                }}
              />
              <span className="muted small">
                {fi + 1}/{source.frames.length}
              </span>
            </div>
          )}
        </div>

        <div className="sc-side">
          {error && <div className="sc-error">{error}</div>}

          <div className="sc-group">
            <div className="sc-group-title">Fundo</div>
            <div className="sc-row">
              <span>
                Remover fundo com IA
                {source?.animated && <small className="muted"> (quadro a quadro, pode demorar)</small>}
              </span>
              <button
                className={cx('toggle', aiOn && 'on')}
                role="switch"
                aria-checked={aiOn}
                disabled={!!progress || !source}
                onClick={() => {
                  setError(null)
                  setAiOn((v) => !v)
                }}
              >
                <span />
              </button>
            </div>
            <label className="sc-range">
              <span>Sensibilidade</span>
              <input
                type="range"
                min={0}
                max={100}
                value={settings.sensitivity}
                onChange={(e) => setSettings((st) => ({ ...st, sensitivity: +e.target.value }))}
              />
              <span className="sc-range-labels">
                <small>Remove menos</small>
                <small>Remove mais</small>
              </span>
            </label>
            <label className="sc-check">
              <input
                type="checkbox"
                checked={settings.cleanup}
                onChange={(e) => setSettings((st) => ({ ...st, cleanup: e.target.checked }))}
              />
              Apagar pedaços soltos
            </label>
            <label className="sc-check">
              <input
                type="checkbox"
                checked={settings.fillHoles}
                onChange={(e) => setSettings((st) => ({ ...st, fillHoles: e.target.checked }))}
              />
              Preencher buracos pequenos
            </label>
            <label className="sc-check">
              <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
              Mostrar área removida em vermelho
            </label>
            <button className="link-btn" onClick={resetEdits} disabled={!source}>
              Desfazer todos os ajustes manuais
            </button>
          </div>

          <div className="sc-group">
            <div className="sc-group-title">Estilo</div>
            <div className="sc-row">
              <span>Contorno branco</span>
              <button
                className={cx('toggle', style.outline && 'on')}
                role="switch"
                aria-checked={style.outline}
                onClick={() => setStyle((o) => ({ ...o, outline: !o.outline }))}
              >
                <span />
              </button>
            </div>
            <div className="sc-shapes">
              {(
                [
                  ['free', 'Recorte', <IconImage key="i" size={18} />],
                  ['rounded', 'Arredondada', <IconCrop key="c" size={18} />],
                  ['circle', 'Círculo', <IconCircle key="o" size={18} />],
                ] as const
              ).map(([k, label, icon]) => (
                <button
                  key={k}
                  className={cx('sc-shape', style.shape === k && 'on')}
                  onClick={() => setStyle((o) => ({ ...o, shape: k }))}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
            <button className={cx('sc-tool', showText && 'on')} onClick={() => setShowText((v) => !v)}>
              <IconText size={18} /> <span>Adicionar texto</span>
            </button>
            {showText && (
              <div className="sc-text">
                <input
                  autoFocus
                  maxLength={40}
                  placeholder="Texto da figurinha"
                  value={style.text ?? ''}
                  onChange={(e) => setStyle((o) => ({ ...o, text: e.target.value }))}
                />
                <div className="sc-colors">
                  {['#ffffff', '#ffd400', '#25d366', '#ff3b30', '#34b7f1', '#000000'].map((c) => (
                    <button
                      key={c}
                      style={{ background: c }}
                      className={cx(style.textColor === c && 'on')}
                      onClick={() => setStyle((o) => ({ ...o, textColor: c }))}
                      aria-label={c}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="sc-group">
            <div className="sc-group-title">Prévia</div>
            <div className="sc-preview checker">
              <canvas ref={previewRef} width={256} height={256} />
            </div>
            <div className="sc-label">Emoji relacionado (para busca)</div>
            <div className="sc-emojis">
              {EMOJIS.map((e) => (
                <button key={e} className={cx(emoji === e && 'on')} onClick={() => setEmoji(emoji === e ? null : e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="sc-footer">
        <button className="btn-outline" disabled={!ready || busy} onClick={() => save(false)}>
          Salvar nas figurinhas
        </button>
        {s.activeId && (
          <button className="btn-primary" disabled={!ready || busy} onClick={() => save(true)}>
            {busy ? <Spinner size={18} /> : <IconSend size={18} />} Enviar
          </button>
        )}
      </div>
    </Modal>
  )
}
