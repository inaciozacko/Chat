import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChat } from '../../store/chat'
import { supabase } from '../../lib/supabase'
import type { Message, Profile } from '../../lib/types'
import {
  IconBell,
  IconCamera,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconDownload,
  IconLogout,
  IconMute,
  IconPlus,
  IconSearch,
  IconSend,
  IconStar,
  IconTrash,
} from '../../lib/icons'
import { Avatar, Confirm, EditableField, Menu, Modal, Spinner, useFilePicker } from '../common'
import { StarredPanel } from '../sidebar/Panels'
import {
  conversationTitle,
  cx,
  formatLastSeen,
  formatListDate,
  messagePreview,
  otherMemberId,
  ts,
} from '../../lib/utils'

export function RightPanel() {
  const panel = useChat((s) => s.rightPanel)
  if (panel === 'info') return <ContactInfo />
  if (panel === 'search') return <SearchPanel />
  if (panel === 'starred') return <StarredPanel inRight />
  return null
}

function ContactInfo() {
  const s = useChat()
  const uid = s.session!.user.id
  const convId = s.activeId!
  const conv = s.conversations[convId]
  const members = s.members[convId] ?? []
  const otherId = otherMemberId(members, uid)
  const other = s.profiles[otherId]
  const mine = members.find((m) => m.user_id === uid)
  const isAdmin = mine?.role === 'admin'
  const [media, setMedia] = useState<Message[]>([])
  const [mediaOpen, setMediaOpen] = useState(false)
  const [confirm, setConfirm] = useState<null | 'clear' | 'leave'>(null)
  const [memberMenu, setMemberMenu] = useState<{ el: HTMLElement; p: Profile } | null>(null)
  const [adding, setAdding] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [common, setCommon] = useState<string[]>([])

  const pickIcon = useFilePicker('image/*', async ([f]) => {
    setUploading(true)
    try {
      const url = await s.uploadAvatar(f)
      await s.updateConversation(convId, { avatar_url: url }, 'changed_icon')
    } catch (e) {
      s.showToast((e as Error).message)
    }
    setUploading(false)
  })

  useEffect(() => {
    supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', convId)
      .in('type', ['image', 'video', 'document'])
      .eq('deleted_for_everyone', false)
      .order('created_at', { ascending: false })
      .limit(60)
      .then(({ data }) => setMedia((data ?? []) as Message[]))
  }, [convId, s.lastMessages[convId]?.id])

  useEffect(() => {
    if (conv?.is_group || otherId === uid) return setCommon([])
    const groups = Object.values(s.conversations)
      .filter((c) => c.is_group && s.members[c.id]?.some((m) => m.user_id === otherId))
      .map((c) => c.id)
    setCommon(groups)
  }, [conv?.is_group, otherId, uid, s.conversations, s.members])

  if (!conv) return null
  const title = conversationTitle(conv, members, s.profiles, uid)
  const photos = media.filter((m) => m.type !== 'document')
  const docs = media.filter((m) => m.type === 'document')

  const sortedMembers = [...members].sort((a, b) =>
    a.user_id === uid ? -1 : b.user_id === uid ? 1 : a.role !== b.role ? (a.role === 'admin' ? -1 : 1) : 0,
  )

  return (
    <aside className="right-panel">
      <div className="panel-header">
        <button className="icon-btn" onClick={() => s.set({ rightPanel: null })} aria-label="Fechar">
          <IconClose />
        </button>
        <h2>{conv.is_group ? 'Dados do grupo' : 'Dados do contato'}</h2>
      </div>
      <div className="scroll info-scroll">
        <section className="info-hero">
          <div className={cx('info-avatar', conv.is_group && 'editable')} onClick={conv.is_group ? pickIcon : undefined}>
            <Avatar
              url={conv.is_group ? conv.avatar_url : other?.avatar_url}
              group={conv.is_group}
              size={200}
              onClick={
                !conv.is_group && other?.avatar_url
                  ? () => s.set({ lightbox: { url: other.avatar_url!, type: 'image' } })
                  : undefined
              }
            />
            {conv.is_group && (
              <div className="profile-avatar-overlay">
                {uploading ? <Spinner /> : <IconCamera size={28} />}
                <span>MUDAR IMAGEM DO GRUPO</span>
              </div>
            )}
          </div>
          {conv.is_group ? (
            <EditableField
              label=""
              value={conv.name ?? ''}
              maxLength={100}
              onSave={(v) => v && s.updateConversation(convId, { name: v }, `renamed:${v}`)}
            />
          ) : (
            <h2 className="info-name">{title}</h2>
          )}
          <div className="muted">
            {conv.is_group
              ? `Grupo · ${members.length} participante${members.length === 1 ? '' : 's'}`
              : [other?.phone, other?.username && `@${other.username}`].filter(Boolean).join(' · ')}
          </div>
          {!conv.is_group && otherId !== uid && (
            <div className="muted small">{s.online.has(otherId) ? 'online' : other && formatLastSeen(other.last_seen)}</div>
          )}
        </section>

        <section className="info-section">
          {conv.is_group ? (
            <EditableField
              label="Descrição do grupo"
              value={conv.description ?? ''}
              maxLength={512}
              multiline
              onSave={(v) => s.updateConversation(convId, { description: v || null }, 'changed_description')}
            />
          ) : (
            <>
              <div className="info-label">Recado</div>
              <div>{other?.about}</div>
            </>
          )}
          {conv.is_group && (
            <div className="muted small">
              Grupo criado em {new Date(conv.created_at).toLocaleDateString('pt-BR')}
              {conv.created_by && ` por ${conv.created_by === uid ? 'você' : s.profiles[conv.created_by]?.full_name ?? '…'}`}
            </div>
          )}
        </section>

        <section className="info-section">
          <button className="info-row-head" onClick={() => setMediaOpen(true)}>
            <span>Mídia, links e docs</span>
            <span className="muted">
              {media.length} <IconChevronRight size={18} />
            </span>
          </button>
          <div className="info-media">
            {photos.slice(0, 3).map((m) => (
              <button
                key={m.id}
                className="info-thumb"
                onClick={() => s.set({ lightbox: { url: m.media_url!, type: m.type as 'image' | 'video', caption: m.content } })}
              >
                {m.type === 'image' ? <img src={m.media_url!} alt="" /> : <video src={m.media_url!} muted />}
              </button>
            ))}
          </div>
        </section>

        <section className="info-section clickable" onClick={() => s.set({ rightPanel: 'starred' })}>
          <div className="info-action">
            <IconStar /> <span className="grow">Mensagens favoritas</span> <IconChevronRight size={18} />
          </div>
        </section>

        <section className="info-section">
          <div className="info-action">
            {mine?.muted ? <IconMute /> : <IconBell />}
            <span className="grow">Silenciar notificações</span>
            <button
              className={cx('toggle', mine?.muted && 'on')}
              onClick={() => s.updateMember(convId, { muted: !mine?.muted })}
              role="switch"
              aria-checked={!!mine?.muted}
            >
              <span />
            </button>
          </div>
        </section>

        {conv.is_group && (
          <section className="info-section members">
            <div className="info-row-head static">
              <span>{members.length} participantes</span>
              <IconSearch size={18} className="muted" />
            </div>
            {isAdmin && (
              <button className="action-row" onClick={() => setAdding(true)}>
                <span className="action-icon">
                  <IconPlus />
                </span>
                Adicionar participante
              </button>
            )}
            {sortedMembers.map((m) => {
              const p = s.profiles[m.user_id]
              return (
                <div
                  key={m.user_id}
                  className="chat-item contact"
                  onClick={(e) => p && m.user_id !== uid && setMemberMenu({ el: e.currentTarget, p })}
                >
                  <Avatar url={p?.avatar_url} size={40} />
                  <div className="chat-item-body">
                    <div className="chat-item-top">
                      <span className="chat-item-title">{m.user_id === uid ? 'Você' : p?.full_name}</span>
                      {m.role === 'admin' && <span className="admin-tag">Admin do grupo</span>}
                    </div>
                    <div className="chat-item-bottom">
                      <span className="chat-item-preview">{p?.about}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </section>
        )}

        {!conv.is_group && common.length > 0 && (
          <section className="info-section">
            <div className="info-label">{common.length} grupo{common.length > 1 ? 's' : ''} em comum</div>
            {common.map((id) => {
              const c = s.conversations[id]
              return (
                <div key={id} className="chat-item contact" onClick={() => s.openChat(id)}>
                  <Avatar url={c.avatar_url} group size={40} />
                  <div className="chat-item-body">
                    <div className="chat-item-top">
                      <span className="chat-item-title">{c.name}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </section>
        )}

        <section className="info-section danger-list">
          <button className="info-action danger" onClick={() => setConfirm('clear')}>
            <IconTrash /> Limpar conversa
          </button>
          <button className="info-action danger" onClick={() => setConfirm('leave')}>
            {conv.is_group ? <IconLogout /> : <IconTrash />} {conv.is_group ? 'Sair do grupo' : 'Apagar conversa'}
          </button>
        </section>
      </div>

      {mediaOpen && (
        <Modal onClose={() => setMediaOpen(false)} className="media-modal">
          <div className="panel-header">
            <button className="icon-btn" onClick={() => setMediaOpen(false)}>
              <IconClose />
            </button>
            <h2>Mídia e documentos</h2>
          </div>
          <div className="scroll media-modal-body">
            <div className="info-label">Mídia ({photos.length})</div>
            <div className="media-grid">
              {photos.map((m) => (
                <button
                  key={m.id}
                  className="info-thumb"
                  onClick={() => s.set({ lightbox: { url: m.media_url!, type: m.type as 'image' | 'video', caption: m.content } })}
                >
                  {m.type === 'image' ? <img src={m.media_url!} alt="" /> : <video src={m.media_url!} muted />}
                </button>
              ))}
            </div>
            <div className="info-label">Documentos ({docs.length})</div>
            {docs.map((m) => (
              <a key={m.id} className="doc-row" href={m.media_url!} target="_blank" rel="noreferrer">
                <IconDownload size={18} /> <span className="grow">{m.media_name}</span>
                <span className="muted small">{formatListDate(m.created_at)}</span>
              </a>
            ))}
          </div>
        </Modal>
      )}

      {memberMenu && (
        <Menu
          anchor={memberMenu.el}
          align="left"
          onClose={() => setMemberMenu(null)}
          items={[
            { label: `Conversar com ${memberMenu.p.full_name.split(' ')[0]}`, onClick: () => s.startDirect(memberMenu.p.id) },
            ...(isAdmin
              ? [
                  {
                    label:
                      members.find((m) => m.user_id === memberMenu.p.id)?.role === 'admin'
                        ? 'Remover como admin'
                        : 'Promover a admin do grupo',
                    onClick: async () => {
                      const role = members.find((m) => m.user_id === memberMenu.p.id)?.role === 'admin' ? 'member' : 'admin'
                      const { error } = await supabase.rpc('set_member_role', {
                        conv: convId,
                        member: memberMenu.p.id,
                        new_role: role,
                      })
                      if (error) s.showToast(error.message)
                    },
                  },
                  {
                    label: `Remover ${memberMenu.p.full_name.split(' ')[0]}`,
                    danger: true,
                    onClick: async () => {
                      const { error } = await supabase.rpc('remove_group_member', { conv: convId, member: memberMenu.p.id })
                      if (error) s.showToast(error.message)
                    },
                  },
                ]
              : []),
          ]}
        />
      )}

      {adding && <AddMembers convId={convId} existing={members.map((m) => m.user_id)} onClose={() => setAdding(false)} />}

      {confirm && (
        <Confirm
          text={
            confirm === 'clear'
              ? 'Limpar todas as mensagens desta conversa?'
              : conv.is_group
                ? `Sair do grupo "${title}"?`
                : `Apagar conversa com ${title}?`
          }
          confirmLabel={confirm === 'clear' ? 'Limpar' : conv.is_group ? 'Sair' : 'Apagar'}
          danger
          onConfirm={() => (confirm === 'clear' ? s.clearChat(convId) : s.deleteChat(convId))}
          onClose={() => setConfirm(null)}
        />
      )}
    </aside>
  )
}

function AddMembers({ convId, existing, onClose }: { convId: string; existing: string[]; onClose: () => void }) {
  const showToast = useChat((s) => s.showToast)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Profile[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  useEffect(() => {
    const t = setTimeout(async () => {
      let query = supabase.from('profiles').select('*').order('full_name').limit(50)
      const term = q.trim().replace(/[%,()]/g, '')
      if (term) query = query.or(`full_name.ilike.%${term}%,username.ilike.%${term}%,phone.ilike.%${term}%`)
      const { data } = await query
      setResults(((data ?? []) as Profile[]).filter((p) => !existing.includes(p.id)))
    }, 250)
    return () => clearTimeout(t)
  }, [q, existing])
  return (
    <Modal onClose={onClose} className="list-modal">
      <div className="panel-header">
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
        <h2>Adicionar participantes</h2>
      </div>
      <div className="search-bar">
        <div className="search-input">
          <IconSearch size={20} />
          <input autoFocus placeholder="Pesquisar" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="scroll list-modal-body">
        {results.map((p) => (
          <div
            key={p.id}
            className="chat-item contact"
            onClick={() =>
              setSel((cur) => {
                const n = new Set(cur)
                if (n.has(p.id)) n.delete(p.id)
                else n.add(p.id)
                return n
              })
            }
          >
            <div className="avatar-wrap">
              <Avatar url={p.avatar_url} size={40} />
              {sel.has(p.id) && (
                <span className="select-check">
                  <IconCheck size={14} />
                </span>
              )}
            </div>
            <div className="chat-item-body">
              <div className="chat-item-top">
                <span className="chat-item-title">{p.full_name}</span>
              </div>
              <div className="chat-item-bottom">
                <span className="chat-item-preview">{p.about}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {sel.size > 0 && (
        <div className="list-modal-foot">
          <button
            className="fab"
            onClick={async () => {
              const { error } = await supabase.rpc('add_group_members', { conv: convId, member_ids: [...sel] })
              if (error) showToast(error.message)
              onClose()
            }}
          >
            <IconCheck />
          </button>
        </div>
      )}
    </Modal>
  )
}

function SearchPanel() {
  const s = useChat()
  const convId = s.activeId!
  const uid = s.session!.user.id
  const [results, setResults] = useState<Message[] | null>(null)
  const q = s.searchQuery

  useEffect(() => {
    const term = q.trim()
    if (!term) return setResults(null)
    const me = s.members[convId]?.find((m) => m.user_id === uid)
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', convId)
        .eq('deleted_for_everyone', false)
        .gt('created_at', me?.cleared_at ?? '1970-01-01')
        .ilike('content', `%${term.replace(/[%_]/g, '\\$&')}%`)
        .order('created_at', { ascending: false })
        .limit(100)
      setResults(((data ?? []) as Message[]).filter((m) => !s.hidden.has(m.id)))
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, convId])

  return (
    <aside className="right-panel">
      <div className="panel-header">
        <button className="icon-btn" onClick={() => s.set({ rightPanel: null, searchQuery: '' })} aria-label="Fechar">
          <IconClose />
        </button>
        <h2>Pesquisar mensagens</h2>
      </div>
      <div className="search-bar">
        <div className="search-input">
          <IconSearch size={20} />
          <input autoFocus placeholder="Pesquisar..." value={q} onChange={(e) => s.set({ searchQuery: e.target.value })} />
        </div>
      </div>
      <div className="scroll">
        {results === null && <div className="empty-list">Pesquisar mensagens nesta conversa.</div>}
        {results?.length === 0 && <div className="empty-list">Nenhuma mensagem encontrada</div>}
        {results?.map((m) => (
          <button key={m.id} className="search-result" onClick={() => s.set({ jumpTo: m.id })}>
            <div className="muted small">
              {formatListDate(m.created_at)} · {m.sender_id === uid ? 'Você' : s.profiles[m.sender_id ?? '']?.full_name}
            </div>
            <div className="search-snippet">{highlight(messagePreview(m), q)}</div>
          </button>
        ))}
      </div>
    </aside>
  )
}

function highlight(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0 || !q) return text
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

export function ForwardModal() {
  const s = useChat()
  const uid = s.session!.user.id
  const msgs = s.forwarding!
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const chats = useMemo(
    () =>
      Object.values(s.conversations)
        .filter((c) => s.members[c.id]?.some((m) => m.user_id === uid))
        .map((c) => ({ c, title: conversationTitle(c, s.members[c.id], s.profiles, uid) }))
        .filter(({ title }) => title.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => ts(b.c.last_message_at) - ts(a.c.last_message_at)),
    [s.conversations, s.members, s.profiles, uid, q],
  )

  const close = () => s.set({ forwarding: null })
  return (
    <Modal onClose={close} className="list-modal">
      <div className="panel-header">
        <button className="icon-btn" onClick={close}>
          <IconClose />
        </button>
        <h2>Encaminhar mensagem para</h2>
      </div>
      <div className="search-bar">
        <div className="search-input">
          <IconSearch size={20} />
          <input autoFocus placeholder="Pesquisar" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="scroll list-modal-body">
        <div className="section-label">Conversas recentes</div>
        {chats.map(({ c, title }) => {
          const other = s.profiles[otherMemberId(s.members[c.id], uid)]
          const on = sel.includes(c.id)
          return (
            <div
              key={c.id}
              className="chat-item contact"
              onClick={() => setSel((cur) => (on ? cur.filter((x) => x !== c.id) : cur.length < 5 ? [...cur, c.id] : cur))}
            >
              <span className={cx('select-box', on && 'on')}>{on && <IconCheck size={14} />}</span>
              <Avatar url={c.is_group ? c.avatar_url : other?.avatar_url} group={c.is_group} size={40} />
              <div className="chat-item-body">
                <div className="chat-item-top">
                  <span className="chat-item-title">{title}</span>
                </div>
                <div className="chat-item-bottom">
                  <span className="chat-item-preview">{c.is_group ? 'Grupo' : other?.about}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {sel.length > 0 && (
        <div className="list-modal-foot forward">
          <span className="grow ellipsis">
            {sel.map((id) => conversationTitle(s.conversations[id], s.members[id], s.profiles, uid)).join(', ')}
          </span>
          <button
            className="fab"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await s.forward(msgs, sel)
              close()
            }}
          >
            {busy ? <Spinner size={22} /> : <IconSend />}
          </button>
        </div>
      )}
    </Modal>
  )
}

export function Lightbox() {
  const s = useChat()
  const lb = s.lightbox!
  const close = () => s.set({ lightbox: null })
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  })
  return createPortal(
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="lightbox-top">
        <div className="grow" />
        <a className="icon-btn" href={lb.url} target="_blank" rel="noreferrer" download title="Baixar">
          <IconDownload />
        </a>
        <button className="icon-btn" onClick={close} title="Fechar">
          <IconClose />
        </button>
      </div>
      <div className="lightbox-stage" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        {lb.type === 'image' ? <img src={lb.url} alt="" /> : <video src={lb.url} controls autoPlay />}
      </div>
      {lb.caption && <div className="lightbox-caption">{lb.caption}</div>}
    </div>,
    document.body,
  )
}

