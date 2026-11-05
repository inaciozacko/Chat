import { memo, useState, type ReactNode } from 'react'
import EmojiPicker, { EmojiStyle, Theme } from 'emoji-picker-react'
import { useChat } from '../../store/chat'
import type { Member, Message, Profile, Reaction } from '../../lib/types'
import {
  IconBlock,
  IconCheck,
  IconChevronDown,
  IconDocument,
  IconDownload,
  IconForward,
  IconPlay,
  IconSmile,
  IconStar,
} from '../../lib/icons'
import { Menu, Modal, Ticks, type MenuItem } from '../common'
import { AudioPlayer } from './AudioPlayer'
import {
  URL_RE,
  colorFor,
  cx,
  formatBytes,
  formatDuration,
  formatTime,
  isOnlyEmoji,
  messagePreview,
  tickState,
  ts,
} from '../../lib/utils'

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

function renderText(text: string, highlight?: string): ReactNode[] {
  // links + *negrito* _itálico_ ~tachado~ ```mono``` (formatação do original)
  const parts = text.split(URL_RE)
  // com grupo de captura no split, os índices ímpares são as URLs
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      return (
        <a key={i} href={part} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
          {part}
        </a>
      )
    }
    return <span key={i}>{formatInline(part, highlight)}</span>
  })
}

function formatInline(text: string, highlight?: string): ReactNode[] {
  const re = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```[^`]+```)/g
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(hl(text.slice(last, m.index), highlight, k++))
    const tok = m[0]
    if (tok.startsWith('```')) out.push(<code key={k++}>{tok.slice(3, -3)}</code>)
    else if (tok[0] === '*') out.push(<strong key={k++}>{hl(tok.slice(1, -1), highlight, k++)}</strong>)
    else if (tok[0] === '_') out.push(<em key={k++}>{hl(tok.slice(1, -1), highlight, k++)}</em>)
    else out.push(<del key={k++}>{hl(tok.slice(1, -1), highlight, k++)}</del>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(hl(text.slice(last), highlight, k++))
  return out
}

function hl(text: string, q: string | undefined, key: number): ReactNode {
  if (!q) return <span key={key}>{text}</span>
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return <span key={key}>{text}</span>
  return (
    <span key={key}>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </span>
  )
}

type Props = {
  msg: Message
  isMine: boolean
  showTail: boolean
  showName: boolean
  isGroup: boolean
  members: Member[] | undefined
  myId: string
  sender?: Profile
  reactions: Reaction[] | undefined
  replied?: Message
  repliedSender?: string
  starred: boolean
  selected: boolean
  selecting: boolean
  highlighted: boolean
  searchTerm?: string
  onJump: (id: string) => void
}

