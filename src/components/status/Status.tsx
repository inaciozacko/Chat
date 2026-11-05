import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChat } from '../../store/chat'
import { supabase } from '../../lib/supabase'
import type { Profile, Status } from '../../lib/types'
import { IconBack, IconClose, IconImage, IconPlus, IconSend, IconSmile, IconText, IconTrash } from '../../lib/icons'
import { Avatar, Spinner, useFilePicker } from '../common'
import { formatListDate, formatTime, ts } from '../../lib/utils'
import EmojiPicker, { EmojiStyle, Theme } from 'emoji-picker-react'

const COLORS = ['#c1a03f', '#54c265', '#7acba5', '#8294c9', '#a62c71', '#ff7b6b', '#243640', '#5696ff', '#ae8774', '#792138']

function relative(iso: string) {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? `Hoje às ${formatTime(iso)}` : `Ontem às ${formatTime(iso)}`
}

export function StatusPanel() {
  const s = useChat()
  const uid = s.session!.user.id
  const pickImage = useFilePicker('image/*', ([f]) => {
    s.set({ statusComposer: 'image' })
    pendingImage = f
  })

  useEffect(() => {
    s.loadStatuses()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const groups = useMemo(() => {
    const by: Record<string, Status[]> = {}
    for (const st of s.statuses) {
      if (ts(st.expires_at) < Date.now()) continue
      ;(by[st.user_id] ??= []).push(st)
    }
    return by
  }, [s.statuses])

  const mine = groups[uid] ?? []
  const others = Object.entries(groups).filter(([id]) => id !== uid)
  const recent = others.filter(([, list]) => list.some((x) => !s.viewedStatuses.has(x.id)))
  const viewed = others.filter(([, list]) => list.every((x) => s.viewedStatuses.has(x.id)))
  const sortByLast = (a: [string, Status[]], b: [string, Status[]]) =>
    ts(b[1][b[1].length - 1].created_at) - ts(a[1][a[1].length - 1].created_at)

  const row = (userId: string, list: Status[], ring: 'seen' | 'unseen') => {
    const p: Profile | undefined = s.profiles[userId]
    const last = list[list.length - 1]
    return (
      <div key={userId} className="chat-item" onClick={() => s.set({ statusViewer: { userId } })}>
        <Avatar url={p?.avatar_url} ring={ring} />
        <div className="chat-item-body">
          <div className="chat-item-top">
            <span className="chat-item-title">{p?.full_name ?? 'Contato'}</span>
          </div>
          <div className="chat-item-bottom">
            <span className="chat-item-preview">{relative(last.created_at)}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="sidebar-header">
        <h1 className="brand plain">Status</h1>
        <div className="header-actions">
          <button className="icon-btn" title="Status de texto" onClick={() => s.set({ statusComposer: 'text' })}>
            <IconText />
          </button>
          <button className="icon-btn" title="Foto" onClick={pickImage}>
            <IconImage />
          </button>
        </div>
      </div>
      <div className="scroll">
        <div className="chat-item" onClick={() => (mine.length ? s.set({ statusViewer: { userId: uid } }) : pickImage())}>
          <div className="avatar-wrap">
            <Avatar url={s.me?.avatar_url} ring={mine.length ? 'seen' : null} />
            {!mine.length && (
              <span className="add-status">
                <IconPlus size={14} />
              </span>
            )}
          </div>
          <div className="chat-item-body">
            <div className="chat-item-top">
              <span className="chat-item-title">Meu status</span>
            </div>
            <div className="chat-item-bottom">
              <span className="chat-item-preview">
                {mine.length ? relative(mine[mine.length - 1].created_at) : 'Clique para adicionar uma atualização de status'}
              </span>
            </div>
          </div>
        </div>
        {recent.length > 0 && <div className="section-label green">RECENTES</div>}
        {recent.sort(sortByLast).map(([id, list]) => row(id, list, 'unseen'))}
        {viewed.length > 0 && <div className="section-label">VISTOS</div>}
        {viewed.sort(sortByLast).map(([id, list]) => row(id, list, 'seen'))}
        {!others.length && (
          <div className="empty-list">Nenhuma atualização de status dos seus contatos nas últimas 24h.</div>
        )}
        <div className="e2e-note">
          <span>Status desaparecem após 24 horas.</span>
        </div>
      </div>
    </div>
  )
}

let pendingImage: File | null = null

export function StatusComposer() {
  const s = useChat()
  const mode = s.statusComposer!
  const [text, setText] = useState('')
  const [color, setColor] = useState(COLORS[Math.floor(Math.random() * COLORS.length)])
  const [file, setFile] = useState<File | null>(pendingImage)
  const [busy, setBusy] = useState(false)
  const [emoji, setEmoji] = useState(false)
  const pick = useFilePicker('image/*', ([f]) => setFile(f))
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])

  useEffect(() => {
    pendingImage = null
    if (mode === 'image' && !file) pick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = () => s.set({ statusComposer: null })
  const publish = async () => {
    setBusy(true)
    if (mode === 'text') {
      if (!text.trim()) return setBusy(false)
      await s.postStatus({ type: 'text', content: text.trim(), bg_color: color })
    } else if (file) {
      await s.postStatus({ type: 'image', file, content: text.trim() || undefined })
    }
    setBusy(false)
    close()
  }

  return createPortal(
    <div className="status-composer" style={mode === 'text' ? { background: color } : undefined}>
      <div className="status-composer-top">
        <button className="icon-btn light" onClick={close}>
          <IconClose />
        </button>
        <div className="grow" />
        {mode === 'text' ? (
          <>
            <button className="icon-btn light" onClick={() => setEmoji((v) => !v)}>
              <IconSmile />
            </button>
            <button
              className="icon-btn light palette"
              onClick={() => setColor(COLORS[(COLORS.indexOf(color) + 1) % COLORS.length])}
              title="Cor de fundo"
            >
              <span style={{ background: color }} />
            </button>
          </>
        ) : (
          <button className="icon-btn light" onClick={pick}>
            <IconImage />
          </button>
        )}
      </div>
      {mode === 'text' ? (
        <textarea
          className="status-text-input"
          autoFocus
          placeholder="Digite um status"
          maxLength={700}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ fontSize: text.length > 120 ? 26 : text.length > 50 ? 34 : 44 }}
        />
      ) : (
        <div className="status-image-preview">{preview ? <img src={preview} alt="" /> : <Spinner />}</div>
      )}
      {emoji && (
        <div className="status-emoji">
          <EmojiPicker
            onEmojiClick={(e) => setText((t) => t + e.emoji)}
            theme={Theme.DARK}
            emojiStyle={EmojiStyle.NATIVE}
            previewConfig={{ showPreview: false }}
            width={320}
            height={360}
          />
        </div>
      )}
      <div className="status-composer-bottom">
        {mode === 'image' && (
          <input
            className="caption-input"
            placeholder="Adicione uma legenda..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        <button className="send-fab" onClick={publish} disabled={busy}>
          {busy ? <Spinner size={22} /> : <IconSend />}
        </button>
      </div>
    </div>,
    document.body,
  )
}

export function StatusViewer() {
  const s = useChat()
  const uid = s.session!.user.id
  const userId = s.statusViewer!.userId
  const list = useMemo(
    () => s.statuses.filter((x) => x.user_id === userId && ts(x.expires_at) > Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId],
  )
  const firstUnseen = Math.max(0, list.findIndex((x) => !s.viewedStatuses.has(x.id)))
  const [i, setI] = useState(userId === uid ? 0 : firstUnseen)
  const [progress, setProgress] = useState(0)
  const [paused, setPaused] = useState(false)
  const [reply, setReply] = useState('')
  const [viewers, setViewers] = useState<{ viewer_id: string; viewed_at: string }[] | null>(null)
  const [showViewers, setShowViewers] = useState(false)
  const raf = useRef(0)
  const current = list[i]
  const p = s.profiles[userId]
  const close = () => s.set({ statusViewer: null })

  useEffect(() => {
    if (!current) return
    if (userId !== uid) s.markStatusViewed(current.id)
    else
      supabase
        .from('status_views')
        .select('viewer_id, viewed_at')
        .eq('status_id', current.id)
        .then(({ data }) => {
          setViewers(data ?? [])
          s.fetchProfiles((data ?? []).map((v) => v.viewer_id))
        })
    setProgress(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  useEffect(() => {
    if (!current || paused) return
    let last = performance.now()
    const step = (now: number) => {
      const dt = now - last
      last = now
      setProgress((pr) => {
        const next = pr + dt / 6000
        if (next >= 1) {
          if (i < list.length - 1) setI(i + 1)
          else close()
          return 0
        }
        return next
      })
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, paused, current?.id])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      if (e.key === 'ArrowRight') i < list.length - 1 ? setI(i + 1) : close()
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  })

  if (!current) return null

  const sendReply = async () => {
    if (!reply.trim()) return
    const { data } = await supabase.rpc('get_or_create_direct', { other: userId })
    if (data) {
      await s.loadChats()
      const quote = current.type === 'text' ? `“${current.content?.slice(0, 60)}”` : '📷 Foto'
      await s.sendMessage(data as string, { type: 'text', content: `↩️ Status: ${quote}\n${reply.trim()}` })
      s.showToast('Resposta enviada')
    }
    setReply('')
    setPaused(false)
  }

  return createPortal(
    <div className="status-viewer">
      <button className="status-close" onClick={close}>
        <IconBack />
      </button>
      <div className="status-stage">
        <div className="status-bars">
          {list.map((x, idx) => (
            <div key={x.id} className="status-bar">
              <div style={{ width: `${idx < i ? 100 : idx === i ? progress * 100 : 0}%` }} />
            </div>
          ))}
        </div>
        <div className="status-head">
          <Avatar url={p?.avatar_url} size={40} />
          <div>
            <div className="status-name">{userId === uid ? 'Meu status' : p?.full_name}</div>
            <div className="status-time">{formatListDate(current.created_at)}</div>
          </div>
          <div className="grow" />
          {userId === uid && (
            <button
              className="icon-btn light"
              title="Apagar"
              onClick={() => {
                s.deleteStatus(current.id)
                close()
              }}
            >
              <IconTrash />
            </button>
          )}
        </div>
        <div
          className="status-content"
          style={current.type === 'text' ? { background: current.bg_color ?? COLORS[0] } : undefined}
          onMouseDown={() => setPaused(true)}
          onMouseUp={() => setPaused(false)}
        >
          {current.type === 'text' ? (
            <div className="status-text">{current.content}</div>
          ) : (
            <>
              <img src={current.media_url!} alt="" />
              {current.content && <div className="status-caption">{current.content}</div>}
            </>
          )}
          <button className="status-nav left" onClick={() => i > 0 && setI(i - 1)} aria-label="Anterior" />
          <button
            className="status-nav right"
            onClick={() => (i < list.length - 1 ? setI(i + 1) : close())}
            aria-label="Próximo"
          />
        </div>
        {userId === uid ? (
          <button className="status-views" onClick={() => setShowViewers((v) => !v)}>
            👁 {viewers?.length ?? 0}
          </button>
        ) : (
          <div className="status-reply">
            <input
              placeholder="Responder..."
              value={reply}
              onFocus={() => setPaused(true)}
              onBlur={() => !reply && setPaused(false)}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendReply()}
            />
            <button className="icon-btn light" onClick={sendReply}>
              <IconSend />
            </button>
          </div>
        )}
        {showViewers && viewers && (
          <div className="status-viewers">
            <div className="status-viewers-title">Visto por {viewers.length}</div>
            {viewers.map((v) => (
              <div key={v.viewer_id} className="status-viewer-row">
                <Avatar url={s.profiles[v.viewer_id]?.avatar_url} size={36} />
                <div>
                  <div>{s.profiles[v.viewer_id]?.full_name}</div>
                  <div className="muted small">{formatListDate(v.viewed_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
