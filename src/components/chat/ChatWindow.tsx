import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '../../store/chat'
import { useCall } from '../call/callStore'
import {
  IconBack,
  IconChevronDown,
  IconClose,
  IconCopy,
  IconDots,
  IconForward,
  IconReply,
  IconPhone,
  IconSearch,
  IconStar,
  IconTrash,
  IconVideo,
} from '../../lib/icons'
import { Avatar, Confirm, Menu, Spinner, useIsMobile, type MenuItem } from '../common'
import { MessageBubble, DeleteDialog, createStickerFrom, download } from './MessageBubble'
import { Composer, MediaPreview } from './Composer'
import {
  conversationTitle,
  downscaleImage,
  formatDayLabel,
  formatLastSeen,
  otherMemberId,
  sameDay,
  cx,
  systemText,
  ts,
} from '../../lib/utils'
import type { Message } from '../../lib/types'

export function ChatWindow() {
  const s = useChat()
  const uid = s.session!.user.id
  const convId = s.activeId!
  const conv = s.conversations[convId]
  const members = s.members[convId]
  const [files, setFiles] = useState<File[] | null>(null)
  const mobile = useIsMobile()
  const [dragging, setDragging] = useState(false)

  const onSendFiles = async (items: { file: File; caption: string }[]) => {
    setFiles(null)
    const reply = s.replyTo
    s.set({ replyTo: null })
    for (const [i, { file, caption }] of items.entries()) {
      const kind = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : file.type.startsWith('audio/')
            ? 'audio'
            : 'document'
      if (file.size > 50 * 1024 * 1024) {
        s.showToast(`${file.name}: arquivos acima de 50 MB não são suportados`)
        continue
      }
      let blob: Blob = file
      if (kind === 'image' && file.type !== 'image/gif') {
        const small = await downscaleImage(file)
        blob = small === file ? file : new File([small], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' })
      }
      let duration: number | null = null
      if (kind === 'video' || kind === 'audio') duration = await mediaDuration(file)
      await s.sendMedia(convId, blob, kind, {
        content: caption.trim() || null,
        media_name: file.name,
        media_duration: duration,
        reply_to: i === 0 ? (reply?.id ?? null) : null,
      })
    }
  }

  if (!conv) return null

  return (
    <div
      className="chat-window"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const dropped = Array.from(e.dataTransfer.files)
        if (dropped.length) setFiles((f) => [...(f ?? []), ...dropped])
      }}
    >
      {s.selecting && mobile ? <SelectionHeader /> : <ChatHeader />}
      {files ? (
        <MediaPreview
          files={files}
          onClose={() => setFiles(null)}
          onAdd={(more) => setFiles((f) => [...(f ?? []), ...more])}
          onSend={onSendFiles}
        />
      ) : (
        <>
          <MessageList key={convId} />
          {s.selecting && !mobile ? (
            <SelectionBar />
          ) : members?.some((m) => m.user_id === uid) ? (
            <Composer convId={convId} onFiles={(f) => setFiles(f)} />
          ) : (
            <div className="composer-disabled">Você não pode enviar mensagens para este grupo porque não é mais participante.</div>
          )}
        </>
      )}
      {dragging && !files && <div className="drop-zone">Solte os arquivos aqui</div>}
    </div>
  )
}

function mediaDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio')
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      resolve(isFinite(el.duration) ? Math.round(el.duration) : null)
      URL.revokeObjectURL(el.src)
    }
    el.onerror = () => resolve(null)
    el.src = URL.createObjectURL(file)
  })
}

