import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isConfigured, supabase } from './lib/supabase'
import { startRealtime, stopRealtime, syncConvChannels } from './lib/realtime'
import { selectUnreadChats, useChat } from './store/chat'
import { Auth, SetupScreen } from './components/Auth'
import { Avatar } from './components/common'
import { ChatList } from './components/sidebar/ChatList'
import { NewChatPanel, NewGroupPanel, ProfilePanel, SettingsPanel, StarredPanel } from './components/sidebar/Panels'
import { StatusComposer, StatusPanel, StatusViewer } from './components/status/Status'
import { ChatWindow, Welcome } from './components/chat/ChatWindow'
import { ForwardModal, Lightbox, RightPanel } from './components/info/InfoPanels'
import { StickerCreator } from './components/stickers/StickerCreator'
import { CallScreen } from './components/call/CallScreen'
import { AnnouncementPopup, AnnouncementsPanel } from './components/announcements/Announcements'
import { CallsPanel } from './components/calls/CallsPanel'
import { selectMissedCalls, useCallLog } from './components/calls/callLog'
import { AppLogo, IconChat, IconGear, IconMegaphone, IconPhoneOutline, IconStarOutline, IconStatus } from './lib/icons'
import { isAdminEmail } from './lib/admin'
import { setFaviconCount } from './lib/favicon'
import { onNotificationOpen, onPushTokenChange, registerServiceWorker, syncPush } from './lib/push'
import { isNative, Zap } from './lib/native'
import { closeTopmost } from './lib/back'
import { SystemBars, SystemBarsStyle } from '@capacitor/core'
import { emergencyAccount, useMesh, type MeshContact } from './lib/mesh/mesh'
import { EmergencyPanel } from './components/emergency/Emergency'
import { answerWhenRinging, useCall } from './components/call/callStore'
import { cx, ts } from './lib/utils'

/** cor da barra de status do celular / barra do navegador, igual ao topo do app em cada tema */
const THEME_COLOR = { light: '#f7f8fa', dark: '#171a20' }

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const theme = useChat((s) => s.settings.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
    // ícones da barra de status (hora, bateria) escuros no tema claro e claros no tema escuro
    if (isNative()) SystemBars.setStyle({ style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {})
  }, [theme])

  // botão "voltar" do Android: fecha o que estiver aberto, um passo por vez; no fim, vai para segundo plano
  useEffect(() => {
    if (!isNative()) return
    const h = Zap.addListener('backButton', () => {
      if (closeTopmost() || stepBack()) return
      Zap.minimize().catch(() => {})
    })
    return () => void h.then((x) => x.remove())
  }, [])

  useEffect(() => {
    registerServiceWorker()
  }, [])

  useEffect(() => {
    if (!isConfigured) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  // app Android aberto SEM internet: vai direto para o modo emergência (se já foi preparado com internet antes)
  const [offlineStart] = useState(() => isNative() && !navigator.onLine && emergencyAccount())
  if (offlineStart) return <EmergencyStandalone uid={offlineStart} />

  if (!isConfigured) return <SetupScreen />
  if (session === undefined) return <Splash />
  if (!session) return <Auth />
  return <Main session={session} />
}

/**
 * Divisória entre a lista de conversas e a conversa (só no computador):
 * arrastar muda a largura, duplo clique volta ao padrão, setas do teclado ajustam de 16 em 16 px.
 * O CSS limita a largura a 260 px – 60% da janela, então ela se adapta quando a janela muda de tamanho.
 */
function SidebarResizer({ width, onChange }: { width: number | null; onChange: (w: number | null) => void }) {
  const drag = useRef<{ left: number } | null>(null)
  const current = (el: HTMLElement) => el.parentElement!.getBoundingClientRect().width
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionar lista de conversas"
      tabIndex={0}
      title="Arraste para mudar a largura · duplo clique volta ao padrão"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        drag.current = { left: e.currentTarget.parentElement!.getBoundingClientRect().left }
        e.currentTarget.setPointerCapture(e.pointerId)
        document.body.classList.add('resizing-sidebar')
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const max = window.innerWidth * 0.6
        onChange(Math.max(260, Math.min(max, e.clientX - drag.current.left)))
      }}
      onPointerUp={(e) => {
        drag.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
        document.body.classList.remove('resizing-sidebar')
      }}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const w = width ?? current(e.currentTarget)
        onChange(Math.max(260, Math.min(window.innerWidth * 0.6, w + (e.key === 'ArrowRight' ? 16 : -16))))
      }}
    />
  )
}