export const MessageBubble = memo(function MessageBubble(p: Props) {
  const { msg, isMine } = p
  const s = useChat.getState()
  const [menu, setMenu] = useState<HTMLElement | { x: number; y: number } | null>(null)
  const [reactBar, setReactBar] = useState<HTMLElement | null>(null)
  const [fullPicker, setFullPicker] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [reactionsInfo, setReactionsInfo] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const theme = useChat((st) => st.settings.theme)
  const stickers = useChat((st) => st.stickers)

  const deleted = msg.deleted_for_everyone
  const sticker = msg.type === 'sticker' && !deleted
  const bigEmoji = msg.type === 'text' && !deleted && !msg.reply_to && isOnlyEmoji(msg.content ?? '')
  const bare = sticker || bigEmoji
  const canEdit =
    isMine && msg.type === 'text' && !deleted && !msg.pending && Date.now() - ts(msg.created_at) < 15 * 60 * 1000
  const canDeleteForAll = isMine && !deleted && Date.now() - ts(msg.created_at) < 48 * 3600 * 1000

  const toggleSelect = () => {
    const sel = new Set(useChat.getState().selecting ?? [])
    if (sel.has(msg.id)) sel.delete(msg.id)
    else sel.add(msg.id)
    useChat.getState().set({ selecting: sel })
  }

  const menuItems = (): MenuItem[] => {
    if (deleted) return [{ label: 'Apagar para mim', onClick: () => s.deleteForMe([msg]) }]
    const items: MenuItem[] = [
      { label: 'Responder', onClick: () => s.set({ replyTo: msg, editing: null }) },
      { label: 'Reagir', onClick: () => setFullPicker(true) },
    ]
    if (msg.content && (msg.type === 'text' || msg.type === 'image' || msg.type === 'video'))
      items.push({
        label: 'Copiar',
        onClick: () => {
          navigator.clipboard.writeText(msg.content ?? '')
          s.showToast('Mensagem copiada')
        },
      })
    if (msg.type === 'image' && msg.media_url)
      items.push({ label: 'Criar figurinha', onClick: () => createStickerFrom(msg.media_url!) })
    if (sticker && msg.media_url && !stickers.some((x) => x.image_url === msg.media_url))
      items.push({ label: 'Adicionar às figurinhas', onClick: () => s.addStickerFromUrl(msg.media_url!) })
    if (msg.media_url && msg.type !== 'sticker')
      items.push({ label: 'Baixar', onClick: () => download(msg.media_url!, msg.media_name ?? 'arquivo') })
    items.push({ label: 'Encaminhar', onClick: () => s.set({ forwarding: [msg] }) })
    items.push({ label: p.starred ? 'Desfavoritar' : 'Favoritar', onClick: () => s.toggleStar([msg]) })
    if (canEdit) items.push({ label: 'Editar', onClick: () => s.set({ editing: msg, replyTo: null }) })
    items.push({ label: 'Selecionar', onClick: () => s.set({ selecting: new Set([msg.id]) }) })
    items.push('divider')
    items.push({ label: 'Apagar', danger: true, onClick: () => setConfirmDelete(true) })
    return items
  }

  const reactionGroups = (() => {
    const g = new Map<string, number>()
    for (const r of p.reactions ?? []) g.set(r.emoji, (g.get(r.emoji) ?? 0) + 1)
    return [...g.entries()].sort((a, b) => b[1] - a[1])
  })()
  const myReaction = p.reactions?.find((r) => r.user_id === p.myId)?.emoji

  let body: ReactNode
  if (deleted) {
    body = (
      <div className="msg-deleted">
        <IconBlock size={16} />
        {isMine ? 'Você apagou esta mensagem' : 'Esta mensagem foi apagada'}
      </div>
    )
  } else if (msg.type === 'sticker') {
    body = <img className="sticker-img" src={msg.media_url ?? ''} alt="Figurinha" draggable={false} />
  } else if (msg.type === 'image') {
    body = (
      <>
        <div
          className="msg-media"
          onClick={() =>
            msg.media_url && s.set({ lightbox: { url: msg.media_url, type: 'image', caption: msg.content } })
          }
        >
          <img src={msg.media_url ?? ''} alt="" loading="lazy" />
          {msg.pending && <div className="media-uploading" />}
        </div>
        {msg.content && <div className="msg-text caption">{renderText(msg.content, p.searchTerm)}</div>}
      </>
    )
  } else if (msg.type === 'video') {
    body = (
      <>
        <div
          className="msg-media video"
          onClick={() =>
            msg.media_url && s.set({ lightbox: { url: msg.media_url, type: 'video', caption: msg.content } })
          }
        >
          <video src={msg.media_url ?? ''} preload="metadata" muted />
          <span className="play-overlay">
            <IconPlay size={34} />
          </span>
          {msg.media_duration ? <span className="video-duration">{formatDuration(Number(msg.media_duration))}</span> : null}
        </div>
        {msg.content && <div className="msg-text caption">{renderText(msg.content, p.searchTerm)}</div>}
      </>
    )
  } else if (msg.type === 'audio') {
    body = (
      <AudioPlayer
        src={msg.media_url ?? ''}
        duration={msg.media_duration}
        avatar={p.sender?.avatar_url}
        outgoing={isMine}
      />
    )
  } else if (msg.type === 'document') {
    const ext = (msg.media_name ?? '').split('.').pop()?.toUpperCase() ?? ''
    body = (
      <>
        <a
          className="msg-doc"
          href={msg.media_url ?? '#'}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault()
            if (msg.media_url) download(msg.media_url, msg.media_name ?? 'arquivo')
          }}
        >
          <span className={cx('doc-icon', ext === 'PDF' && 'pdf')}>
            <IconDocument size={28} />
            <span>{ext.slice(0, 4)}</span>
          </span>
          <span className="doc-info">
            <span className="doc-name">{msg.media_name}</span>
            <span className="doc-size">
              {ext} · {formatBytes(msg.media_size)}
            </span>
          </span>
          <span className="doc-dl">
            <IconDownload size={22} />
          </span>
        </a>
        {msg.content && <div className="msg-text caption">{renderText(msg.content, p.searchTerm)}</div>}
      </>
    )
  } else {
    const text = msg.content ?? ''
    const long = text.length > 1200 && !expanded
    body = (
      <div className={cx('msg-text', bigEmoji && 'big-emoji')}>
        {renderText(long ? text.slice(0, 1200) + '…' : text, p.searchTerm)}
        {long && (
          <button className="read-more" onClick={() => setExpanded(true)}>
            Ler mais
          </button>
        )}
      </div>
    )
  }

  const meta = (
    <span className={cx('msg-meta', (bare || msg.type === 'image' || msg.type === 'video') && !msg.content && 'overlay')}>
      {p.starred && <IconStar size={12} />}
      {msg.edited_at && !deleted && <span className="edited">Editada</span>}
      <span>{formatTime(msg.created_at)}</span>
      {isMine && !deleted && <Ticks state={tickState(msg, p.members, p.myId)} />}
    </span>
  )

  return (
    <div
      className={cx(
        'msg-row',
        isMine ? 'out' : 'in',
        p.showTail && 'first',
        p.selecting && 'selecting',
        p.selected && 'selected',
        p.highlighted && 'highlight',
        reactionGroups.length > 0 && 'has-reactions',
      )}
      id={`msg-${msg.id}`}
      onClick={p.selecting ? toggleSelect : undefined}
      onDoubleClick={() => !p.selecting && !deleted && s.react(msg, '❤️')}
      onContextMenu={(e) => {
        if (p.selecting) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {p.selecting && (
        <span className={cx('select-box', p.selected && 'on')}>{p.selected && <IconCheck size={14} />}</span>
      )}
      <div className={cx('bubble', bare && 'bare', p.showTail && !bare && 'tail', msg.type)}>
        {p.showName && !isMine && p.isGroup && !bare && (
          <div className="msg-sender" style={{ color: colorFor(msg.sender_id ?? '') }}>
            {p.sender?.full_name ?? '...'}
          </div>
        )}
        {msg.forwarded && !deleted && (
          <div className="msg-forwarded">
            <IconForward size={16} /> Encaminhada
          </div>
        )}
        {msg.reply_to && !deleted && (
          <div
            className="msg-quote"
            style={{ borderColor: colorFor(p.replied?.sender_id ?? '') }}
            onClick={(e) => {
              e.stopPropagation()
              p.onJump(msg.reply_to!)
            }}
          >
            <div className="quote-name" style={{ color: colorFor(p.replied?.sender_id ?? '') }}>
              {p.repliedSender ?? ''}
            </div>
            <div className="quote-text">{p.replied ? messagePreview(p.replied) : 'Carregando…'}</div>
            {p.replied && (p.replied.type === 'image' || p.replied.type === 'sticker') && p.replied.media_url && (
              <img className="quote-thumb" src={p.replied.media_url} alt="" />
            )}
          </div>
        )}
        {body}
        {meta}
        {msg.failed && (
          <button
            className="retry"
            onClick={(e) => {
              e.stopPropagation()
              s.retryMessage(msg)
            }}
          >
            Falhou. Toque para reenviar
          </button>
        )}
        {!p.selecting && (
          <button
            className="msg-chevron"
            onClick={(e) => {
              e.stopPropagation()
              setMenu(e.currentTarget)
            }}
            aria-label="Opções da mensagem"
          >
            <IconChevronDown size={20} />
          </button>
        )}
        {reactionGroups.length > 0 && (
          <button
            className="reactions"
            onClick={(e) => {
              e.stopPropagation()
              setReactionsInfo(true)
            }}
          >
            {reactionGroups.slice(0, 3).map(([e]) => (
              <span key={e}>{e}</span>
            ))}
            {(p.reactions?.length ?? 0) > 1 && <span className="count">{p.reactions!.length}</span>}
          </button>
        )}
      </div>
      {!p.selecting && !deleted && !msg.pending && (
        <button
          className="react-btn"
          onClick={(e) => {
            e.stopPropagation()
            setReactBar(e.currentTarget)
          }}
          aria-label="Reagir"
        >
          <IconSmile size={18} />
        </button>
      )}

      {menu && <Menu anchor={menu} items={menuItems()} onClose={() => setMenu(null)} align={isMine ? 'right' : 'left'} />}

      {reactBar && (
        <ReactionBar
          anchor={reactBar}
          mine={myReaction}
          onPick={(e) => {
            s.react(msg, e)
            setReactBar(null)
          }}
          onMore={() => {
            setReactBar(null)
            setFullPicker(true)
          }}
          onClose={() => setReactBar(null)}
        />
      )}

      {fullPicker && (
        <Modal onClose={() => setFullPicker(false)} className="picker-modal">
          <EmojiPicker
            onEmojiClick={(e) => {
              s.react(msg, e.emoji)
              setFullPicker(false)
            }}
            theme={theme === 'dark' ? Theme.DARK : Theme.LIGHT}
            emojiStyle={EmojiStyle.NATIVE}
            searchPlaceholder="Pesquisar emoji"
            previewConfig={{ showPreview: false }}
            width={340}
            height={420}
          />
        </Modal>
      )}

      {reactionsInfo && (
        <Modal onClose={() => setReactionsInfo(false)} className="reactions-modal">
          <h3>{p.reactions?.length} reaç{p.reactions?.length === 1 ? 'ão' : 'ões'}</h3>
          {(p.reactions ?? []).map((r) => {
            const prof = useChat.getState().profiles[r.user_id]
            const mineR = r.user_id === p.myId
            return (
              <div
                key={r.user_id}
                className={cx('reaction-row', mineR && 'clickable')}
                onClick={() => {
                  if (mineR) {
                    s.react(msg, r.emoji)
                    setReactionsInfo(false)
                  }
                }}
              >
                <span className="reaction-name">
                  {mineR ? 'Você' : prof?.full_name}
                  {mineR && <span className="muted small">Clique para remover</span>}
                </span>
                <span className="reaction-emoji">{r.emoji}</span>
              </div>
            )
          })}
        </Modal>
      )}

      {confirmDelete && (
        <DeleteDialog
          canForAll={canDeleteForAll}
          onClose={() => setConfirmDelete(false)}
          onForAll={() => s.deleteForEveryone(msg)}
          onForMe={() => s.deleteForMe([msg])}
        />
      )}
    </div>
  )
})

