import { create } from 'zustand'
import { supabase } from '../supabase'
import { isNative, Zap, type MeshStatus } from '../native'
import { sendPush, setNativeSession } from '../push'
import { ack, createIdentity, open, parseEnvelope, seal, type DeviceIdentity, type DeviceKeys, type Envelope, type Plain } from './crypto'

/**
 * Modo emergência: mensagens que funcionam SEM internet.
 *
 * Caminhos de entrega (todos ao mesmo tempo, o primeiro que chegar vale):
 *   • celular a celular por Bluetooth/Wi-Fi Direct (MeshService.java), pulando de aparelho em aparelho;
 *   • "leva e entrega": quem carrega a mensagem entrega quando encontrar o destinatário ou outro Zap;
 *   • caixa postal na internet (mesh_envelopes): qualquer celular que carregue a mensagem e encontre
 *     internet a deposita; o destinatário a recebe assim que tiver internet (com notificação).
 * Tudo vai criptografado (crypto.ts); a confirmação de entrega volta pelo mesmo caminho.
 */

export type MeshContact = { id: string; name: string; avatar?: string | null }

export type MeshMsg = {
  id: string
  peer: string
  dir: 'in' | 'out'
  text: string
  loc?: Plain['loc']
  ts: number
  /** out: sent = guardada/espalhando · uploaded = chegou à caixa postal na internet · delivered = confirmada */
  status?: 'sent' | 'uploaded' | 'delivered'
  /** in: assinatura conferida */
  verified?: boolean
  unreadable?: boolean
}

type Cache = { name: string; contacts: Record<string, MeshContact>; keys: Record<string, DeviceKeys[]> }

type State = {
  uid: string | null
  name: string
  identity: DeviceIdentity | null
  contacts: Record<string, MeshContact>
  keys: Record<string, DeviceKeys[]>
  msgs: MeshMsg[]
  unread: Record<string, number>
  status: MeshStatus
  online: boolean
  syncing: boolean
  error: string | null
  init: (uid: string, extra?: { name?: string; contacts?: MeshContact[] }) => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  send: (peers: string[], plain: Plain) => Promise<{ ok: number; missing: string[] }>
  markRead: (peer: string) => void
  sync: () => Promise<void>
}

const LAST_UID = 'zap-mesh-last-uid'
const idKey = (uid: string) => `zap-mesh-id-${uid}`
const cacheKey = (uid: string) => `zap-mesh-cache-${uid}`
const msgsKey = (uid: string) => `zap-mesh-msgs-${uid}`
const unreadKey = (uid: string) => `zap-mesh-unread-${uid}`

function read<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key)
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* armazenamento cheio/indisponível */
  }
}

/** existe uma conta preparada para o modo emergência neste aparelho? (para abrir sem internet) */
export function emergencyAccount(): string | null {
  try {
    const uid = localStorage.getItem(LAST_UID)
    return uid && localStorage.getItem(idKey(uid)) ? uid : null
  } catch {
    return null
  }
}

let listening = false
let syncTimer: number | undefined
let inboxBusy = false