/** um passo para trás no app (como no WhatsApp); false = já está na tela inicial */
function stepBack(): boolean {
  const call = useCall.getState()
  if (call.phase !== 'idle' && call.phase !== 'ended') return false // em ligação: só minimiza, não desliga
  const s = useChat.getState()
  if (!s.session) return false
  if (s.lightbox) return s.set({ lightbox: null }), true
  if (s.statusViewer) return s.set({ statusViewer: null }), true
  if (s.statusComposer) return s.set({ statusComposer: null }), true
  if (s.stickerCreator) return s.set({ stickerCreator: null }), true
  if (s.forwarding) return s.set({ forwarding: null }), true
  if (s.selecting) return s.set({ selecting: null }), true
  if (s.editing) return s.set({ editing: null }), true
  if (s.activeId && s.rightPanel) return s.set({ rightPanel: null }), true
  if (s.activeId) return s.openChat(null), true
  if (s.leftPanel === 'newGroup') return s.set({ leftPanel: 'newChat' }), true
  if (s.leftPanel !== 'chats') return s.set({ leftPanel: 'chats' }), true
  return false
}

function EmergencyStandalone({ uid }: { uid: string }) {
  useEffect(() => {
    useMesh.getState().init(uid)
  }, [uid])
  return (
    <div className="emg-app">
      <EmergencyPanel standalone />
    </div>
  )
}

function Splash() {
  return (
    <div className="splash">
      <AppLogo size={72} />
      <div className="splash-bar">
        <div />
      </div>
      <div className="splash-title">Zap</div>
      <div className="muted small">🔒 Carregando suas conversas</div>
    </div>
  )
}

