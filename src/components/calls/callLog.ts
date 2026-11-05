import { create } from 'zustand'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { CallLog } from '../../lib/types'
import { ts } from '../../lib/utils'

type State = {
  uid: string | null
  list: CallLog[] | null
  hidden: Set<string>
  /** momento em que o usuário abriu a aba de ligações pela última vez (para o contador de perdidas) */
  lastSeen: number
  start: (uid: string) => void
  stop: () => void
  load: () => Promise<void>
  markSeen: () => void
  clearAll: () => Promise<void>
}

let channel: RealtimeChannel | null = null
let reloadTimer: number | undefined
const seenKey = (uid: string) => `zap-calls-seen-${uid}`

export const useCallLog = create<State>((set, get) => ({
  uid: null,
  list: null,
  hidden: new Set(),
  lastSeen: 0,

  start: (uid) => {
    get().stop()
    let lastSeen = Date.now()
    try {
      lastSeen = Number(localStorage.getItem(seenKey(uid))) || Date.now()
    } catch {
      /* armazenamento indisponível */
    }
    set({ uid, lastSeen, list: null })
    get().load()
    channel = supabase
      .channel('calls-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calls' }, () => {
        window.clearTimeout(reloadTimer)
        reloadTimer = window.setTimeout(() => get().load(), 400)
      })
      .subscribe()
  },

  stop: () => {
    if (channel) supabase.removeChannel(channel)
    channel = null
    set({ uid: null, list: null, hidden: new Set() })
  },

  load: async () => {
    const uid = get().uid
    if (!uid) return
    const [{ data, error }, { data: hid }] = await Promise.all([
      supabase.from('calls').select('*').order('started_at', { ascending: false }).limit(200),
      supabase.from('call_hidden').select('call_id').eq('user_id', uid),
    ])
    if (error) {
      // tabela ainda não criada (calls.sql não foi rodado)
      set({ list: [] })
      return
    }
    set({ list: (data ?? []) as CallLog[], hidden: new Set((hid ?? []).map((h) => h.call_id)) })
  },

  markSeen: () => {
    const uid = get().uid
    const now = Date.now()
    set({ lastSeen: now })
    try {
      if (uid) localStorage.setItem(seenKey(uid), String(now))
    } catch {
      /* armazenamento indisponível */
    }
  },

  clearAll: async () => {
    const { uid, list } = get()
    if (!uid || !list?.length) return
    const ids = list.map((c) => c.id)
    set({ hidden: new Set([...get().hidden, ...ids]) })
    await supabase.from('call_hidden').upsert(ids.map((call_id) => ({ call_id, user_id: uid })))
  },
}))

/** Ligações perdidas recebidas desde a última vez que a aba foi aberta */
export function selectMissedCalls(s: State) {
  if (!s.list || !s.uid) return 0
  let n = 0
  for (const c of s.list) {
    if (c.callee_id === s.uid && c.status === 'missed' && !s.hidden.has(c.id) && ts(c.started_at) > s.lastSeen) n++
  }
  return n
}