export const useMesh = create<State>((set, get) => {
  const saveMsgs = () => {
    const { uid, msgs, unread } = get()
    if (!uid) return
    write(msgsKey(uid), msgs.slice(-1500))
    write(unreadKey(uid), unread)
  }

  const upsertMsg = (m: MeshMsg) => {
    set((s) => {
      const i = s.msgs.findIndex((x) => x.id === m.id)
      const msgs = i >= 0 ? s.msgs.map((x, j) => (j === i ? { ...x, ...m } : x)) : [...s.msgs, m].sort((a, b) => a.ts - b.ts)
      return { msgs }
    })
    saveMsgs()
  }

  const setStatus = (id: string, status: MeshMsg['status']) => {
    const rank = { sent: 0, uploaded: 1, delivered: 2 }
    const m = get().msgs.find((x) => x.id === id)
    if (!m || m.dir !== 'out' || rank[status ?? 'sent'] <= rank[m.status ?? 'sent']) return
    upsertMsg({ ...m, status })
  }

  /** envelopes que chegaram (pelo rádio ou pela internet) endereçados a mim */
  const process = async (raw: string[]) => {
    const { uid, identity } = get()
    if (!uid || !identity) return
    for (const s of raw) {
      const env = parseEnvelope(s)
      if (!env || env.to !== uid) continue
      if (env.t === 'a') {
        setStatus(env.b, 'delivered')
        continue
      }
      if (get().msgs.some((m) => m.id === env.id)) {
        await sendAck(env) // a confirmação anterior pode ter se perdido
        continue
      }
      try {
        const { plain, verified } = await open(env, identity, get().keys[env.from] ?? [])
        if (plain.name && !get().contacts[env.from]) {
          set((st) => ({ contacts: { ...st.contacts, [env.from]: { id: env.from, name: plain.name! } } }))
        }
        upsertMsg({ id: env.id, peer: env.from, dir: 'in', text: plain.text, loc: plain.loc, ts: env.ts, verified })
      } catch {
        upsertMsg({ id: env.id, peer: env.from, dir: 'in', text: '', ts: env.ts, unreadable: true })
      }
      set((st) => ({ unread: { ...st.unread, [env.from]: (st.unread[env.from] ?? 0) + 1 } }))
      saveMsgs()
      await sendAck(env)
    }
  }

  const sendAck = async (env: Envelope) => {
    const a = JSON.stringify(ack(get().uid!, env))
    if (isNative()) await Zap.meshSend({ envelope: a }).catch(() => {})
    if (get().online) await deposit([a])
  }

  /** deposita envelopes na caixa postal da internet (e avisa o destinatário) */
  const deposit = async (raw: string[]) => {
    const rows = raw
      .map((s) => parseEnvelope(s))
      .filter((e): e is Envelope => !!e)
      .map((e) => ({ id: e.id, to_user: e.to, from_user: e.from, kind: e.t, body: JSON.stringify(e) }))
    if (!rows.length) return [] as string[]
    const { error } = await supabase.from('mesh_envelopes').upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
    if (error) {
      console.warn('caixa postal indisponível:', error.message)
      return []
    }
    for (const r of rows) {
      if (r.kind === 'm') sendPush({ type: 'mesh', envelope_id: r.id })
      if (r.from_user === get().uid) setStatus(r.id, 'uploaded')
    }
    return rows.map((r) => r.id)
  }

  const pullNativeInbox = async () => {
    if (!isNative() || inboxBusy) return
    inboxBusy = true
    try {
      const { envelopes } = await Zap.meshInbox()
      if (envelopes.length) {
        await process(envelopes)
        await Zap.meshConsume({ ids: envelopes.map((e) => parseEnvelope(e)?.id).filter(Boolean) as string[] })
      }
    } finally {
      inboxBusy = false
    }
  }

  const listen = () => {
    if (listening) return
    listening = true
    const refresh = () => {
      set({ online: navigator.onLine })
      window.clearTimeout(syncTimer)
      syncTimer = window.setTimeout(() => get().sync(), 800)
    }
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh())
    if (isNative()) {
      Zap.addListener('meshChanged', (st) => {
        set({ status: st })
        pullNativeInbox()
      })
      Zap.meshStatus().then((st) => set({ status: st })).catch(() => {})
    }
  }

  return {
    uid: null,
    name: '',
    identity: null,
    contacts: {},
    keys: {},
    msgs: [],
    unread: {},
    status: { running: false, peers: 0, stored: 0, carrying: 0 },
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    syncing: false,
    error: null,

    init: async (uid, extra = {}) => {
      let identity = read<DeviceIdentity | null>(idKey(uid), null)
      if (!identity) {
        identity = await createIdentity()
        write(idKey(uid), identity)
      }
      const cache = read<Cache>(cacheKey(uid), { name: '', contacts: {}, keys: {} })
      const contacts = { ...cache.contacts }
      for (const c of extra.contacts ?? []) contacts[c.id] = c
      const name = extra.name || cache.name
      set({
        uid,
        name,
        identity,
        contacts,
        keys: cache.keys,
        msgs: read<MeshMsg[]>(msgsKey(uid), []),
        unread: read<Record<string, number>>(unreadKey(uid), {}),
        online: navigator.onLine,
      })
      write(cacheKey(uid), { name, contacts, keys: cache.keys })
      try {
        localStorage.setItem(LAST_UID, uid)
      } catch {
        /* sem armazenamento */
      }
      if (isNative()) {
        await setNativeSession(uid)
        Zap.setContacts({ contacts: Object.fromEntries(Object.values(contacts).map((c) => [c.id, c.name])) }).catch(() => {})
      }
      listen()
      await pullNativeInbox()
      if (navigator.onLine) get().sync()
    },

    start: async () => {
      if (!isNative()) return
      try {
        set({ status: await Zap.meshStart(), error: null })
      } catch (e) {
        set({ error: (e as Error).message })
      }
    },

    stop: async () => {
      if (!isNative()) return
      set({ status: await Zap.meshStop() })
    },

    send: async (peers, plain) => {
      const { uid, identity, keys, name } = get()
      if (!uid || !identity) return { ok: 0, missing: peers }
      const missing: string[] = []
      const fresh: string[] = []
      let ok = 0
      for (const peer of peers) {
        const devices = keys[peer] ?? []
        if (!devices.length) {
          missing.push(peer)
          continue
        }
        const env = await seal({ userId: uid, identity }, peer, devices, { ...plain, name })
        const s = JSON.stringify(env)
        upsertMsg({ id: env.id, peer, dir: 'out', text: plain.text, loc: plain.loc, ts: env.ts, status: 'sent' })
        if (isNative()) await Zap.meshSend({ envelope: s }).catch(() => {})
        fresh.push(s)
        ok++
      }
      if (get().online && fresh.length) {
        const up = await deposit(fresh)
        if (isNative() && up.length) Zap.meshMarkUploaded({ ids: up }).catch(() => {})
      }
      return { ok, missing }
    },

    markRead: (peer) => {
      set((s) => ({ unread: { ...s.unread, [peer]: 0 } }))
      saveMsgs()
      if (isNative()) Zap.clearNotifications({ mesh: true }).catch(() => {})
    },

    /** com internet: publica a chave, atualiza chaves dos contatos, esvazia a mochila e busca a caixa postal */
    sync: async () => {
      const { uid, identity, contacts, syncing } = get()
      if (!uid || !identity || syncing || !navigator.onLine) return
      const session = (await supabase.auth.getSession()).data.session
      if (session?.user.id !== uid) return
      set({ syncing: true })
      try {
        await supabase
          .from('mesh_keys')
          .upsert(
            { device_id: identity.deviceId, user_id: uid, enc_key: identity.encPub, sign_key: identity.signPub },
            { onConflict: 'device_id', ignoreDuplicates: true },
          )

        const ids = Object.keys(contacts)
        if (ids.length) {
          const { data } = await supabase.from('mesh_keys').select('device_id, user_id, enc_key, sign_key').in('user_id', ids)
          if (data) {
            const keys: Record<string, DeviceKeys[]> = {}
            for (const r of data) (keys[r.user_id] ??= []).push({ device_id: r.device_id, enc_key: r.enc_key, sign_key: r.sign_key })
            set({ keys })
            write(cacheKey(uid), { name: get().name, contacts: get().contacts, keys })
          }
        }

        if (isNative()) {
          const { envelopes } = await Zap.meshOutbox()
          for (let i = 0; i < envelopes.length; i += 100) {
            const up = await deposit(envelopes.slice(i, i + 100))
            if (up.length) await Zap.meshMarkUploaded({ ids: up })
          }
        }

        const { data: mail } = await supabase.from('mesh_envelopes').select('id, body').eq('to_user', uid).limit(500)
        if (mail?.length) {
          await process(mail.map((r) => r.body))
          await supabase.from('mesh_envelopes').delete().in('id', mail.map((r) => r.id))
        }
        set({ error: null })
      } catch (e) {
        console.warn('sincronização do modo emergência falhou', e)
      } finally {
        set({ syncing: false })
      }
    },
  }
})