function Main({ session }: { session: Session }) {
  const s = useChat()
  const uid = session.user.id

  useEffect(() => {
    useChat.getState().init(session)
    startRealtime(uid)
    useCallLog.getState().start(uid)
    return () => {
      stopRealtime()
      useCallLog.getState().stop()
      useChat.getState().reset()
    }
    // só reinicia quando o usuário muda (não a cada refresh de token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid])

  useEffect(() => {
    useChat.getState().set({ session })
    supabase.realtime.setAuth(session.access_token)
  }, [session])

  const convIds = useMemo(() => Object.keys(s.conversations).sort().join(','), [s.conversations])
  useEffect(() => {
    syncConvChannels(convIds ? convIds.split(',') : [])
  }, [convIds])

  // título e ícone da aba: número de conversas com mensagens não lidas (não o total de mensagens)
  const unreadChats = useChat(selectUnreadChats)
  useEffect(() => {
    document.title = unreadChats ? `(${unreadChats}) Zap` : 'Zap'
    setFaviconCount(unreadChats)
  }, [unreadChats])
  useEffect(() => () => setFaviconCount(0), []) // ao sair da conta, volta o ícone normal

  // largura da lista de conversas no computador (arrastando a divisória); null = padrão
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem('zap-sidebar-w'))
      return v >= 200 && v <= 2000 ? v : null
    } catch {
      return null
    }
  })
  useEffect(() => {
    try {
      if (sidebarWidth) localStorage.setItem('zap-sidebar-w', String(Math.round(sidebarWidth)))
      else localStorage.removeItem('zap-sidebar-w')
    } catch {
      /* armazenamento indisponível */
    }
  }, [sidebarWidth])

  // notificações push deste aparelho (inscreve/atualiza ao entrar; respeita a configuração)
  const notificationsOn = s.settings.notifications
  useEffect(() => {
    syncPush(notificationsOn)
  }, [uid, notificationsOn])

  // tocou numa notificação: abre a conversa (app fechado → vem na URL ?c=; app em segundo plano → mensagem do SW)
  const loaded = s.loaded
  useEffect(() => {
    if (!loaded) return
    const open = (convId?: string | null) => {
      if (convId && useChat.getState().conversations[convId]) {
        useChat.getState().set({ leftPanel: 'chats' })
        useChat.getState().openChat(convId)
      }
    }
    const params = new URLSearchParams(location.search)
    if (params.has('c')) {
      open(params.get('c'))
      history.replaceState(null, '', location.pathname)
    }
    return onNotificationOpen((d) => {
      if (d.mesh) {
        useChat.getState().set({ leftPanel: 'emergency' })
        return
      }
      open(d.conversationId)
      if (d.callId && d.action === 'answer') answerWhenRinging(d.callId)
    })
  }, [loaded])

  // o Android trocou o token do Firebase: registra o novo
  useEffect(() => onPushTokenChange(() => syncPush(useChat.getState().settings.notifications)), [])

  // modo emergência (app Android): prepara chaves e guarda os contatos para funcionar sem internet
  useEffect(() => {
    if (!loaded || !isNative()) return
    const st = useChat.getState()
    const contacts = new Map<string, MeshContact>()
    for (const list of Object.values(st.members))
      for (const m of list) {
        const p = st.profiles[m.user_id]
        if (p && p.id !== uid) contacts.set(p.id, { id: p.id, name: p.full_name || 'Contato', avatar: p.avatar_url })
      }
    useMesh.getState().init(uid, { name: st.me?.full_name, contacts: [...contacts.values()] })
  }, [loaded, uid, convIds])

  if (!s.loaded || !s.me) return <Splash />

  const left = (() => {
    switch (s.leftPanel) {
      case 'newChat':
        return <NewChatPanel />
      case 'newGroup':
        return <NewGroupPanel />
      case 'profile':
        return <ProfilePanel />
      case 'settings':
        return <SettingsPanel />
      case 'starred':
        return <StarredPanel />
      case 'archived':
        return <ChatList archived />
      case 'status':
        return <StatusPanel />
      case 'announcements':
        return isAdminEmail(session.user.email) ? <AnnouncementsPanel /> : <ChatList />
      case 'calls':
        return <CallsPanel />
      case 'emergency':
        return <EmergencyPanel onBack={() => s.set({ leftPanel: 'chats' })} />
      default:
        return <ChatList />
    }
  })()

  return (
    <div
      className={cx('app', s.activeId && 'has-chat', s.rightPanel && s.activeId && 'has-right')}
      style={sidebarWidth ? ({ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties) : undefined}
    >
      <NavRail />
      <aside className="sidebar">
        <div className="sidebar-content">{left}</div>
        <MobileTabs />
        <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} />
      </aside>
      <main className="main">{s.activeId && s.conversations[s.activeId] ? <ChatWindow /> : <Welcome />}</main>
      {s.activeId && s.rightPanel && <RightPanel />}

      {s.forwarding && <ForwardModal />}
      {s.lightbox && <Lightbox />}
      {s.stickerCreator && <StickerCreator />}
      {s.statusViewer && <StatusViewer />}
      {s.statusComposer && <StatusComposer />}
      <CallScreen />
      <AnnouncementPopup />
      {s.toast && <div className="toast">{s.toast}</div>}
    </div>
  )
}

/** Contadores compartilhados pela barra lateral (desktop) e pela barra inferior (celular) */
function useTabBadges() {
  const s = useChat()
  const uid = s.session!.user.id
  const unreadChats = useChat(selectUnreadChats)
  const missedCalls = useCallLog(selectMissedCalls)
  const hasNewStatus = s.statuses.some(
    (st) => st.user_id !== uid && !s.viewedStatuses.has(st.id) && ts(st.expires_at) > Date.now(),
  )
  return { unreadChats, missedCalls, hasNewStatus }
}

const CHAT_PANELS = ['chats', 'archived', 'newChat', 'newGroup']

