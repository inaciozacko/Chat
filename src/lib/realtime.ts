import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { useChat } from '../store/chat'
import type { Conversation, Member, Message, Profile, Reaction, Status } from './types'

/**
 * - `db`: postgres_changes de todas as tabelas (RLS filtra o que o usuário pode ver)
 * - `online`: presence global (quem está online)
 * - `conv:<id>`: canal privado por conversa → digitando/gravando + sinalização de chamadas
 */

export type CallSignal = {
  kind: 'offer' | 'answer' | 'ice' | 'end' | 'reject' | 'busy' | 'ringing'
  callId: string
  from: string
  to: string
  conversationId: string
  video?: boolean
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

let dbChannel: RealtimeChannel | null = null
let presenceChannel: RealtimeChannel | null = null
const convChannels = new Map<string, RealtimeChannel>()
const callListeners = new Set<(s: CallSignal) => void>()
let pruneTimer: number | undefined
let myId = ''

export function startRealtime(uid: string) {
  stopRealtime()
  myId = uid
  const st = useChat.getState

  dbChannel = supabase
    .channel('db')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (p) => {
      if (p.eventType === 'DELETE') return
      st().onMessage(p.new as Message, p.eventType)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, (p) => {
      st().onReaction((p.eventType === 'DELETE' ? p.old : p.new) as Reaction, p.eventType)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members' }, (p) => {
      st().onMember((p.eventType === 'DELETE' ? p.old : p.new) as Member, p.eventType)
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (p) => {
      st().onConversation(p.new as Conversation)
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (p) => {
      st().onProfile(p.new as Profile)
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'statuses' }, (p) => {
      st().onStatus(p.new as Status)
    })
    .subscribe((status) => {
      // ao reconectar, recarrega a lista para não perder nada
      if (status === 'SUBSCRIBED' && st().loaded) st().loadChats()
    })

  presenceChannel = supabase.channel('online', { config: { presence: { key: uid } } })
  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      st().setOnline(Object.keys(presenceChannel!.presenceState()))
    })
    .on('presence', { event: 'leave' }, ({ key }) => {
      const p = st().profiles[key]
      if (p) st().onProfile({ ...p, last_seen: new Date().toISOString() })
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await trackPresence()
    })

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)

  pruneTimer = window.setInterval(() => {
    const { typing, setTyping } = st()
    const now = Date.now()
    for (const [conv, users] of Object.entries(typing)) {
      for (const [u, t] of Object.entries(users)) if (now - t.at > 4500) setTyping(conv, u, null)
    }
  }, 1000)
}

async function trackPresence() {
  if (document.visibilityState === 'visible') await presenceChannel?.track({ at: Date.now() })
}

function onVisibility() {
  if (document.visibilityState === 'visible') {
    trackPresence()
    const { activeId, markRead } = useChat.getState()
    if (activeId) markRead(activeId)
  } else {
    presenceChannel?.untrack()
    touchLastSeen()
  }
}

function onPageHide() {
  touchLastSeen()
}

function touchLastSeen() {
  if (myId) supabase.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', myId).then()
}

export function stopRealtime() {
  dbChannel && supabase.removeChannel(dbChannel)
  presenceChannel && supabase.removeChannel(presenceChannel)
  convChannels.forEach((c) => supabase.removeChannel(c))
  convChannels.clear()
  dbChannel = presenceChannel = null
  window.clearInterval(pruneTimer)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('pagehide', onPageHide)
}

/** Mantém um canal privado aberto para cada conversa do usuário */
export function syncConvChannels(ids: string[]) {
  const wanted = new Set(ids)
  for (const [id, ch] of convChannels) {
    if (!wanted.has(id)) {
      supabase.removeChannel(ch)
      convChannels.delete(id)
    }
  }
  for (const id of ids) {
    if (convChannels.has(id)) continue
    const ch = supabase.channel(`conv:${id}`, { config: { private: true, broadcast: { self: false } } })
    ch.on('broadcast', { event: 'typing' }, ({ payload }) => {
      const { user_id, kind } = payload as { user_id: string; kind: 'typing' | 'recording' | null }
      if (user_id !== myId) useChat.getState().setTyping(id, user_id, kind)
    })
      .on('broadcast', { event: 'call' }, ({ payload }) => {
        const sig = payload as CallSignal
        if (sig.to === myId || sig.to === '*') callListeners.forEach((l) => l(sig))
      })
      .subscribe()
    convChannels.set(id, ch)
  }
}

const lastTypingSent: Record<string, number> = {}
export function sendTyping(convId: string, kind: 'typing' | 'recording' | null) {
  const ch = convChannels.get(convId)
  if (!ch) return
  const now = Date.now()
  if (kind && now - (lastTypingSent[convId] ?? 0) < 2000) return
  lastTypingSent[convId] = kind ? now : 0
  ch.send({ type: 'broadcast', event: 'typing', payload: { user_id: myId, kind } })
}

export function sendCallSignal(sig: CallSignal) {
  const ch = convChannels.get(sig.conversationId)
  if (!ch) return
  ch.send({ type: 'broadcast', event: 'call', payload: sig })
}

export function onCallSignal(listener: (s: CallSignal) => void) {
  callListeners.add(listener)
  return () => {
    callListeners.delete(listener)
  }
}
