import { useEffect, useRef, useState } from 'react'
import { useChat } from '../../store/chat'
import { useBackHandler } from '../../lib/back'
import { sendTyping } from '../../lib/realtime'
import { countCameras, defaultFacing, deviceIdOf, isMirrored, openCamera, type Facing } from '../../lib/camera'
import {
  IconCamera,
  IconCameraSwitch,
  IconClose,
  IconDocument,
  IconEdit,
  IconImage,
  IconMic,
  IconPlay,
  IconPlus,
  IconSend,
  IconSmile,
  IconSticker,
  IconWand,
} from '../../lib/icons'
import { Menu, useFilePicker } from '../common'
import { colorFor, cx, messagePreview } from '../../lib/utils'
import { StickerPanel } from '../stickers/StickerPanel'
import { EmojiPanel } from '../emoji/EmojiPanel'
import { HoldBar, LockHint, RecordingBar, useVoiceRecorder } from './VoiceRecorder'

export function Composer({ convId, onFiles }: { convId: string; onFiles: (files: File[]) => void }) {
  const s = useChat()
  const uid = s.session!.user.id
  const [text, setText] = useState('')
  const [panel, setPanel] = useState<null | 'emoji' | 'sticker'>(null)
  useBackHandler(panel !== null, () => setPanel(null)) // voltar fecha o painel de emojis/figurinhas
  const [attach, setAttach] = useState<HTMLElement | null>(null)
  const [camera, setCamera] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const drafts = useRef<Record<string, string>>({})

  // ---------------------------------------------------------------- mensagem de voz
  const rec = useVoiceRecorder({
    onDone: (file, seconds) => {
      const reply = useChat.getState().replyTo
      s.set({ replyTo: null })
      sendTyping(convId, null)
      s.sendMedia(convId, file, 'audio', { media_name: file.name, media_duration: seconds, reply_to: reply?.id ?? null })
    },
    onError: (msg) => s.showToast(msg),
    onTick: () => sendTyping(convId, 'recording'),
  })
  // celular: segurar o botão grava; deslizar para a esquerda cancela; para cima trava
  const [hold, setHold] = useState<null | { dx: number; dy: number }>(null)
  const holdStart = useRef<{ x: number; y: number } | null>(null)
  const pointerKind = useRef<string | null>(null)

  const stopHold = () => {
    holdStart.current = null
    setHold(null)
  }
  const micDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    pointerKind.current = e.pointerType
    if (e.pointerType === 'mouse') return // no computador é clique (grava travado, como no WhatsApp Web)
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ok */
    }
    holdStart.current = { x: e.clientX, y: e.clientY }
    setHold({ dx: 0, dy: 0 })
    setPanel(null)
    navigator.vibrate?.(30)
    rec.start()
  }
  const micMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const st = holdStart.current
    if (!st) return
    const dx = e.clientX - st.x
    const dy = e.clientY - st.y
    if (dx < -110) {
      stopHold()
      rec.cancel()
      navigator.vibrate?.([20, 40, 20])
    } else if (dy < -70) {
      stopHold() // travado: continua gravando sem segurar
      navigator.vibrate?.(20)
    } else setHold({ dx, dy })
  }
  const micUp = () => {
    if (!holdStart.current) return
    stopHold()
    rec.send()
  }
  const micCancel = () => {
    if (!holdStart.current) return
    stopHold()
    rec.cancel()
  }
  const micClick = () => {
    const kind = pointerKind.current
    pointerKind.current = null
    if (kind && kind !== 'mouse') return
    setPanel(null)
    rec.start()
  }

  // trocou de conversa: descarta a gravação em andamento
  useEffect(() => {
    return () => {
      rec.cancel()
      holdStart.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId])

  const pickMedia = useFilePicker('image/*,video/*', onFiles, true)
  const pickDoc = useFilePicker('*/*', onFiles, true)
  const pickSticker = useFilePicker('image/*', ([f]) => s.set({ stickerCreator: { file: f } }))

  // rascunho por conversa
  useEffect(() => {
    setText(drafts.current[convId] ?? '')
    setPanel(null)
    ta.current?.focus()
    return () => {
      sendTyping(convId, null)
    }
  }, [convId])

  useEffect(() => {
    drafts.current[convId] = text
  }, [text, convId])

  useEffect(() => {
    if (s.editing) {
      setText(s.editing.content ?? '')
      ta.current?.focus()
    }
  }, [s.editing])

  useEffect(() => {
    if (s.replyTo) ta.current?.focus()
  }, [s.replyTo])

  // auto-altura
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }, [text])

  const send = async () => {
    const content = text.trim()
    if (!content) return
    if (s.editing) {
      await s.editMessage(s.editing, content)
      s.set({ editing: null })
      setText('')
      return
    }
    const reply = s.replyTo
    setText('')
    s.set({ replyTo: null })
    sendTyping(convId, null)
    await s.sendMessage(convId, { type: 'text', content, reply_to: reply?.id ?? null })
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && s.settings.enterToSend) {
      e.preventDefault()
      send()
    }
    if (e.key === 'Escape') {
      if (s.editing) {
        s.set({ editing: null })
        setText('')
      } else if (s.replyTo) s.set({ replyTo: null })
      else setPanel(null)
    }
    if (e.key === 'ArrowUp' && !text) {
      // editar a última mensagem enviada, como no original
      const mine = [...(s.messages[convId] ?? [])].reverse().find((m) => m.sender_id === uid && m.type === 'text')
      if (mine && Date.now() - new Date(mine.created_at).getTime() < 15 * 60 * 1000) {
        e.preventDefault()
        s.set({ editing: mine })
      }
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length) {
      e.preventDefault()
      onFiles(files)
    }
  }

  const insertEmoji = (emoji: string) => {
    const el = ta.current
    if (!el) return setText((t) => t + emoji)
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    const next = text.slice(0, start) + emoji + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = start + emoji.length
    })
  }

  const replied = s.replyTo
  const repliedName = replied ? (replied.sender_id === uid ? 'Você' : s.profiles[replied.sender_id ?? '']?.full_name) : ''

  return (
    <div className="composer-wrap">
      {panel && (
        <div className="composer-panel">
          <div className="composer-panel-tabs">
            <button className={cx(panel === 'emoji' && 'active')} onClick={() => setPanel('emoji')} title="Emojis">
              <IconSmile />
            </button>
            <button className={cx(panel === 'sticker' && 'active')} onClick={() => setPanel('sticker')} title="Figurinhas">
              <IconSticker />
            </button>
          </div>
          {panel === 'emoji' ? (
            <EmojiPanel onPick={insertEmoji} theme={s.settings.theme} height={320} />
          ) : (
            <StickerPanel
              onSend={(url) => {
                s.sendMessage(convId, { type: 'sticker', media_url: url, reply_to: s.replyTo?.id ?? null })
                s.set({ replyTo: null })
              }}
            />
          )}
        </div>
      )}

      {(replied || s.editing) && (
        <div className="reply-preview">
          {s.editing ? (
            <div className="reply-box editing">
              <div className="quote-name">
                <IconEdit size={14} /> Editar mensagem
              </div>
              <div className="quote-text">{s.editing.content}</div>
            </div>
          ) : (
            replied && (
              <div className="reply-box" style={{ borderColor: colorFor(replied.sender_id ?? '') }}>
                <div className="quote-name" style={{ color: colorFor(replied.sender_id ?? '') }}>
                  {repliedName}
                </div>
                <div className="quote-text">{messagePreview(replied)}</div>
                {(replied.type === 'image' || replied.type === 'sticker') && replied.media_url && (
                  <img className="quote-thumb" src={replied.media_url} alt="" />
                )}
              </div>
            )
          )}
          <button
            className="icon-btn"
            onClick={() => {
              if (s.editing) setText('')
              s.set({ replyTo: null, editing: null })
            }}
          >
            <IconClose />
          </button>
        </div>
      )}

      <div className={cx('composer', rec.active && 'recording')}>
        {rec.active && hold ? (
          <HoldBar rec={rec} dx={hold.dx} />
        ) : rec.active ? (
          <RecordingBar rec={rec} />
        ) : (
          <>
          <button
            className={cx('icon-btn', attach && 'rotated')}
            onClick={(e) => setAttach(e.currentTarget)}
            title="Anexar"
          >
            <IconPlus size={26} />
          </button>
          <div className="composer-input">
            <button
              className={cx('icon-btn', panel && 'active')}
              onClick={() => setPanel(panel ? null : 'emoji')}
              title="Emojis e figurinhas"
            >
              {panel ? <IconClose /> : <IconSmile />}
            </button>
            <textarea
              ref={ta}
              rows={1}
              placeholder="Digite uma mensagem"
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                if (e.target.value) sendTyping(convId, 'typing')
                else sendTyping(convId, null)
              }}
              onKeyDown={onKey}
              onPaste={onPaste}
            />
          </div>
          </>
        )}
        {rec.active && !hold ? (
          <button key="rec-send" className="icon-btn rec-send" onClick={rec.send} title="Enviar áudio" aria-label="Enviar áudio">
            <IconSend />
          </button>
        ) : text.trim() || s.editing ? (
          <button key="send" className="icon-btn send" onClick={send} title="Enviar" disabled={!text.trim()}>
            <IconSend />
          </button>
        ) : (
          <span key="mic" className="mic-wrap">
            {hold && rec.active && <LockHint dy={hold.dy} />}
            <button
              className={cx('icon-btn mic-btn', hold && 'holding')}
              title="Gravar áudio"
              aria-label="Gravar áudio"
              onPointerDown={micDown}
              onPointerMove={micMove}
              onPointerUp={micUp}
              onPointerCancel={micCancel}
              onClick={micClick}
              onContextMenu={(e) => e.preventDefault()}
            >
              <IconMic />
            </button>
          </span>
        )}
      </div>

      {attach && (
        <Menu
          anchor={attach}
          align="left"
          onClose={() => setAttach(null)}
          items={[
            { label: 'Documento', icon: <IconDocument className="c-doc" />, onClick: pickDoc },
            { label: 'Fotos e vídeos', icon: <IconImage className="c-media" />, onClick: pickMedia },
            { label: 'Câmera', icon: <IconCamera className="c-cam" />, onClick: () => setCamera(true) },
            { label: 'Nova figurinha', icon: <IconWand className="c-sticker" />, onClick: pickSticker },
          ]}
        />
      )}
      {camera && (
        <CameraCapture
          onClose={() => setCamera(false)}
          onCapture={(f) => {
            setCamera(false)
            onFiles([f])
          }}
        />
      )}
    </div>
  )
}