/** Barra inferior do celular, como no app: Conversas · Atualizações · Ligações (+ Anúncios para o admin) */
function MobileTabs() {
  const s = useChat()
  const { unreadChats, missedCalls, hasNewStatus } = useTabBadges()
  const admin = isAdminEmail(s.session?.user.email)
  const meshUnread = useMesh((m) => Object.values(m.unread).reduce((a, b) => a + b, 0))
  // só aparece nas telas principais (some em "nova conversa", perfil, etc., como no original)
  if (!['chats', 'status', 'calls', 'announcements', 'emergency'].includes(s.leftPanel)) return null
  const tab = (key: typeof s.leftPanel, label: string, icon: React.ReactNode, badge?: React.ReactNode) => (
    <button
      className={cx('bottom-tab', s.leftPanel === key && 'active')}
      onClick={() => s.set({ leftPanel: key })}
      aria-label={label}
    >
      <span className="bottom-tab-icon">
        {icon}
        {badge}
      </span>
      <span className="bottom-tab-label">{label}</span>
    </button>
  )
  return (
    <nav className="bottom-nav">
      {tab('chats', 'Conversas', <IconChat />, unreadChats > 0 && <span className="rail-badge">{unreadChats}</span>)}
      {tab('status', 'Atualizações', <IconStatus />, hasNewStatus && <span className="rail-dot" />)}
      {tab('calls', 'Ligações', <IconPhoneOutline />, missedCalls > 0 && <span className="rail-badge red">{missedCalls}</span>)}
      {admin && tab('announcements', 'Anúncios', <IconMegaphone />)}
      {isNative() &&
        tab('emergency', 'Emergência', <span className="sos-icon">SOS</span>, meshUnread > 0 && <span className="rail-badge red">{meshUnread}</span>)}
    </nav>
  )
}

function NavRail() {
  const s = useChat()
  const { unreadChats, missedCalls, hasNewStatus } = useTabBadges()
  const isChats = CHAT_PANELS.includes(s.leftPanel)
  return (
    <nav className="nav-rail">
      <button className={cx('rail-btn', isChats && 'active')} title="Conversas" onClick={() => s.set({ leftPanel: 'chats' })}>
        <IconChat />
        {unreadChats > 0 && <span className="rail-badge">{unreadChats}</span>}
      </button>
      {/* Ligações logo abaixo de Conversas */}
      <button
        className={cx('rail-btn', s.leftPanel === 'calls' && 'active')}
        title="Ligações"
        onClick={() => s.set({ leftPanel: 'calls' })}
      >
        <IconPhoneOutline />
        {missedCalls > 0 && <span className="rail-badge red">{missedCalls}</span>}
      </button>
      <button
        className={cx('rail-btn', s.leftPanel === 'status' && 'active')}
        title="Status"
        onClick={() => s.set({ leftPanel: 'status' })}
      >
        <IconStatus />
        {hasNewStatus && <span className="rail-dot" />}
      </button>
      <button
        className={cx('rail-btn', s.leftPanel === 'starred' && 'active')}
        title="Mensagens favoritas"
        onClick={() => s.set({ leftPanel: 'starred' })}
      >
        <IconStarOutline />
      </button>
      {isAdminEmail(s.session?.user.email) && (
        <button
          className={cx('rail-btn', s.leftPanel === 'announcements' && 'active')}
          title="Anúncios"
          onClick={() => s.set({ leftPanel: 'announcements' })}
        >
          <IconMegaphone />
        </button>
      )}
      {isNative() && (
        <button
          className={cx('rail-btn', s.leftPanel === 'emergency' && 'active')}
          title="Modo emergência (sem internet)"
          onClick={() => s.set({ leftPanel: 'emergency' })}
        >
          <span className="sos-icon">SOS</span>
        </button>
      )}
      <div className="grow" />
      <button
        className={cx('rail-btn', s.leftPanel === 'settings' && 'active')}
        title="Configurações"
        onClick={() => s.set({ leftPanel: 'settings' })}
      >
        <IconGear />
      </button>
      <button className="rail-avatar" title="Perfil" onClick={() => s.set({ leftPanel: 'profile' })}>
        <Avatar url={s.me?.avatar_url} size={30} />
      </button>
    </nav>
  )
}

