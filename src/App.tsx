import { useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isConfigured, supabase } from './lib/supabase'
import { startRealtime, stopRealtime, syncConvChannels } from './lib/realtime'
import { useChat } from './store/chat'
import { Auth, SetupScreen } from './components/Auth'
import { Avatar } from './components/common'
import { ChatList } from './components/sidebar/ChatList'
import { NewChatPanel, NewGroupPanel, ProfilePanel, SettingsPanel, StarredPanel } from './components/sidebar/Panels'
import { StatusComposer, StatusPanel, StatusViewer } from './components/status/Status'
import { ChatWindow, Welcome } from './components/chat/ChatWindow'
import { ForwardModal, Lightbox, RightPanel } from './components/info/InfoPanels'
import { StickerCreator } from './components/stickers/StickerCreator'
import { CallScreen } from './components/call/CallScreen'
import { AppLogo, IconChat, IconGear, IconStarOutline, IconStatus } from './lib/icons'
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
    return () => {
      stopRealtime()
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

  // título da aba com total de não lidas
  const totalUnread = Object.values(s.unread).reduce((a, b) => a + b, 0)
  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) Zap` : 'Zap'
  }, [totalUnread])

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
      default:
        return <ChatList />
    }
  })()

  return (
    <div className={cx('app', s.activeId && 'has-chat', s.rightPanel && s.activeId && 'has-right')}>
      <NavRail />
      <aside className="sidebar">{left}</aside>
      <main className="main">{s.activeId && s.conversations[s.activeId] ? <ChatWindow /> : <Welcome />}</main>
      {s.activeId && s.rightPanel && <RightPanel />}

      {s.forwarding && <ForwardModal />}
      {s.lightbox && <Lightbox />}
      {s.stickerCreator && <StickerCreator />}
      {s.statusViewer && <StatusViewer />}
      {s.statusComposer && <StatusComposer />}
      <CallScreen />
      {s.toast && <div className="toast">{s.toast}</div>}
    </div>
  )
}

function NavRail() {
  const s = useChat()
  const uid = s.session!.user.id
  const unreadChats = Object.entries(s.unread).filter(
    ([id, n]) => n > 0 && !s.members[id]?.find((m) => m.user_id === uid)?.archived,
  ).length
  const hasNewStatus = s.statuses.some(
    (st) => st.user_id !== uid && !s.viewedStatuses.has(st.id) && ts(st.expires_at) > Date.now(),
  )
  const isChats = ['chats', 'archived', 'newChat', 'newGroup'].includes(s.leftPanel)
  return (
    <nav className="nav-rail">
      <button className={cx('rail-btn', isChats && 'active')} title="Conversas" onClick={() => s.set({ leftPanel: 'chats' })}>
        <IconChat />
        {unreadChats > 0 && <span className="rail-badge">{unreadChats}</span>}
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

