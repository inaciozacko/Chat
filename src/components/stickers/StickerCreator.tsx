import { useEffect, useRef, useState } from 'react'
import { useChat } from '../../store/chat'
import { composeSticker, removeImageBackground, type StickerOptions } from '../../lib/sticker'
import { IconCircle, IconClose, IconCrop, IconImage, IconSend, IconText, IconUndo, IconWand } from '../../lib/icons'
import { Modal, Spinner, useFilePicker } from '../common'
import { cx } from '../../lib/utils'

const EMOJIS = ['😀', '😂', '🥰', '😎', '😢', '😡', '👍', '🙏', '🔥', '🎉', '❤️', '🤔']

export function StickerCreator() {
  const s = useChat()
  const initial = s.stickerCreator?.file ?? null
  const [source, setSource] = useState<Blob | null>(initial)
  const [cutout, setCutout] = useState<Blob | null>(null)
  const [removeBg, setRemoveBg] = useState(true)
  const [progress, setProgress] = useState<{ label: string; ratio: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opts, setOpts] = useState<StickerOptions>({ outline: true, text: '', shape: 'free' })
  const [result, setResult] = useState<Blob | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [emoji, setEmoji] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showText, setShowText] = useState(false)
  const pick = useFilePicker('image/*', ([f]) => {
    setSource(f)
    setCutout(null)
  })
  const jobId = useRef(0)
  const close = () => s.set({ stickerCreator: null })

  useEffect(() => {
    if (!source) pick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 1) remove o fundo (uma vez por imagem)
  useEffect(() => {
    if (!source || !removeBg || cutout) return
    const id = ++jobId.current
    setError(null)
    setProgress({ label: 'Preparando…', ratio: 0 })
    removeImageBackground(source, (label, ratio) => id === jobId.current && setProgress({ label, ratio }))
      .then((b) => id === jobId.current && setCutout(b))
      .catch((e) => {
        console.error(e)
        if (id === jobId.current) {
          setError('Não foi possível remover o fundo. Você ainda pode usar a imagem original.')
          setRemoveBg(false)
        }
      })
      .finally(() => id === jobId.current && setProgress(null))
  }, [source, removeBg, cutout])

  // 2) compõe a figurinha final sempre que as opções mudam
  useEffect(() => {
    const base = removeBg ? cutout : source
    if (!base) return
    let alive = true
    composeSticker(base, { ...opts, trim: removeBg, shape: removeBg ? 'free' : opts.shape }).then((b) => {
      if (!alive) return
      setResult(b)
      setResultUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return URL.createObjectURL(b)
      })
    })
    return () => {
      alive = false
    }
  }, [cutout, source, removeBg, opts])

  const save = async (andSend: boolean) => {
    if (!result) return
    setBusy(true)
    const st = await s.saveSticker(result, emoji)
    setBusy(false)
    if (!st) return
    if (andSend && s.activeId) await s.sendMessage(s.activeId, { type: 'sticker', media_url: st.image_url })
    s.showToast(andSend ? 'Figurinha enviada e salva' : 'Figurinha salva')
    close()
  }

  return (
    <Modal onClose={close} className="sticker-creator">
      <div className="sc-header">
        <button className="icon-btn" onClick={close}>
          <IconClose />
        </button>
        <h3>Criar figurinha</h3>
        <button className="btn-text" onClick={pick}>
          <IconImage size={18} /> Trocar imagem
        </button>
      </div>

      <div className="sc-body">
        <div className="sc-stage checker">
          {progress ? (
            <div className="sc-progress">
              <Spinner size={42} />
              <div>{progress.label}</div>
              <div className="bar">
                <div style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
              </div>
              <small className="muted">Na primeira vez o modelo de IA é baixado (~40MB) e fica em cache.</small>
            </div>
          ) : resultUrl ? (
            <img src={resultUrl} alt="Prévia da figurinha" />
          ) : (
            <div className="sc-progress">
              {source ? <Spinner /> : <button className="btn-primary" onClick={pick}>Escolher imagem</button>}
            </div>
          )}
        </div>

        <div className="sc-tools">
          {error && <div className="sc-error">{error}</div>}
          <button
            className={cx('sc-tool', removeBg && 'on')}
            disabled={!!progress}
            onClick={() => setRemoveBg((v) => !v)}
          >
            <IconWand /> <span>{removeBg ? 'Fundo removido' : 'Remover fundo'}</span>
          </button>
          <button className={cx('sc-tool', opts.outline && 'on')} onClick={() => setOpts((o) => ({ ...o, outline: !o.outline }))}>
            <span className="outline-ico" /> <span>Contorno branco</span>
          </button>
          {!removeBg && (
            <div className="sc-shapes">
              {(
                [
                  ['free', 'Original', <IconImage key="i" size={18} />],
                  ['rounded', 'Arredondada', <IconCrop key="c" size={18} />],
                  ['circle', 'Círculo', <IconCircle key="o" size={18} />],
                ] as const
              ).map(([k, label, icon]) => (
                <button
                  key={k}
                  className={cx('sc-shape', opts.shape === k && 'on')}
                  onClick={() => setOpts((o) => ({ ...o, shape: k }))}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
          )}
          <button className={cx('sc-tool', showText && 'on')} onClick={() => setShowText((v) => !v)}>
            <IconText /> <span>Adicionar texto</span>
          </button>
          {showText && (
            <div className="sc-text">
              <input
                autoFocus
                maxLength={40}
                placeholder="Texto da figurinha"
                value={opts.text ?? ''}
                onChange={(e) => setOpts((o) => ({ ...o, text: e.target.value }))}
              />
              <div className="sc-colors">
                {['#ffffff', '#ffd400', '#25d366', '#ff3b30', '#34b7f1', '#000000'].map((c) => (
                  <button
                    key={c}
                    style={{ background: c }}
                    className={cx(opts.textColor === c && 'on')}
                    onClick={() => setOpts((o) => ({ ...o, textColor: c }))}
                  />
                ))}
              </div>
            </div>
          )}
          <div className="sc-label">Emoji relacionado (para busca)</div>
          <div className="sc-emojis">
            {EMOJIS.map((e) => (
              <button key={e} className={cx(emoji === e && 'on')} onClick={() => setEmoji(emoji === e ? null : e)}>
                {e}
              </button>
            ))}
          </div>
          {cutout && removeBg && (
            <button className="link-btn" onClick={() => setRemoveBg(false)}>
              <IconUndo size={14} /> Usar imagem original
            </button>
          )}
        </div>
      </div>

      <div className="sc-footer">
        <button className="btn-outline" disabled={!result || busy || !!progress} onClick={() => save(false)}>
          Salvar nas figurinhas
        </button>
        {s.activeId && (
          <button className="btn-primary" disabled={!result || busy || !!progress} onClick={() => save(true)}>
            {busy ? <Spinner size={18} /> : <IconSend size={18} />} Enviar
          </button>
        )}
      </div>
    </Modal>
  )
}