function ChatHeader() {
  const s = useChat()
  const uid = s.session!.user.id
  const convId = s.activeId!
  const conv = s.conversations[convId]
  const members = s.members[convId]
  const startCall = useCall((c) => c.startCall)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [confirm, setConfirm] = useState<null | 'clear' | 'delete'>(null)
  const otherId = otherMemberId(members, uid)
  const other = s.profiles[otherId]
  const title = conversationTitle(conv, members, s.profiles, uid)
  const mine = members?.find((m) => m.user_id === uid)

  const typing = Object.entries(s.typing[convId] ?? {})
  let subtitle: React.ReactNode
  if (typing.length) {
    subtitle = (
      <span className="typing-text">
        {(() => {
          const verb = typing.some(([, t]) => t.kind === 'recording') ? 'gravando áudio...' : 'digitando...'
          return conv.is_group
            ? `${typing.map(([id]) => s.profiles[id]?.full_name?.split(' ')[0]).join(', ')} está ${verb}`
            : verb
        })()}
      </span>
    )
  } else if (conv.is_group) {
    const names = (members ?? [])
      .map((m) => (m.user_id === uid ? 'Você' : s.profiles[m.user_id]?.full_name?.split(' ')[0]))
      .filter(Boolean)
      .sort((a, b) => (a === 'Você' ? 1 : b === 'Você' ? -1 : a!.localeCompare(b!)))
    subtitle = names.join(', ')
  } else if (otherId !== uid) {
    subtitle = s.online.has(otherId) ? 'online' : other ? formatLastSeen(other.last_seen) : ''
  } else {
    subtitle = 'Envie mensagens para si mesmo'
  }

  return (
    <header className="chat-header">
      <button className="icon-btn mobile-only" onClick={() => s.openChat(null)} aria-label="Voltar">
        <IconBack />
      </button>
      <div className="chat-header-main" onClick={() => s.set({ rightPanel: s.rightPanel === 'info' ? null : 'info' })}>
        <Avatar url={conv.is_group ? conv.avatar_url : other?.avatar_url} group={conv.is_group} size={40} />
        <div className="chat-header-text">
          <div className="chat-header-title">{title}</div>
          <div className="chat-header-sub">{subtitle || 'clique para mostrar os dados'}</div>
        </div>
      </div>
      <div className="header-actions">
        {!conv.is_group && otherId !== uid && (
          <>
            <button className="icon-btn" title="Chamada de vídeo" onClick={() => startCall(convId, otherId, true)}>
              <IconVideo />
            </button>
            <button className="icon-btn" title="Chamada de voz" onClick={() => startCall(convId, otherId, false)}>
              <IconPhone />
            </button>
          </>
        )}
        <button
          className="icon-btn"
          title="Pesquisar"
          onClick={() => s.set({ rightPanel: s.rightPanel === 'search' ? null : 'search' })}
        >
          <IconSearch />
        </button>
        <button className="icon-btn" title="Mais opções" onClick={(e) => setMenu(e.currentTarget)}>
          <IconDots />
        </button>
      </div>
      {menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: conv.is_group ? 'Dados do grupo' : 'Dados do contato', onClick: () => s.set({ rightPanel: 'info' }) },
            { label: 'Selecionar mensagens', onClick: () => s.set({ selecting: new Set() }) },
            {
              label: mine?.muted ? 'Reativar notificações' : 'Silenciar notificações',
              onClick: () => s.updateMember(convId, { muted: !mine?.muted }),
            },
            { label: 'Mensagens favoritas', onClick: () => s.set({ rightPanel: 'starred' }) },
            { label: 'Fechar conversa', onClick: () => s.openChat(null) },
            'divider',
            { label: 'Limpar conversa', onClick: () => setConfirm('clear') },
            { label: conv.is_group ? 'Sair do grupo' : 'Apagar conversa', danger: true, onClick: () => setConfirm('delete') },
          ]}
        />
      )}
      {confirm && (
        <Confirm
          text={
            confirm === 'clear'
              ? `Limpar todas as mensagens desta conversa?`
              : conv.is_group
                ? `Sair do grupo "${title}"?`
                : `Apagar conversa com ${title}?`
          }
          confirmLabel={confirm === 'clear' ? 'Limpar conversa' : conv.is_group ? 'Sair' : 'Apagar'}
          danger
          onConfirm={() => (confirm === 'clear' ? s.clearChat(convId) : s.deleteChat(convId))}
          onClose={() => setConfirm(null)}
        />
      )}
    </header>
  )
}

