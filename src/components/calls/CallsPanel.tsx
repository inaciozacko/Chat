import { useEffect, useMemo, useState } from 'react'
import { useChat } from '../../store/chat'
import { useCall } from '../call/callStore'
import { useCallLog } from './callLog'
import type { CallLog } from '../../lib/types'
import { IconCallIn, IconCallOut, IconDots, IconPhone, IconVideo } from '../../lib/icons'
import { Avatar, Confirm, Menu, Spinner } from '../common'
import { cx, formatDuration, formatTime, ts } from '../../lib/utils'

type Filter = 'all' | 'missed'

function callDate(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return `Hoje, ${formatTime(iso)}`
  if (d.toDateString() === yesterday.toDateString()) return `Ontem, ${formatTime(iso)}`
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}, ${formatTime(iso)}`
}

/** Agrupa ligações seguidas com a mesma pessoa, mesmo tipo e mesmo dia — ex.: "Maria (3)" */
type Group = { first: CallLog; calls: CallLog[]; otherId: string; incoming: boolean; missed: boolean }

export function CallsPanel() {
  const s = useChat()
  const uid = s.session!.user.id
  const startCall = useCall((c) => c.startCall)
  const { list, hidden, load, markSeen, clearAll } = useCallLog()
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    load()
    markSeen()
    // marca como vistas também as que chegarem enquanto a aba está aberta
    return () => markSeen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const groups = useMemo(() => {
    const out: Group[] = []
    for (const c of list ?? []) {
      if (hidden.has(c.id) || c.status === 'ringing') continue
      const incoming = c.callee_id === uid
      const missed = incoming && (c.status === 'missed' || c.status === 'busy')
      if (filter === 'missed' && !missed) continue
      const otherId = incoming ? c.caller_id : c.callee_id
      const last = out[out.length - 1]
      if (
        last &&
        last.otherId === otherId &&
        last.incoming === incoming &&
        last.missed === missed &&
        last.first.video === c.video &&
        new Date(last.first.started_at).toDateString() === new Date(c.started_at).toDateString()
      ) {
        last.calls.push(c)
      } else out.push({ first: c, calls: [c], otherId, incoming, missed })
    }
    return out
  }, [list, hidden, filter, uid])

  useEffect(() => {
    s.fetchProfiles([...new Set(groups.map((g) => g.otherId))])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups])

  const describe = (g: Group) => {
    const c = g.first
    if (c.status === 'answered' && c.answered_at && c.ended_at)
      return formatDuration((ts(c.ended_at) - ts(c.answered_at)) / 1000)
    if (g.incoming) return c.status === 'rejected' ? 'Recusada' : 'Perdida'
    return c.status === 'rejected' ? 'Recusada' : c.status === 'busy' ? 'Ocupado' : c.status === 'failed' ? 'Falhou' : 'Não atendida'
  }

  return (
    <div className="panel">
      <div className="sidebar-header">
        <h1 className="brand">Ligações</h1>
        <div className="header-actions">
          <button className="icon-btn" title="Mais opções" onClick={(e) => setMenu(e.currentTarget)}>
            <IconDots />
          </button>
        </div>
      </div>

      <div className="chips">
        {(
          [
            ['all', 'Todas'],
            ['missed', 'Perdidas'],
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <button key={k} className={cx('chip', filter === k && 'active')} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>

      <div className="scroll chat-list">
        {list === null && (
          <div className="center-pad">
            <Spinner />
          </div>
        )}
        {list && groups.length > 0 && <div className="section-label">Recentes</div>}
        {groups.map((g) => {
          const p = s.profiles[g.otherId]
          const conv = s.conversations[g.first.conversation_id]
          return (
            <div
              key={g.first.id}
              className="chat-item call-item"
              onClick={() => {
                if (!conv) return
                s.set({ leftPanel: 'chats' })
                s.openChat(conv.id)
              }}
            >
              <Avatar url={p?.avatar_url} />
              <div className="chat-item-body">
                <div className="chat-item-top">
                  <span className={cx('chat-item-title', g.missed && 'missed')}>
                    {p?.full_name ?? 'Contato'}
                    {g.calls.length > 1 && <span className="call-count"> ({g.calls.length})</span>}
                  </span>
                </div>
                <div className="chat-item-bottom">
                  <span className="chat-item-preview call-meta">
                    {g.incoming ? (
                      <IconCallIn size={16} className={cx('call-arrow', g.missed ? 'missed' : 'ok')} />
                    ) : (
                      <IconCallOut size={16} className="call-arrow ok" />
                    )}
                    <span>
                      {callDate(g.first.started_at)} · {describe(g)}
                    </span>
                  </span>
                </div>
              </div>
              <button
                className="icon-btn call-back"
                title={g.first.video ? 'Ligar com vídeo' : 'Ligar'}
                disabled={!conv}
                onClick={(e) => {
                  e.stopPropagation()
                  if (conv) startCall(conv.id, g.otherId, g.first.video)
                }}
              >
                {g.first.video ? <IconVideo /> : <IconPhone />}
              </button>
            </div>
          )
        })}
        {list && groups.length === 0 && (
          <div className="empty-big">
            <IconPhone size={64} />
            <p>{filter === 'missed' ? 'Nenhuma ligação perdida' : 'Nenhuma ligação ainda'}</p>
            <span className="muted">Para ligar, abra uma conversa e toque em 📞 ou 🎥 no topo.</span>
          </div>
        )}
      </div>

      {menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenu(null)}
          items={[{ label: 'Limpar registro de ligações', danger: true, onClick: () => setConfirm(true) }]}
        />
      )}
      {confirm && (
        <Confirm
          text="Limpar todo o seu registro de ligações? A outra pessoa continua vendo o registro dela."
          confirmLabel="Limpar"
          danger
          onConfirm={clearAll}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  )
}