function CameraCapture({ onClose, onCapture }: { onClose: () => void; onCapture: (f: File) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [facing, setFacing] = useState<Facing>(defaultFacing)
  const [mirror, setMirror] = useState(false)
  const [canSwitch, setCanSwitch] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // abre (ou troca) a câmera sempre que o lado muda
  useEffect(() => {
    let alive = true
    const prevId = deviceIdOf(stream.current)
    stream.current?.getTracks().forEach((t) => t.stop()) // celulares não abrem duas câmeras juntas
    stream.current = null
    setBusy(true)
    openCamera(facing, prevId)
      .then(async (s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop())
        stream.current = s
        if (video.current) video.current.srcObject = s
        setMirror(isMirrored(s, facing))
        setError(null)
        const n = await countCameras()
        if (alive) setCanSwitch(n > 1)
      })
      .catch((e: DOMException) => {
        if (!alive) return
        setError(
          e?.name === 'NotAllowedError'
            ? 'Permita o acesso à câmera nas configurações do navegador'
            : 'Não foi possível acessar a câmera',
        )
      })
      .finally(() => alive && setBusy(false))
    return () => {
      alive = false
    }
  }, [facing])
  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), [])

  const snap = () => {
    const v = video.current
    if (!v || !v.videoWidth || busy) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')!
    if (mirror) {
      ctx.translate(c.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(v, 0, 0)
    c.toBlob((b) => b && onCapture(new File([b], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.9)
  }
  const flip = () => !busy && setFacing((f) => (f === 'user' ? 'environment' : 'user'))

  useBackHandler(true, onClose)
  return (
    <div className="camera-overlay">
      <div className="camera-top">
        <button className="icon-btn light" onClick={onClose}>
          <IconClose />
        </button>
        <span>Tirar foto</span>
      </div>
      {error && <div className="camera-error">{error}</div>}
      <video ref={video} className={cx(mirror && 'mirror', error && 'hidden')} autoPlay playsInline muted />
      {!error && (
        <div className="camera-bar">
          <span className="camera-bar-side" />
          <button className="camera-shutter" onClick={snap} disabled={busy} aria-label="Capturar">
            <IconCamera size={30} />
          </button>
          <span className="camera-bar-side">
            {canSwitch && (
              <button className="camera-switch" onClick={flip} disabled={busy} aria-label="Trocar câmera" title="Trocar câmera">
                <IconCameraSwitch size={26} />
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

/** Tela de prévia antes de enviar fotos/vídeos/documentos (com legenda) */
export function MediaPreview({
  files,
  onClose,
  onAdd,
  onSend,
}: {
  files: File[]
  onClose: () => void
  onAdd: (f: File[]) => void
  onSend: (items: { file: File; caption: string }[]) => void
}) {
  const [index, setIndex] = useState(0)
  const [captions, setCaptions] = useState<string[]>([])
  const urls = useRef<string[]>([])
  const addMore = useFilePicker('*/*', onAdd, true)
  const setStickerCreator = useChat((s) => s.set)

  useEffect(() => {
    urls.current.forEach(URL.revokeObjectURL)
    urls.current = files.map((f) => URL.createObjectURL(f))
    if (index >= files.length) setIndex(Math.max(0, files.length - 1))
    return () => urls.current.forEach(URL.revokeObjectURL)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files])

  const f = files[index]
  if (!f) return null
  const kind = f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : 'doc'
  const url = urls.current[index]

  return (
    <div className="media-preview">
      <div className="media-preview-top">
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
        <span className="media-preview-name">{f.name}</span>
        {kind === 'image' && (
          <button
            className="btn-text"
            onClick={() => {
              setStickerCreator({ stickerCreator: { file: f } })
              onClose()
            }}
          >
            <IconWand size={18} /> Transformar em figurinha
          </button>
        )}
      </div>
      <div className="media-preview-stage">
        {kind === 'image' && url && <img src={url} alt="" />}
        {kind === 'video' && url && <video src={url} controls />}
        {kind === 'doc' && (
          <div className="doc-preview">
            <IconDocument size={96} />
            <div>{f.name}</div>
            <div className="muted">{(f.size / 1024).toFixed(0)} kB</div>
          </div>
        )}
      </div>
      <div className="media-preview-caption">
        <input
          autoFocus
          placeholder="Adicione uma legenda"
          value={captions[index] ?? ''}
          onChange={(e) => {
            const c = [...captions]
            c[index] = e.target.value
            setCaptions(c)
          }}
          onKeyDown={(e) => e.key === 'Enter' && onSend(files.map((file, i) => ({ file, caption: captions[i] ?? '' })))}
        />
      </div>
      <div className="media-preview-bottom">
        <div className="thumbs">
          {files.map((file, i) => (
            <button key={i} className={cx('thumb', i === index && 'active')} onClick={() => setIndex(i)}>
              {file.type.startsWith('image/') && urls.current[i] ? (
                <img src={urls.current[i]} alt="" />
              ) : file.type.startsWith('video/') ? (
                <IconPlay />
              ) : (
                <IconDocument />
              )}
            </button>
          ))}
          <button className="thumb add" onClick={addMore} aria-label="Adicionar arquivo">
            <IconPlus />
          </button>
        </div>
        <button
          className="send-fab"
          onClick={() => onSend(files.map((file, i) => ({ file, caption: captions[i] ?? '' })))}
        >
          <IconSend />
          {files.length > 1 && <span className="send-count">{files.length}</span>}
        </button>
      </div>
    </div>
  )
}
