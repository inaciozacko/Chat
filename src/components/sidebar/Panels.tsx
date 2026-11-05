import { useEffect, useMemo, useState } from 'react'
import { useChat } from '../../store/chat'
import { supabase } from '../../lib/supabase'
import type { Message, Profile } from '../../lib/types'
import {
  IconArrowRight,
  IconBell,
  IconCamera,
  IconCheck,
  IconClose,
  IconGroup,
  IconKeyboard,
  IconLogout,
  IconMoon,
  IconSearch,
  IconSmile,
  IconStar,
  IconUser,
} from '../../lib/icons'
import { Avatar, EditableField, PanelHeader, Spinner, useFilePicker } from '../common'
import { conversationTitle, cx, formatListDate, messagePreview } from '../../lib/utils'

function useProfileSearch(q: string) {
  const uid = useChat((s) => s.session!.user.id)
  const [results, setResults] = useState<Profile[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const t = setTimeout(async () => {
      let query = supabase.from('profiles').select('*').neq('id', uid).order('full_name').limit(60)
      const term = q.trim().replace(/[%,()]/g, '')
      if (term) query = query.or(`full_name.ilike.%${term}%,username.ilike.%${term}%,phone.ilike.%${term}%`)
      const { data } = await query
      if (!cancelled) {
        setResults((data ?? []) as Profile[])
        setLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q, uid])
  return { results, loading }
}

function ContactRow({ p, onClick, selected }: { p: Profile; onClick: () => void; selected?: boolean }) {
  return (
    <div className="chat-item contact" onClick={onClick}>
      <div className="avatar-wrap">
        <Avatar url={p.avatar_url} />
        {selected && (
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
  )
}

export function NewChatPanel() {
  const s = useChat()
  const [q, setQ] = useState('')
  const { results, loading } = useProfileSearch(q)
  const me = s.me!
  return (
    <div className="panel">
      <PanelHeader title="Nova conversa" onBack={() => s.set({ leftPanel: 'chats' })} />
      <div className="search-bar">
        <div className="search-input">
          <IconSearch size={20} />
          <input autoFocus placeholder="Pesquisar nome, usuário ou número" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="chat-list scroll">
        <button className="action-row" onClick={() => s.set({ leftPanel: 'newGroup' })}>
          <span className="action-icon">
            <IconGroup />
          </span>
          Novo grupo
        </button>
        <div className="section-label">Você</div>
        <div className="chat-item contact" onClick={() => s.startDirect(me.id)}>
          <Avatar url={me.avatar_url} />
          <div className="chat-item-body">
            <div className="chat-item-top">
              <span className="chat-item-title">{me.full_name} (você)</span>
            </div>
            <div className="chat-item-bottom">
              <span className="chat-item-preview">Envie uma mensagem para si mesmo</span>
            </div>
          </div>
        </div>
        <div className="section-label">Contatos no Zap</div>
        {loading && results.length === 0 && (
          <div className="center-pad">
            <Spinner />
          </div>
        )}
        {results.map((p) => (
          <ContactRow key={p.id} p={p} onClick={() => s.startDirect(p.id)} />
        ))}
        {!loading && results.length === 0 && <div className="empty-list">Nenhum resultado para "{q}"</div>}
      </div>
    </div>
  )
}

export function NewGroupPanel() {
  const s = useChat()
  const [step, setStep] = useState<1 | 2>(1)
  const [q, setQ] = useState('')
  const { results } = useProfileSearch(q)
  const [selected, setSelected] = useState<Profile[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = useFilePicker('image/*', (f) => setAvatar(f[0]))
  const preview = useMemo(() => (avatar ? URL.createObjectURL(avatar) : null), [avatar])

  const toggle = (p: Profile) =>
    setSelected((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : [...cur, p]))

  if (step === 1)
    return (
      <div className="panel">
        <PanelHeader title="Adicionar participantes" onBack={() => s.set({ leftPanel: 'chats' })} />
        <div className="selected-chips">
          {selected.map((p) => (
            <span key={p.id} className="member-chip">
              <Avatar url={p.avatar_url} size={26} />
              {p.full_name}
              <button onClick={() => toggle(p)} aria-label="Remover">
                <IconClose size={14} />
              </button>
            </span>
          ))}
          <input
            className="chip-input"
            autoFocus
            placeholder="Pesquisar nome ou número"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="chat-list scroll">
          {results.map((p) => (
            <ContactRow key={p.id} p={p} selected={selected.some((x) => x.id === p.id)} onClick={() => toggle(p)} />
          ))}
        </div>
        {selected.length > 0 && (
          <div className="fab-bar">
            <button className="fab" onClick={() => setStep(2)} aria-label="Avançar">
              <IconArrowRight />
            </button>
          </div>
        )}
      </div>
    )

  return (
    <div className="panel">
      <PanelHeader title="Novo grupo" onBack={() => setStep(1)} />
      <div className="scroll group-setup">
        <button className="avatar-picker" onClick={pick}>
          {preview ? <img src={preview} alt="" /> : <IconCamera size={36} />}
          <span>{preview ? 'MUDAR' : 'ADICIONAR IMAGEM DO GRUPO'}</span>
        </button>
        <input
          className="underline-input"
          autoFocus
          maxLength={100}
          placeholder="Nome do grupo"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="underline-input"
          maxLength={512}
          placeholder="Descrição do grupo (opcional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="section-label">Participantes: {selected.length}</div>
        <div className="selected-chips static">
          {selected.map((p) => (
            <span key={p.id} className="member-chip">
              <Avatar url={p.avatar_url} size={26} />
              {p.full_name}
            </span>
          ))}
        </div>
      </div>
      {name.trim() && (
        <div className="fab-bar">
          <button
            className="fab"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await s.createGroup(
                name.trim(),
                selected.map((p) => p.id),
                avatar,
                description.trim() || undefined,
              )
              setBusy(false)
            }}
            aria-label="Criar grupo"
          >
            {busy ? <Spinner size={22} /> : <IconCheck size={26} />}
          </button>
        </div>
      )}
    </div>
  )
}

export function ProfilePanel() {
  const s = useChat()
  const me = s.me!
  const [uploading, setUploading] = useState(false)
  const pick = useFilePicker('image/*', async ([file]) => {
    setUploading(true)
    try {
      const url = await s.uploadAvatar(file)
      await s.updateProfile({ avatar_url: url })
    } catch (e) {
      s.showToast((e as Error).message)
    }
    setUploading(false)
  })
  return (
    <div className="panel">
      <PanelHeader title="Perfil" onBack={() => s.set({ leftPanel: 'chats' })} />
      <div className="scroll profile-panel">
        <div className="profile-avatar" onClick={pick}>
          <Avatar url={me.avatar_url} size={200} />
          <div className="profile-avatar-overlay">
            {uploading ? <Spinner /> : <IconCamera size={28} />}
            <span>{uploading ? 'ENVIANDO...' : 'MUDAR FOTO DO PERFIL'}</span>
          </div>
        </div>
        {me.avatar_url && (
          <button className="link-btn danger center" onClick={() => s.updateProfile({ avatar_url: null })}>
            Remover foto
          </button>
        )}
        <EditableField label="Seu nome" value={me.full_name} maxLength={25} onSave={(v) => s.updateProfile({ full_name: v })} />
        <p className="hint">
          Esse não é seu nome de usuário ou PIN. Esse nome será visível para seus contatos.
        </p>
        <EditableField label="Recado" value={me.about} maxLength={139} onSave={(v) => s.updateProfile({ about: v })} />
        <EditableField
          label="Nome de usuário"
          value={me.username ?? ''}
          maxLength={30}
          onSave={(v) => s.updateProfile({ username: v.toLowerCase() || null })}
        />
        <EditableField label="Telefone" value={me.phone ?? ''} maxLength={20} onSave={(v) => s.updateProfile({ phone: v || null })} />
      </div>
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={cx('toggle', on && 'on')} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span />
    </button>
  )
}

export function SettingsPanel() {
  const s = useChat()
  const me = s.me!
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied')
  return (
    <div className="panel">
      <PanelHeader title="Configurações" onBack={() => s.set({ leftPanel: 'chats' })} />
      <div className="scroll">
        <div className="settings-me" onClick={() => s.set({ leftPanel: 'profile' })}>
          <Avatar url={me.avatar_url} size={82} />
          <div>
            <div className="settings-name">{me.full_name}</div>
            <div className="muted">{me.about}</div>
          </div>
        </div>
        <div className="settings-row">
          <IconMoon />
          <div className="settings-text">
            <div>Tema escuro</div>
            <div className="muted small">Aparência do aplicativo</div>
          </div>
          <Toggle on={s.settings.theme === 'dark'} onChange={(v) => s.updateSettings({ theme: v ? 'dark' : 'light' })} />
        </div>
        <div className="settings-row">
          <IconBell />
          <div className="settings-text">
            <div>Notificações na área de trabalho</div>
            <div className="muted small">
              {perm === 'granted' ? 'Ativadas no navegador' : perm === 'denied' ? 'Bloqueadas no navegador' : 'Clique para permitir'}
            </div>
          </div>
          <Toggle
            on={s.settings.notifications && perm === 'granted'}
            onChange={async (v) => {
              if (v && perm !== 'granted' && 'Notification' in window) {
                const p = await Notification.requestPermission()
                setPerm(p)
              }
              s.updateSettings({ notifications: v })
            }}
          />
        </div>
        <div className="settings-row">
          <IconBell />
          <div className="settings-text">
            <div>Sons</div>
            <div className="muted small">Tocar som ao receber mensagens</div>
          </div>
          <Toggle on={s.settings.sounds} onChange={(v) => s.updateSettings({ sounds: v })} />
        </div>
        <div className="settings-row">
          <IconSmile />
          <div className="settings-text">
            <div>Emojis animados</div>
            <div className="muted small">Emojis que se mexem nas mensagens e reações · animações Noto Emoji (Google), CC BY 4.0</div>
          </div>
          <Toggle on={s.settings.animatedEmoji !== false} onChange={(v) => s.updateSettings({ animatedEmoji: v })} />
        </div>
        <div className="settings-row">
          <IconKeyboard />
          <div className="settings-text">
            <div>Enter para enviar</div>
            <div className="muted small">Shift+Enter cria nova linha</div>
          </div>
          <Toggle on={s.settings.enterToSend} onChange={(v) => s.updateSettings({ enterToSend: v })} />
        </div>
        <div className="settings-row column">
          <div className="settings-text">
            <div>Papel de parede</div>
          </div>
          <div className="wallpapers">
            {['default', '#d1e4d0', '#cfe0ec', '#f3dcd4', '#e6dcf3', '#ece5dd', '#1f2c33', '#0b141a'].map((w) => (
              <button
                key={w}
                className={cx('wallpaper-swatch', s.settings.wallpaper === w && 'active')}
                style={{ background: w === 'default' ? undefined : w }}
                data-default={w === 'default' || undefined}
                onClick={() => s.updateSettings({ wallpaper: w })}
                aria-label={w}
              />
            ))}
          </div>
        </div>
        <div className="settings-row" onClick={() => s.set({ leftPanel: 'starred' })}>
          <IconStar />
          <div className="settings-text">
            <div>Mensagens favoritas</div>
          </div>
        </div>
        <div className="settings-row" onClick={() => s.set({ leftPanel: 'profile' })}>
          <IconUser />
          <div className="settings-text">
            <div>Perfil</div>
            <div className="muted small">Nome, foto, recado</div>
          </div>
        </div>
        <div className="settings-row danger" onClick={() => supabase.auth.signOut()}>
          <IconLogout />
          <div className="settings-text">
            <div>Desconectar</div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function StarredPanel({ inRight = false }: { inRight?: boolean }) {
  const s = useChat()
  const uid = s.session!.user.id
  const [list, setList] = useState<Message[] | null>(null)
  useEffect(() => {
    const ids = [...s.starred]
    if (!ids.length) return setList([])
    supabase
      .from('messages')
      .select('*')
      .in('id', ids)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        let msgs = (data ?? []) as Message[]
        if (inRight && s.activeId) msgs = msgs.filter((m) => m.conversation_id === s.activeId)
        setList(msgs)
      })
  }, [s.starred, inRight, s.activeId])

  return (
    <div className="panel">
      <PanelHeader
        title="Mensagens favoritas"
        onBack={() => (inRight ? s.set({ rightPanel: 'info' }) : s.set({ leftPanel: 'chats' }))}
      />
      <div className="scroll starred-list">
        {list === null && (
          <div className="center-pad">
            <Spinner />
          </div>
        )}
        {list?.length === 0 && (
          <div className="empty-big">
            <IconStar size={80} />
            <p>Nenhuma mensagem favorita</p>
            <span className="muted">Toque e segure em qualquer mensagem para marcá-la como favorita.</span>
          </div>
        )}
        {list?.map((m) => {
          const conv = s.conversations[m.conversation_id]
          const sender = m.sender_id === uid ? 'Você' : s.profiles[m.sender_id ?? '']?.full_name ?? ''
          return (
            <div
              key={m.id}
              className="starred-item"
              onClick={async () => {
                if (!conv) return
                if (!inRight) s.set({ leftPanel: 'chats' })
                await s.openChat(m.conversation_id)
                s.set({ jumpTo: m.id })
              }}
            >
              <div className="starred-head">
                <Avatar url={s.profiles[m.sender_id ?? '']?.avatar_url} size={26} />
                <span className="starred-names">
                  {sender}
                  {conv && <> ▸ {conversationTitle(conv, s.members[conv.id], s.profiles, uid)}</>}
                </span>
                <span className="muted small">{formatListDate(m.created_at)}</span>
              </div>
              <div className="starred-body">
                {m.type === 'image' && m.media_url && <img src={m.media_url} alt="" />}
                {m.type === 'sticker' && m.media_url && <img className="sticker-thumb" src={m.media_url} alt="" />}
                <span>{messagePreview(m)}</span>
                <IconStar size={14} className="muted" />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