function MessageList() {
  const s = useChat()
  const uid = s.session!.user.id
  const convId = s.activeId!
  const conv = s.conversations[convId]
  const members = s.members[convId]
  const raw = s.messages[convId]
  const ref = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [newWhileUp, setNewWhileUp] = useState(0)
  const prevHeight = useRef(0)
  const prevLen = useRef(0)
  const initialScroll = useRef(false)

  // divisor "mensagens não lidas" calculado ao abrir a conversa
  const unreadMarker = useRef<{ id: string; count: number } | null>(null)
  const markerComputed = useRef(false)

  const list = useMemo(() => (raw ?? []).filter((m) => !s.hidden.has(m.id)), [raw, s.hidden])

  if (!markerComputed.current && raw) {
    markerComputed.current = true
    const me = members?.find((m) => m.user_id === uid)
    if (me) {
      const unreadMsgs = list.filter(
        (m) => m.sender_id !== uid && m.type !== 'system' && ts(m.created_at) > ts(me.last_read_at),
      )
      const count = Math.max(unreadMsgs.length, useChat.getState().unread[convId] ?? 0)
      if (unreadMsgs.length) unreadMarker.current = { id: unreadMsgs[0].id, count }
    }
  }

  // rolagem inicial / ao chegar mensagem
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !raw) return
    if (!initialScroll.current) {
      initialScroll.current = true
      const marker = unreadMarker.current && document.getElementById(`unread-${unreadMarker.current.id}`)
      if (marker) marker.scrollIntoView({ block: 'center' })
      else el.scrollTop = el.scrollHeight
      prevLen.current = list.length
      return
    }
    if (loadingOlder || prevHeight.current) {
      el.scrollTop = el.scrollHeight - prevHeight.current
      prevHeight.current = 0
    } else if (list.length > prevLen.current) {
      const last = list[list.length - 1]
      if (atBottom || last?.sender_id === uid) el.scrollTop = el.scrollHeight
      else setNewWhileUp((n) => n + (list.length - prevLen.current))
    }
    prevLen.current = list.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length, raw])

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !s.hasMore[convId]) return
    setLoadingOlder(true)
    prevHeight.current = ref.current?.scrollHeight ?? 0
    await s.loadMessages(convId, true)
    setLoadingOlder(false)
  }, [loadingOlder, s, convId])

  // Mantém a conversa "grudada" no fim quando a área muda de tamanho
  // (painel de emojis/figurinhas, resposta, caixa de texto crescendo, imagens carregando, janela redimensionada)
  const stick = useRef(true)
  const inner = useRef<HTMLDivElement>(null)
  const loaded = !!raw
  useEffect(() => {
    const el = ref.current
    if (!el || !inner.current) return
    const ro = new ResizeObserver(() => {
      if (stick.current && !prevHeight.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    ro.observe(inner.current)
    return () => ro.disconnect()
  }, [loaded])

  const onScroll = () => {
    const el = ref.current!
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setAtBottom(bottom)
    if (bottom) setNewWhileUp(0)
    if (el.scrollTop < 200) loadOlder()
  }

  const jump = useCallback(
    async (id: string) => {
      let tries = 0
      while (!document.getElementById(`msg-${id}`) && useChat.getState().hasMore[convId] && tries < 30) {
        prevHeight.current = ref.current?.scrollHeight ?? 0
        await useChat.getState().loadMessages(convId, true)
        tries++
        await new Promise((r) => requestAnimationFrame(r))
      }
      const el = document.getElementById(`msg-${id}`)
      if (!el) return useChat.getState().showToast('Mensagem não encontrada')
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setHighlight(id)
      setTimeout(() => setHighlight(null), 1800)
    },
    [convId],
  )

  useEffect(() => {
    if (s.jumpTo && raw) {
      jump(s.jumpTo)
      s.set({ jumpTo: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.jumpTo, raw])

  const wallpaper = s.settings.wallpaper
  const style = wallpaper !== 'default' ? { backgroundColor: wallpaper, backgroundImage: 'none' } : undefined

  if (!raw)
    return (
      <div className="messages wallpaper" style={style}>
        <div className="center-pad">
          <Spinner />
        </div>
      </div>
    )

  const searchTerm = s.rightPanel === 'search' ? s.searchQuery : undefined
  const myMember = members?.find((m) => m.user_id === uid)

  return (
    <div className="messages-wrap">
      <div className="messages wallpaper scroll" ref={ref} onScroll={onScroll} style={style}>
        <div className="messages-inner" ref={inner}>
        {loadingOlder && (
          <div className="center-pad">
            <Spinner size={22} />
          </div>
        )}
        {!s.hasMore[convId] && (
          <div className="e2e-banner">
            🔒 As mensagens ficam guardadas no seu banco Supabase e são protegidas por políticas de acesso. Somente
            os participantes desta conversa podem lê-las.
          </div>
        )}
        {list.map((m, i) => {
          const prev = list[i - 1]
          const newDay = !prev || !sameDay(prev.created_at, m.created_at)
          const firstOfGroup =
            newDay || !prev || prev.sender_id !== m.sender_id || prev.type === 'system' || ts(m.created_at) - ts(prev.created_at) > 10 * 60 * 1000
          const nodes: React.ReactNode[] = []
          if (newDay)
            nodes.push(
              <div key={`d-${m.id}`} className="day-sep">
                <span>{formatDayLabel(m.created_at)}</span>
              </div>,
            )
          if (unreadMarker.current?.id === m.id)
            nodes.push(
              <div key={`u-${m.id}`} id={`unread-${m.id}`} className="unread-sep">
                <span>
                  {unreadMarker.current.count} MENSAGE{unreadMarker.current.count === 1 ? 'M NÃO LIDA' : 'NS NÃO LIDAS'}
                </span>
              </div>,
            )
          if (m.type === 'system') {
            nodes.push(
              <div key={m.id} id={`msg-${m.id}`} className="system-msg">
                <span>{systemText(m, s.profiles, uid)}</span>
              </div>,
            )
            return nodes
          }
          const replied = m.reply_to
            ? (list.find((x) => x.id === m.reply_to) ?? s.extraMessages[m.reply_to])
            : undefined
          nodes.push(
            <MessageBubble
              key={m.id}
              msg={m}
              isMine={m.sender_id === uid}
              showTail={firstOfGroup}
              showName={firstOfGroup}
              isGroup={conv.is_group}
              members={members}
              myId={uid}
              sender={s.profiles[m.sender_id ?? '']}
              reactions={s.reactions[m.id]}
              replied={replied}
              repliedSender={
                replied ? (replied.sender_id === uid ? 'Você' : s.profiles[replied.sender_id ?? '']?.full_name) : undefined
              }
              starred={s.starred.has(m.id)}
              selected={!!s.selecting?.has(m.id)}
              selecting={!!s.selecting}
              highlighted={highlight === m.id}
              searchTerm={searchTerm}
              onJump={jump}
            />,
          )
          return nodes
        })}
        {myMember && !conv.is_group && list.length === 0 && (
          <div className="empty-chat-hint">Envie uma mensagem para começar a conversa 👋</div>
        )}
        </div>
      </div>
      {!atBottom && (
        <button
          className="scroll-bottom"
          onClick={() => {
            stick.current = true
            ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
            setNewWhileUp(0)
          }}
          aria-label="Ir para o fim"
        >
          {newWhileUp > 0 && <span className="badge">{newWhileUp}</span>}
          <IconChevronDown />
        </button>
      )}
    </div>
  )
}

/**
 * Celular: mensagem(ns) selecionada(s) com toque longo → as ações ficam no topo, como no WhatsApp:
 * ← · quantidade · Responder · Favoritar · Apagar · Copiar · Encaminhar · ⋮ (Editar, Baixar, ...)
 */
function SelectionHeader() {
  const s = useChat()
  const uid = s.session!.user.id
  const convId = s.activeId!
  const [confirm, setConfirm] = useState(false)
  const [more, setMore] = useState<HTMLElement | null>(null)
  const ids = s.selecting!
  const msgs: Message[] = (s.messages[convId] ?? []).filter((m) => ids.has(m.id))
  const one = msgs.length === 1 ? msgs[0] : null
  const done = () => s.set({ selecting: null })
  const anyDeleted = msgs.some((m) => m.deleted_for_everyone)
  const texts = msgs.filter((m) => !m.deleted_for_everyone && m.content && ['text', 'image', 'video'].includes(m.type))
  const canCopy = msgs.length > 0 && texts.length === msgs.length
  const canForAll =
    msgs.length > 0 &&
    msgs.every((m) => m.sender_id === uid && !m.deleted_for_everyone && Date.now() - ts(m.created_at) < 48 * 3600 * 1000)
  const allStarred = msgs.length > 0 && msgs.every((m) => s.starred.has(m.id))

  const moreItems = (): MenuItem[] => {
    const items: MenuItem[] = []
    if (one && !one.deleted_for_everyone) {
      const canEdit =
        one.sender_id === uid && one.type === 'text' && !one.pending && Date.now() - ts(one.created_at) < 15 * 60 * 1000
      if (canEdit) items.push({ label: 'Editar', onClick: () => s.set({ editing: one, replyTo: null, selecting: null }) })
      if (one.media_url && one.type !== 'sticker')
        items.push({ label: 'Baixar', onClick: () => (download(one.media_url!, one.media_name ?? 'arquivo'), done()) })
      if (one.type === 'image' && one.media_url)
        items.push({ label: 'Criar figurinha', onClick: () => (createStickerFrom(one.media_url!), done()) })
      if (one.type === 'sticker' && one.media_url && !s.stickers.some((x) => x.image_url === one.media_url))
        items.push({ label: 'Adicionar às figurinhas', onClick: () => (s.addStickerFromUrl(one.media_url!), done()) })
    }
    items.push({
      label: 'Selecionar todas',
      onClick: () => s.set({ selecting: new Set((s.messages[convId] ?? []).filter((m) => m.type !== 'system').map((m) => m.id)) }),
    })
    return items
  }

  return (
    <header className="chat-header selection-header">
      <button className="icon-btn" onClick={done} aria-label="Cancelar seleção">
        <IconBack />
      </button>
      <span className="selection-count">{ids.size}</span>
      <div className="grow" />
      {one && !one.deleted_for_everyone && (
        <button className="icon-btn" title="Responder" aria-label="Responder" onClick={() => s.set({ replyTo: one, editing: null, selecting: null })}>
          <IconReply />
        </button>
      )}
      {!anyDeleted && msgs.length > 0 && (
        <button
          className={cx('icon-btn', allStarred && 'active')}
          title={allStarred ? 'Desfavoritar' : 'Favoritar'}
          aria-label="Favoritar"
          onClick={() => s.toggleStar(msgs).then(done)}
        >
          <IconStar />
        </button>
      )}
      <button className="icon-btn" title="Apagar" aria-label="Apagar" disabled={!msgs.length} onClick={() => setConfirm(true)}>
        <IconTrash />
      </button>
      {canCopy && (
        <button
          className="icon-btn"
          title="Copiar"
          aria-label="Copiar"
          onClick={() => {
            navigator.clipboard.writeText(texts.map((m) => m.content).join('\n'))
            s.showToast(msgs.length > 1 ? 'Mensagens copiadas' : 'Mensagem copiada')
            done()
          }}
        >
          <IconCopy />
        </button>
      )}
      {!anyDeleted && msgs.length > 0 && (
        <button className="icon-btn" title="Encaminhar" aria-label="Encaminhar" onClick={() => s.set({ forwarding: msgs, selecting: null })}>
          <IconForward />
        </button>
      )}
      <button className="icon-btn" title="Mais opções" aria-label="Mais opções" onClick={(e) => setMore(e.currentTarget)}>
        <IconDots />
      </button>
      {more && <Menu anchor={more} items={moreItems()} onClose={() => setMore(null)} />}
      {confirm && (
        <DeleteDialog
          count={msgs.length}
          canForAll={canForAll}
          onClose={() => setConfirm(false)}
          onForAll={async () => {
            for (const m of msgs) await s.deleteForEveryone(m)
            done()
          }}
          onForMe={async () => {
            await s.deleteForMe(msgs)
            done()
          }}
        />
      )}
    </header>
  )
}

function SelectionBar() {
  const s = useChat()
  const uid = s.session!.user.id
  const convId = s.activeId!
  const [confirm, setConfirm] = useState(false)
  const ids = s.selecting!
  const msgs: Message[] = (s.messages[convId] ?? []).filter((m) => ids.has(m.id))
  const canForAll =
    msgs.length > 0 &&
    msgs.every((m) => m.sender_id === uid && !m.deleted_for_everyone && Date.now() - ts(m.created_at) < 48 * 3600 * 1000)
  return (
    <div className="selection-bar">
      <button className="icon-btn" onClick={() => s.set({ selecting: null })} aria-label="Cancelar">
        <IconClose />
      </button>
      <span className="grow">
        {ids.size} selecionada{ids.size === 1 ? '' : 's'}
      </span>
      <button className="icon-btn" disabled={!msgs.length} title="Favoritar" onClick={() => s.toggleStar(msgs).then(() => s.set({ selecting: null }))}>
        <IconStar />
      </button>
      <button className="icon-btn" disabled={!msgs.length} title="Apagar" onClick={() => setConfirm(true)}>
        <IconTrash />
      </button>
      <button
        className="icon-btn"
        disabled={!msgs.length || msgs.some((m) => m.deleted_for_everyone)}
        title="Encaminhar"
        onClick={() => s.set({ forwarding: msgs, selecting: null })}
      >
        <IconForward />
      </button>
      {confirm && (
        <DeleteDialog
          count={msgs.length}
          canForAll={canForAll}
          onClose={() => setConfirm(false)}
          onForAll={async () => {
            for (const m of msgs) await s.deleteForEveryone(m)
            s.set({ selecting: null })
          }}
          onForMe={async () => {
            await s.deleteForMe(msgs)
            s.set({ selecting: null })
          }}
        />
      )}
    </div>
  )
}

export function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-art">
          <svg viewBox="0 0 320 200" width="320" height="200" aria-hidden="true">
            <rect x="40" y="30" width="180" height="120" rx="12" className="w-screen" />
            <rect x="52" y="44" width="70" height="92" rx="6" className="w-side" />
            <rect x="130" y="50" width="78" height="14" rx="7" className="w-bubble in" />
            <rect x="148" y="72" width="60" height="14" rx="7" className="w-bubble out" />
            <rect x="130" y="94" width="70" height="14" rx="7" className="w-bubble in" />
            <rect x="200" y="80" width="80" height="100" rx="14" className="w-phone" />
            <rect x="212" y="98" width="56" height="10" rx="5" className="w-bubble out" />
            <rect x="212" y="116" width="44" height="10" rx="5" className="w-bubble in" />
            <rect x="212" y="134" width="50" height="10" rx="5" className="w-bubble out" />
          </svg>
        </div>
        <h1>Zap Web</h1>
        <p>
          Envie e receba mensagens em tempo real.
          <br />
          Crie figurinhas a partir de fotos, com o fundo removido automaticamente.
        </p>
        <div className="welcome-foot">🔒 Seus dados ficam no seu projeto Supabase</div>
      </div>
    </div>
  )
}