export function DeleteDialog({
  canForAll,
  onClose,
  onForAll,
  onForMe,
  count = 1,
}: {
  canForAll: boolean
  onClose: () => void
  onForAll: () => void
  onForMe: () => void
  count?: number
}) {
  return (
    <Modal onClose={onClose} className="confirm">
      <div className="confirm-text">{count > 1 ? `Apagar ${count} mensagens?` : 'Apagar mensagem?'}</div>
      <div className="confirm-actions column">
        {canForAll && (
          <button
            className="btn-outline green"
            onClick={() => {
              onForAll()
              onClose()
            }}
          >
            Apagar para todos
          </button>
        )}
        <button
          className="btn-outline green"
          onClick={() => {
            onForMe()
            onClose()
          }}
        >
          Apagar para mim
        </button>
        <button className="btn-outline green" onClick={onClose}>
          Cancelar
        </button>
      </div>
    </Modal>
  )
}

function ReactionBar({
  anchor,
  mine,
  onPick,
  onMore,
  onClose,
}: {
  anchor: HTMLElement
  mine?: string
  onPick: (e: string) => void
  onMore: () => void
  onClose: () => void
}) {
  const r = anchor.getBoundingClientRect()
  const top = r.top - 56 < 70 ? r.bottom + 8 : r.top - 56
  const left = Math.max(8, Math.min(window.innerWidth - 330, r.left - 150))
  return (
    <>
      <div className="reaction-backdrop" onMouseDown={onClose} />
      <div className="reaction-bar" style={{ top, left }}>
        {QUICK_REACTIONS.map((e) => (
          <button key={e} className={cx(mine === e && 'mine')} onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
        <button className="more" onClick={onMore} aria-label="Mais emojis">
          +
        </button>
      </div>
    </>
  )
}

async function download(url: string, name: string) {
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  } catch {
    window.open(url, '_blank')
  }
}

async function createStickerFrom(url: string) {
  try {
    const blob = await (await fetch(url)).blob()
    useChat.getState().set({ stickerCreator: { file: blob } })
  } catch {
    useChat.getState().showToast('Não foi possível carregar a imagem')
  }
}
