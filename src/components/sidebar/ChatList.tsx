import { useMemo, useState } from 'react'
import { useChat } from '../../store/chat'
import {
  IconArchive,
  IconChatPlus,
  IconChevronDown,
  IconDots,
  IconMute,
  IconPin,
  IconSearch,
  IconClose,
} from '../../lib/icons'
import { Avatar, Confirm, Menu, Ticks, type MenuItem } from '../common'
import {
  conversationTitle,
  cx,
  formatListDate,
  messagePreview,
  otherMemberId,
  systemText,
  tickState,
  ts,
} from '../../lib/utils'
import type { Conversation } from '../../lib/types'
import { PanelHeader } from '../common'

type Filter = 'all' | 'unread' | 'groups' | 'pinned'

export function ChatList({ archived = false }: { archived?: boolean }) {
  const s = useChat()
  const uid = s.session!.user.id
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[] } | null>(null)
  const [confirm, setConfirm] = useState<{ text: string; label: string; action: () => void } | null>(null)

  const items = useMemo(() => {
    const query = q.trim().toLowerCase()
    return Object.values(s.conversations)
      .map((conv) => {
        const members = s.members[conv.id]
        const mine = members?.find((m) => m.user_id === uid)
        const last = s.lastMessages[conv.id]
        return {
          conv,
          members,
          mine,
          last,
          title: conversationTitle(conv, members, s.profiles, uid),
          unread: s.unread[conv.id] ?? 0,
          sortKey: ts(last?.created_at ?? conv.last_message_at),
        }
      })
      .filter((it) => {
        if (!it.mine) return false
        if (Boolean(it.mine.archived) !== archived) return false
        if (!it.conv.is_group && !it.last && s.activeId !== it.conv.id) return false
        if (filter === 'unread' && !(it.unread > 0 || it.mine.marked_unread)) return false
        if (filter === 'groups' && !it.conv.is_group) return false
        if (filter === 'pinned' && !it.mine.pinned) return false
        if (query && !it.title.toLowerCase().includes(query) && !(it.last?.content ?? '').toLowerCase().includes(query))
          return false
        return true
      })
      .sort((a, b) => Number(b.mine!.pinned) - Number(a.mine!.pinned) || b.sortKey - a.sortKey)
  }, [s.conversations, s.members, s.lastMessages, s.unread, s.profiles, s.activeId, uid, q, filter, archived])

  const archivedCount = useMemo(
    () =>
      Object.values(s.conversations).filter((c) => s.members[c.id]?.find((m) => m.user_id === uid)?.archived).length,
    [s.conversations, s.members, uid],
  )
  const archivedUnread = useMemo(
    () =>
      Object.values(s.conversations).filter(
        (c) => s.members[c.id]?.find((m) => m.user_id === uid)?.archived && (s.unread[c.id] ?? 0) > 0,
      ).length,
    [s.conversations, s.members, s.unread, uid],
  )

  function openMenu(e: React.MouseEvent, conv: Conversation) {
    e.stopPropagation()
    e.preventDefault()
    const mine = s.members[conv.id]?.find((m) => m.user_id === uid)
    if (!mine) return
    const title = conversationTitle(conv, s.members[conv.id], s.profiles, uid)
    const unread = (s.unread[conv.id] ?? 0) > 0 || mine.marked_unread
    const list: MenuItem[] = [
      {
        label: mine.archived ? 'Desarquivar conversa' : 'Arquivar conversa',
        onClick: () => s.updateMember(conv.id, { archived: !mine.archived, pinned: false }),
      },
      {
        label: mine.muted ? 'Reativar notificações' : 'Silenciar notificações',
        onClick: () => s.updateMember(conv.id, { muted: !mine.muted }),
      },
      {
        label: mine.pinned ? 'Desafixar conversa' : 'Fixar conversa',
        onClick: () => {
          const pinnedCount = Object.values(s.members)
            .flat()
            .filter((m) => m.user_id === uid && m.pinned).length
          if (!mine.pinned && pinnedCount >= 3) return s.showToast('Você só pode fixar até 3 conversas')
          s.updateMember(conv.id, { pinned: !mine.pinned })
        },
      },
      {
        label: unread ? 'Marcar como lida' : 'Marcar como não lida',
        onClick: () => (unread ? s.markRead(conv.id) : s.updateMember(conv.id, { marked_unread: true })),
      },
      'divider',
      {
        label: 'Limpar conversa',
        onClick: () =>
          setConfirm({
            text: `Limpar mensagens de "${title}"?`,
            label: 'Limpar conversa',
            action: () => s.clearChat(conv.id),
          }),
      },
      {
        label: conv.is_group ? 'Sair do grupo' : 'Apagar conversa',
        danger: true,
        onClick: () =>
          setConfirm({
            text: conv.is_group ? `Sair do grupo "${title}"?` : `Apagar conversa com ${title}?`,
            label: conv.is_group ? 'Sair do grupo' : 'Apagar conversa',
            action: () => s.deleteChat(conv.id),
          }),
      },
    ]
    setMenu({ anchor: e.currentTarget as HTMLElement, items: list })
  }

  const [headerMenu, setHeaderMenu] = useState<HTMLElement | null>(null)

  return (
    <div className="panel">
      {archived ? (
        <PanelHeader title="Arquivadas" onBack={() => s.set({ leftPanel: 'chats' })} />
      ) : (
        <div className="sidebar-header">
          <h1 className="brand">Zap</h1>
          <div className="header-actions">
            <button className="icon-btn" title="Nova conversa" onClick={() => s.set({ leftPanel: 'newChat' })}>
              <IconChatPlus />
            </button>
            <button className="icon-btn" title="Mais opções" onClick={(e) => setHeaderMenu(e.currentTarget)}>
              <IconDots />
            </button>
          </div>
        </div>
      )}

      <div className="search-bar">
        <div className="search-input">
          <IconSearch size={20} />
          <input
            placeholder="Pesquisar ou começar uma nova conversa"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button className="icon-btn small" onClick={() => setQ('')}>
              <IconClose size={18} />
            </button>
          )}
        </div>
      </div>

      {!archived && (
        <div className="chips">
          {(
            [
              ['all', 'Tudo'],
              ['unread', 'Não lidas'],
              ['pinned', 'Fixadas'],
              ['groups', 'Grupos'],
            ] as [Filter, string][]
          ).map(([k, label]) => (
            <button key={k} className={cx('chip', filter === k && 'active')} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="chat-list scroll">
        {!archived && archivedCount > 0 && (
          <button className="archived-row" onClick={() => s.set({ leftPanel: 'archived' })}>
            <span className="archived-icon">
              <IconArchive size={20} />
            </span>
            <span className="archived-label">Arquivadas</span>
            {archivedUnread > 0 && <span className="archived-count">{archivedUnread}</span>}
          </button>
        )}

        {items.map(({ conv, members, mine, last, title, unread }) => {
          const otherId = otherMemberId(members, uid)
          const avatar = conv.is_group ? conv.avatar_url : s.profiles[otherId]?.avatar_url
          const typing = Object.entries(s.typing[conv.id] ?? {})
          const isUnread = unread > 0 || mine!.marked_unread
          let preview: React.ReactNode = ''
          if (typing.length) {
            const [userId, t] = typing[0]
            const verb = t.kind === 'recording' ? 'gravando áudio...' : 'digitando...'
            preview = (
              <span className="typing-text">
                {conv.is_group ? `${s.profiles[userId]?.full_name?.split(' ')[0] ?? 'Alguém'} está ${verb}` : verb}
              </span>
            )
          } else if (last) {
            const mineMsg = last.sender_id === uid
            const senderName =
              conv.is_group && last.type !== 'system'
                ? mineMsg
                  ? 'Você: '
                  : `${s.profiles[last.sender_id ?? '']?.full_name?.split(' ')[0] ?? ''}: `
                : ''
            preview = (
              <>
                {mineMsg && last.type !== 'system' && !last.deleted_for_everyone && (
                  <Ticks state={tickState(last, members, uid)} />
                )}
                <span className="preview-text">
                  {senderName}
                  {last.type === 'system' ? systemText(last, s.profiles, uid) : messagePreview(last)}
                </span>
              </>
            )
          }
          return (
            <div
              key={conv.id}
              className={cx('chat-item', s.activeId === conv.id && 'active')}
              onClick={() => s.openChat(conv.id)}
              onContextMenu={(e) => openMenu(e, conv)}
            >
              <Avatar url={avatar} group={conv.is_group} />
              <div className="chat-item-body">
                <div className="chat-item-top">
                  <span className="chat-item-title">{title}</span>
                  <span className={cx('chat-item-time', isUnread && 'unread')}>
                    {last ? formatListDate(last.created_at) : ''}
                  </span>
                </div>
                <div className="chat-item-bottom">
                  <span className="chat-item-preview">{preview}</span>
                  <span className="chat-item-badges">
                    {mine!.muted && <IconMute size={18} className="muted-icon" />}
                    {mine!.pinned && <IconPin size={18} className="muted-icon" />}
                    {isUnread && (
                      <span className={cx('badge', mine!.muted && 'muted')}>{unread > 0 ? unread : ''}</span>
                    )}
                    <button className="chevron" onClick={(e) => openMenu(e, conv)} aria-label="Opções">
                      <IconChevronDown size={20} />
                    </button>
                  </span>
                </div>
              </div>
            </div>
          )
        })}

        {items.length === 0 && (
          <div className="empty-list">
            {q ? (
              'Nenhuma conversa, contato ou mensagem encontrada'
            ) : archived ? (
              'Nenhuma conversa arquivada'
            ) : (
              <>
                <p>Nenhuma conversa ainda.</p>
                <button className="btn-primary" onClick={() => s.set({ leftPanel: 'newChat' })}>
                  Começar uma conversa
                </button>
              </>
            )}
          </div>
        )}
        {!archived && items.length > 0 && (
          <div className="e2e-note">
            <span>🔒 Suas mensagens pessoais são protegidas pelas políticas de acesso (RLS) do seu banco.</span>
          </div>
        )}
      </div>

      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
      {headerMenu && (
        <Menu
          anchor={headerMenu}
          onClose={() => setHeaderMenu(null)}
          items={[
            { label: 'Novo grupo', onClick: () => s.set({ leftPanel: 'newGroup' }) },
            { label: 'Mensagens favoritas', onClick: () => s.set({ leftPanel: 'starred' }) },
            { label: 'Arquivadas', onClick: () => s.set({ leftPanel: 'archived' }) },
            {
              label: 'Marcar todas como lidas',
              onClick: () => Object.keys(s.conversations).forEach((id) => (s.unread[id] ?? 0) > 0 && s.markRead(id)),
            },
            { label: 'Configurações', onClick: () => s.set({ leftPanel: 'settings' }) },
          ]}
        />
      )}
      {confirm && (
        <Confirm
          text={confirm.text}
          confirmLabel={confirm.label}
          danger
          onConfirm={confirm.action}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
