import { useEffect, useMemo, useState } from 'react'
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
import { cx, ts } from './lib/utils'

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const theme = useChat((s) => s.settings.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    if (!isConfigured) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!isConfigured) return <SetupScreen />
  if (session === undefined) return <Splash />
  if (!session) return <Auth />
  return <Main session={session} />
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
      default:
        return <ChatList />
    }
  })()

  return (
    <div className={cx('app', s.activeId && 'has-chat', s.rightPanel && s.activeId && 'has-right')}>
      <NavRail />
      <aside className="sidebar">
        <div className="sidebar-content">{left}</div>
        <MobileTabs />
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
  // só aparece nas telas principais (some em "nova conversa", perfil, etc., como no original)
  if (!['chats', 'status', 'calls', 'announcements'].includes(s.leftPanel)) return null
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

