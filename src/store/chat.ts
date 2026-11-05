import { create } from 'zustand'
import type { Session } from '@supabase/supabase-js'
import { supabase, uploadFile } from '../lib/supabase'
import type {
  Conversation,
  LeftPanel,
  Member,
  Message,
  Profile,
  Reaction,
  RightPanel,
  Status,
  Sticker,
} from '../lib/types'
import { conversationTitle, messagePreview, ts } from '../lib/utils'

const PAGE = 50

type Typing = Record<string, Record<string, { kind: 'typing' | 'recording'; at: number }>>

export type Settings = {
  theme: 'light' | 'dark'
  notifications: boolean
  sounds: boolean
  enterToSend: boolean
  wallpaper: string
}

function loadSettings(): Settings {
  const defaults: Settings = {
    theme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    notifications: true,
    sounds: true,
    enterToSend: true,
    wallpaper: 'default',
  }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('zap-settings') || '{}') }
  } catch {
    return defaults
  }
}

type NewMessage = Partial<Omit<Message, 'id' | 'conversation_id' | 'sender_id' | 'created_at'>> & {
  type: Message['type']
}

type State = {
  session: Session | null
  me: Profile | null
  loaded: boolean
  profiles: Record<string, Profile>
  conversations: Record<string, Conversation>
  members: Record<string, Member[]>
  lastMessages: Record<string, Message | undefined>
  unread: Record<string, number>
  messages: Record<string, Message[]>
  hasMore: Record<string, boolean>
  reactions: Record<string, Reaction[]>
  extraMessages: Record<string, Message>
  hidden: Set<string>
  starred: Set<string>
  stickers: Sticker[]
  online: Set<string>
  typing: Typing
  statuses: Status[]
  viewedStatuses: Set<string>

  activeId: string | null
  leftPanel: LeftPanel
  rightPanel: RightPanel
  replyTo: Message | null
  editing: Message | null
  forwarding: Message[] | null
  selecting: Set<string> | null
  lightbox: { url: string; type: 'image' | 'video'; caption?: string | null } | null
  stickerCreator: { file?: Blob } | null
  statusViewer: { userId: string } | null
  statusComposer: 'text' | 'image' | null
  searchQuery: string
  jumpTo: string | null
  toast: string | null
  settings: Settings
}

type Actions = {
  init: (session: Session) => Promise<void>
  reset: () => void
  loadChats: () => Promise<void>
  openChat: (id: string | null) => Promise<void>
  loadMessages: (convId: string, older?: boolean) => Promise<void>
  markRead: (convId: string) => Promise<void>
  sendMessage: (convId: string, msg: NewMessage) => Promise<Message | null>
  sendMedia: (convId: string, file: Blob, kind: Message['type'], extra?: Partial<Message>) => Promise<void>
  retryMessage: (msg: Message) => Promise<void>
  editMessage: (msg: Message, content: string) => Promise<void>
  deleteForEveryone: (msg: Message) => Promise<void>
  deleteForMe: (msgs: Message[]) => Promise<void>
  react: (msg: Message, emoji: string) => Promise<void>
  toggleStar: (msgs: Message[]) => Promise<void>
  forward: (msgs: Message[], convIds: string[]) => Promise<void>
  startDirect: (userId: string) => Promise<void>
  createGroup: (name: string, memberIds: string[], avatar?: Blob | null, description?: string) => Promise<void>
  updateMember: (convId: string, patch: Partial<Member>) => Promise<void>
  clearChat: (convId: string) => Promise<void>
  deleteChat: (convId: string) => Promise<void>
  updateConversation: (convId: string, patch: Partial<Conversation>, systemNote?: string) => Promise<void>
  updateProfile: (patch: Partial<Profile>) => Promise<void>
  uploadAvatar: (file: Blob) => Promise<string>
  loadStickers: () => Promise<void>
  saveSticker: (blob: Blob, emoji?: string | null) => Promise<Sticker | null>
  addStickerFromUrl: (url: string) => Promise<void>
  deleteSticker: (s: Sticker) => Promise<void>
  toggleFavoriteSticker: (s: Sticker) => Promise<void>
  loadStatuses: () => Promise<void>
  postStatus: (s: { type: 'text' | 'image'; content?: string; bg_color?: string; file?: Blob }) => Promise<void>
  markStatusViewed: (id: string) => Promise<void>
  deleteStatus: (id: string) => Promise<void>
  fetchProfiles: (ids: string[]) => Promise<void>
  fetchMessagesByIds: (ids: string[]) => Promise<void>

  // realtime
  onMessage: (m: Message, event: 'INSERT' | 'UPDATE') => void
  onReaction: (r: Reaction | Partial<Reaction>, event: 'INSERT' | 'UPDATE' | 'DELETE') => void
  onMember: (m: Member | Partial<Member>, event: 'INSERT' | 'UPDATE' | 'DELETE') => void
  onConversation: (c: Conversation) => void
  onProfile: (p: Profile) => void
  onStatus: (s: Status) => void
  setTyping: (convId: string, userId: string, kind: 'typing' | 'recording' | null) => void
  setOnline: (ids: string[]) => void

  set: (patch: Partial<State>) => void
  showToast: (msg: string) => void
  updateSettings: (patch: Partial<Settings>) => void
}

const initial = (): State => ({
  session: null,
  me: null,
  loaded: false,
  profiles: {},
  conversations: {},
  members: {},
  lastMessages: {},
  unread: {},
  messages: {},
  hasMore: {},
  reactions: {},
  extraMessages: {},
  hidden: new Set(),
  starred: new Set(),
  stickers: [],
  online: new Set(),
  typing: {},
  statuses: [],
  viewedStatuses: new Set(),
  activeId: null,
  leftPanel: 'chats',
  rightPanel: null,
  replyTo: null,
  editing: null,
  forwarding: null,
  selecting: null,
  lightbox: null,
  stickerCreator: null,
  statusViewer: null,
  statusComposer: null,
  searchQuery: '',
  jumpTo: null,
  toast: null,
  settings: loadSettings(),
})

let toastTimer: number | undefined
const deliveredTimers: Record<string, number> = {}

function upsertSorted(list: Message[], m: Message) {
  const i = list.findIndex((x) => x.id === m.id)
  if (i >= 0) {
    const copy = list.slice()
    copy[i] = { ...copy[i], ...m, pending: false, failed: false }
    return copy
  }
  const copy = [...list, m]
  copy.sort((a, b) => ts(a.created_at) - ts(b.created_at))
  return copy
}

export const useChat = create<State & Actions>((set, get) => ({
  ...initial(),

  set: (patch) => set(patch),

  showToast: (msg) => {
    set({ toast: msg })
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => set({ toast: null }), 3000)
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch }
    localStorage.setItem('zap-settings', JSON.stringify(settings))
    set({ settings })
  },

  reset: () => set({ ...initial(), settings: get().settings }),

  init: async (session) => {
    set({ session })
    const uid = session.user.id
    await supabase.realtime.setAuth(session.access_token)
    let { data: me } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()
    if (!me) {
      // trigger pode não ter rodado (ex.: usuário criado antes do schema)
      const meta = session.user.user_metadata ?? {}
      const { data } = await supabase
        .from('profiles')
        .upsert({ id: uid, full_name: meta.full_name ?? session.user.email?.split('@')[0] ?? 'Usuário' })
        .select()
        .single()
      me = data
    }
    if (me) set((s) => ({ me, profiles: { ...s.profiles, [uid]: me } }))
    supabase.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', uid).then()

    await Promise.all([
      get().loadChats(),
      get().loadStickers(),
      supabase
        .from('starred_messages')
        .select('message_id')
        .eq('user_id', uid)
        .then(({ data }) => set({ starred: new Set((data ?? []).map((r) => r.message_id)) })),
      supabase
        .from('message_hidden')
        .select('message_id')
        .eq('user_id', uid)
        .then(({ data }) => set({ hidden: new Set((data ?? []).map((r) => r.message_id)) })),
    ])
    supabase.rpc('mark_delivered', {}).then()
    set({ loaded: true })
    get().loadStatuses()
  },

  loadChats: async () => {
    const uid = get().session?.user.id
    if (!uid) return
    const { data: mine, error } = await supabase
      .from('conversation_members')
      .select('*, conversations(*)')
      .eq('user_id', uid)
    if (error) {
      get().showToast('Erro ao carregar conversas: ' + error.message)
      return
    }
    const ids = (mine ?? []).map((m) => m.conversation_id as string)
    const conversations: Record<string, Conversation> = {}
    for (const row of mine ?? []) {
      if (row.conversations) conversations[row.conversation_id] = row.conversations as Conversation
    }

    const [{ data: allMembers }, { data: summaries }] = await Promise.all([
      ids.length
        ? supabase.from('conversation_members').select('*, profiles(*)').in('conversation_id', ids)
        : Promise.resolve({ data: [] as never[] }),
      supabase.rpc('chat_summaries'),
    ])

    const members: Record<string, Member[]> = {}
    const profiles: Record<string, Profile> = { ...get().profiles }
    for (const row of (allMembers ?? []) as (Member & { profiles: Profile | null })[]) {
      const { profiles: p, ...m } = row
      ;(members[m.conversation_id] ??= []).push(m)
      if (p) profiles[p.id] = p
    }
    const lastMessages: Record<string, Message | undefined> = {}
    const unread: Record<string, number> = {}
    for (const s of (summaries ?? []) as { conversation_id: string; last_message: Message | null; unread_count: number }[]) {
      lastMessages[s.conversation_id] = s.last_message ?? undefined
      unread[s.conversation_id] = s.unread_count
    }
    const active = get().activeId
    if (active) unread[active] = 0
    set({ conversations, members, profiles, lastMessages, unread })
  },

  fetchProfiles: async (ids) => {
    const missing = ids.filter((id) => id && !get().profiles[id])
    if (!missing.length) return
    const { data } = await supabase.from('profiles').select('*').in('id', missing)
    if (data) set((s) => ({ profiles: { ...s.profiles, ...Object.fromEntries(data.map((p) => [p.id, p])) } }))
  },

  fetchMessagesByIds: async (ids) => {
    const known = new Set(Object.values(get().messages).flat().map((m) => m.id))
    const missing = ids.filter((id) => !known.has(id) && !get().extraMessages[id])
    if (!missing.length) return
    const { data } = await supabase.from('messages').select('*').in('id', missing)
    if (data) set((s) => ({ extraMessages: { ...s.extraMessages, ...Object.fromEntries(data.map((m) => [m.id, m])) } }))
  },

  openChat: async (id) => {
    set({ activeId: id, replyTo: null, editing: null, selecting: null, searchQuery: '', jumpTo: null })
    if (!id) return
    if (get().rightPanel === 'search') set({ rightPanel: null })
    if (!get().messages[id]) await get().loadMessages(id)
    get().markRead(id)
  },

  loadMessages: async (convId, older = false) => {
    const uid = get().session!.user.id
    const me = get().members[convId]?.find((m) => m.user_id === uid)
    const current = get().messages[convId] ?? []
    let q = supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', convId)
      .gt('created_at', me?.cleared_at ?? '1970-01-01')
      .order('created_at', { ascending: false })
      .limit(PAGE)
    if (older && current.length) q = q.lt('created_at', current[0].created_at)
    const { data, error } = await q
    if (error) {
      get().showToast(error.message)
      return
    }
    const page = (data ?? []).reverse() as Message[]
    const merged = older ? [...page, ...current] : page.concat(current.filter((m) => m.pending))
    set((s) => ({
      messages: { ...s.messages, [convId]: merged },
      hasMore: { ...s.hasMore, [convId]: page.length === PAGE },
    }))

    const ids = page.map((m) => m.id)
    if (ids.length) {
      const { data: rx } = await supabase.from('message_reactions').select('*').in('message_id', ids)
      const byMsg: Record<string, Reaction[]> = {}
      for (const r of rx ?? []) (byMsg[r.message_id] ??= []).push(r)
      set((s) => {
        const reactions = { ...s.reactions }
        for (const id of ids) reactions[id] = byMsg[id] ?? []
        return { reactions }
      })
    }
    const replyIds = page.map((m) => m.reply_to).filter(Boolean) as string[]
    if (replyIds.length) get().fetchMessagesByIds(replyIds)
    const senders = page.map((m) => m.sender_id).filter(Boolean) as string[]
    get().fetchProfiles([...new Set(senders)])
  },

  markRead: async (convId) => {
    const uid = get().session?.user.id
    if (!uid) return
    set((s) => ({
      unread: { ...s.unread, [convId]: 0 },
      members: {
        ...s.members,
        [convId]: (s.members[convId] ?? []).map((m) => (m.user_id === uid ? { ...m, marked_unread: false } : m)),
      },
    }))
    await supabase.rpc('mark_read', { conv: convId })
  },

  sendMessage: async (convId, msg) => {
    const uid = get().session!.user.id
    const optimistic: Message = {
      id: crypto.randomUUID(),
      conversation_id: convId,
      sender_id: uid,
      content: null,
      media_url: null,
      media_name: null,
      media_size: null,
      media_mime: null,
      media_duration: null,
      reply_to: null,
      forwarded: false,
      edited_at: null,
      deleted_for_everyone: false,
      created_at: new Date().toISOString(),
      ...msg,
      pending: true,
    }
    set((s) => ({
      messages: { ...s.messages, [convId]: upsertSorted(s.messages[convId] ?? [], optimistic) },
      lastMessages: { ...s.lastMessages, [convId]: optimistic },
    }))
    const { pending: _p, failed: _f, ...row } = optimistic
    const { data, error } = await supabase.from('messages').insert(row).select().single()
    if (error || !data) {
      set((s) => ({
        messages: {
          ...s.messages,
          [convId]: (s.messages[convId] ?? []).map((m) => (m.id === optimistic.id ? { ...m, failed: true } : m)),
        },
      }))
      get().showToast('Não foi possível enviar: ' + (error?.message ?? 'erro desconhecido'))
      return null
    }
    get().onMessage(data as Message, 'INSERT')
    return data as Message
  },

  retryMessage: async (msg) => {
    set((s) => ({
      messages: {
        ...s.messages,
        [msg.conversation_id]: (s.messages[msg.conversation_id] ?? []).filter((m) => m.id !== msg.id),
      },
    }))
    const { id: _id, conversation_id, sender_id: _s, created_at: _c, pending: _p, failed: _f, ...rest } = msg
    await get().sendMessage(conversation_id, rest)
  },

  sendMedia: async (convId, file, kind, extra = {}) => {
    const uid = get().session!.user.id
    const bucket = kind === 'sticker' ? 'stickers' : 'media'
    // mensagem otimista com blob local enquanto faz upload
    const localUrl = URL.createObjectURL(file)
    const tempId = crypto.randomUUID()
    const temp: Message = {
      id: tempId,
      conversation_id: convId,
      sender_id: uid,
      type: kind,
      content: null,
      media_url: localUrl,
      media_name: file instanceof File ? file.name : null,
      media_size: file.size,
      media_mime: file.type,
      media_duration: null,
      reply_to: null,
      forwarded: false,
      edited_at: null,
      deleted_for_everyone: false,
      created_at: new Date().toISOString(),
      ...extra,
      pending: true,
    }
    set((s) => ({ messages: { ...s.messages, [convId]: [...(s.messages[convId] ?? []), temp] } }))
    try {
      const { url } = await uploadFile(bucket, file, uid)
      set((s) => ({
        messages: { ...s.messages, [convId]: (s.messages[convId] ?? []).filter((m) => m.id !== tempId) },
      }))
      await get().sendMessage(convId, {
        type: kind,
        media_url: url,
        media_name: temp.media_name,
        media_size: file.size,
        media_mime: file.type,
        ...extra,
      })
    } catch (e) {
      set((s) => ({
        messages: {
          ...s.messages,
          [convId]: (s.messages[convId] ?? []).map((m) => (m.id === tempId ? { ...m, failed: true } : m)),
        },
      }))
      get().showToast('Falha no upload: ' + (e as Error).message)
    }
  },

  editMessage: async (msg, content) => {
    const { error } = await supabase
      .from('messages')
      .update({ content, edited_at: new Date().toISOString() })
      .eq('id', msg.id)
    if (error) get().showToast(error.message)
    else get().onMessage({ ...msg, content, edited_at: new Date().toISOString() }, 'UPDATE')
  },

  deleteForEveryone: async (msg) => {
    const patch = { deleted_for_everyone: true, content: null, media_url: null, media_name: null }
    const { error } = await supabase.from('messages').update(patch).eq('id', msg.id)
    if (error) get().showToast(error.message)
    else get().onMessage({ ...msg, ...patch }, 'UPDATE')
  },

  deleteForMe: async (msgs) => {
    const uid = get().session!.user.id
    set((s) => {
      const hidden = new Set(s.hidden)
      msgs.forEach((m) => hidden.add(m.id))
      return { hidden }
    })
    await supabase.from('message_hidden').upsert(msgs.map((m) => ({ message_id: m.id, user_id: uid })))
  },

  react: async (msg, emoji) => {
    const uid = get().session!.user.id
    const existing = (get().reactions[msg.id] ?? []).find((r) => r.user_id === uid)
    if (existing?.emoji === emoji) {
      get().onReaction({ message_id: msg.id, user_id: uid }, 'DELETE')
      await supabase.from('message_reactions').delete().eq('message_id', msg.id).eq('user_id', uid)
    } else {
      const r = { message_id: msg.id, user_id: uid, emoji, created_at: new Date().toISOString() }
      get().onReaction(r, 'INSERT')
      await supabase.from('message_reactions').upsert(r)
    }
  },

  toggleStar: async (msgs) => {
    const uid = get().session!.user.id
    const starred = new Set(get().starred)
    const allStarred = msgs.every((m) => starred.has(m.id))
    if (allStarred) {
      msgs.forEach((m) => starred.delete(m.id))
      set({ starred })
      await supabase
        .from('starred_messages')
        .delete()
        .eq('user_id', uid)
        .in(
          'message_id',
          msgs.map((m) => m.id),
        )
    } else {
      msgs.forEach((m) => starred.add(m.id))
      set({ starred })
      await supabase.from('starred_messages').upsert(msgs.map((m) => ({ message_id: m.id, user_id: uid })))
    }
  },

  forward: async (msgs, convIds) => {
    for (const convId of convIds) {
      for (const m of msgs) {
        await get().sendMessage(convId, {
          type: m.type,
          content: m.content,
          media_url: m.media_url,
          media_name: m.media_name,
          media_size: m.media_size,
          media_mime: m.media_mime,
          media_duration: m.media_duration,
          forwarded: m.type !== 'sticker',
        })
      }
    }
    get().showToast(convIds.length > 1 ? `Encaminhada para ${convIds.length} conversas` : 'Mensagem encaminhada')
  },

  startDirect: async (userId) => {
    const { data, error } = await supabase.rpc('get_or_create_direct', { other: userId })
    if (error) {
      get().showToast(error.message)
      return
    }
    await get().loadChats()
    set({ leftPanel: 'chats' })
    await get().openChat(data as string)
  },

  createGroup: async (name, memberIds, avatar, description) => {
    let avatarUrl: string | null = null
    if (avatar) avatarUrl = (await uploadFile('avatars', avatar, get().session!.user.id)).url
    const { data, error } = await supabase.rpc('create_group', {
      group_name: name,
      member_ids: memberIds,
      group_avatar: avatarUrl,
      group_description: description ?? null,
    })
    if (error) {
      get().showToast(error.message)
      return
    }
    await get().loadChats()
    set({ leftPanel: 'chats' })
    await get().openChat(data as string)
  },

  updateMember: async (convId, patch) => {
    const uid = get().session!.user.id
    set((s) => ({
      members: {
        ...s.members,
        [convId]: (s.members[convId] ?? []).map((m) => (m.user_id === uid ? { ...m, ...patch } : m)),
      },
    }))
    const { error } = await supabase
      .from('conversation_members')
      .update(patch)
      .eq('conversation_id', convId)
      .eq('user_id', uid)
    if (error) get().showToast(error.message)
  },

  clearChat: async (convId) => {
    await get().updateMember(convId, { cleared_at: new Date().toISOString() })
    set((s) => ({
      messages: { ...s.messages, [convId]: [] },
      lastMessages: { ...s.lastMessages, [convId]: undefined },
      unread: { ...s.unread, [convId]: 0 },
    }))
  },

  deleteChat: async (convId) => {
    const conv = get().conversations[convId]
    const uid = get().session!.user.id
    if (conv?.is_group) {
      const { error } = await supabase.rpc('remove_group_member', { conv: convId, member: uid })
      if (error) return get().showToast(error.message)
      set((s) => {
        const conversations = { ...s.conversations }
        delete conversations[convId]
        return { conversations, activeId: s.activeId === convId ? null : s.activeId }
      })
    } else {
      // conversa 1:1: limpa e arquiva (como "apagar conversa")
      await get().clearChat(convId)
      await get().updateMember(convId, { archived: false, pinned: false })
      set((s) => ({ activeId: s.activeId === convId ? null : s.activeId }))
    }
  },

  updateConversation: async (convId, patch, systemNote) => {
    set((s) => ({ conversations: { ...s.conversations, [convId]: { ...s.conversations[convId], ...patch } } }))
    const { error } = await supabase.from('conversations').update(patch).eq('id', convId)
    if (error) return get().showToast(error.message)
    if (systemNote) await supabase.rpc('log_group_event', { conv: convId, note: systemNote })
  },

  updateProfile: async (patch) => {
    const me = get().me
    if (!me) return
    const next = { ...me, ...patch }
    set((s) => ({ me: next, profiles: { ...s.profiles, [me.id]: next } }))
    const { error } = await supabase.from('profiles').update(patch).eq('id', me.id)
    if (error) get().showToast(error.message)
  },

  uploadAvatar: async (file) => {
    const { url } = await uploadFile('avatars', file, get().session!.user.id)
    return url
  },

  loadStickers: async () => {
    const uid = get().session?.user.id
    if (!uid) return
    const { data } = await supabase
      .from('stickers')
      .select('*')
      .eq('owner_id', uid)
      .order('created_at', { ascending: false })
    set({ stickers: (data ?? []) as Sticker[] })
  },

  saveSticker: async (blob, emoji) => {
    const uid = get().session!.user.id
    try {
      const ext = blob.type === 'image/gif' ? 'gif' : blob.type === 'image/webp' ? 'webp' : 'png'
      const { url, path } = await uploadFile('stickers', blob, uid, ext)
      const { data, error } = await supabase
        .from('stickers')
        .insert({ owner_id: uid, image_url: url, storage_path: path, emoji: emoji ?? null })
        .select()
        .single()
      if (error) throw error
      set((s) => ({ stickers: [data as Sticker, ...s.stickers] }))
      return data as Sticker
    } catch (e) {
      get().showToast('Erro ao salvar figurinha: ' + (e as Error).message)
      return null
    }
  },

  addStickerFromUrl: async (url) => {
    const uid = get().session!.user.id
    if (get().stickers.some((s) => s.image_url === url)) {
      get().showToast('Essa figurinha já está nas suas figurinhas')
      return
    }
    const { data, error } = await supabase
      .from('stickers')
      .insert({ owner_id: uid, image_url: url, favorite: true })
      .select()
      .single()
    if (error) return get().showToast(error.message)
    set((s) => ({ stickers: [data as Sticker, ...s.stickers] }))
    get().showToast('Adicionada aos favoritos')
  },

  deleteSticker: async (st) => {
    set((s) => ({ stickers: s.stickers.filter((x) => x.id !== st.id) }))
    await supabase.from('stickers').delete().eq('id', st.id)
    // o arquivo continua no storage pois pode ter sido enviado em conversas
  },

  toggleFavoriteSticker: async (st) => {
    set((s) => ({ stickers: s.stickers.map((x) => (x.id === st.id ? { ...x, favorite: !x.favorite } : x)) }))
    await supabase.from('stickers').update({ favorite: !st.favorite }).eq('id', st.id)
  },

  loadStatuses: async () => {
    const uid = get().session?.user.id
    if (!uid) return
    const { data } = await supabase
      .from('statuses')
      .select('*')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true })
    const list = (data ?? []) as Status[]
    const { data: views } = await supabase.from('status_views').select('status_id').eq('viewer_id', uid)
    set({ statuses: list, viewedStatuses: new Set((views ?? []).map((v) => v.status_id)) })
    get().fetchProfiles([...new Set(list.map((s) => s.user_id))])
  },

  postStatus: async ({ type, content, bg_color, file }) => {
    const uid = get().session!.user.id
    let media_url: string | null = null
    if (file) media_url = (await uploadFile('media', file, uid)).url
    const { data, error } = await supabase
      .from('statuses')
      .insert({ user_id: uid, type, content: content ?? null, bg_color: bg_color ?? null, media_url })
      .select()
      .single()
    if (error) return get().showToast(error.message)
    get().onStatus(data as Status)
    get().showToast('Status publicado')
  },

  markStatusViewed: async (id) => {
    if (get().viewedStatuses.has(id)) return
    const uid = get().session!.user.id
    set((s) => ({ viewedStatuses: new Set([...s.viewedStatuses, id]) }))
    await supabase.from('status_views').upsert({ status_id: id, viewer_id: uid })
  },

  deleteStatus: async (id) => {
    set((s) => ({ statuses: s.statuses.filter((x) => x.id !== id) }))
    await supabase.from('statuses').delete().eq('id', id)
  },

  // ------------------------------------------------------------ realtime
  onMessage: (m, event) => {
    const s = get()
    const uid = s.session?.user.id
    if (!uid) return
    const convId = m.conversation_id
    if (!s.conversations[convId]) {
      // conversa nova (alguém me adicionou ou iniciou conversa)
      get().loadChats()
      return
    }
    const myMember = s.members[convId]?.find((x) => x.user_id === uid)
    if (myMember && ts(m.created_at) <= ts(myMember.cleared_at)) return

    set((st) => {
      const patch: Partial<State> = {}
      if (st.messages[convId]) patch.messages = { ...st.messages, [convId]: upsertSorted(st.messages[convId], m) }
      if (st.extraMessages[m.id]) patch.extraMessages = { ...st.extraMessages, [m.id]: m }
      const last = st.lastMessages[convId]
      if (!last || last.id === m.id || ts(last.created_at) <= ts(m.created_at))
        patch.lastMessages = { ...st.lastMessages, [convId]: m }
      if (event === 'INSERT') {
        patch.conversations = {
          ...st.conversations,
          [convId]: { ...st.conversations[convId], last_message_at: m.created_at },
        }
      }
      return patch
    })

    if (event === 'INSERT' && m.sender_id !== uid && m.type !== 'system') {
      const isActive = s.activeId === convId && document.visibilityState === 'visible'
      if (isActive) {
        get().markRead(convId)
      } else {
        const known = (s.messages[convId] ?? []).some((x) => x.id === m.id)
        if (!known) set((st) => ({ unread: { ...st.unread, [convId]: (st.unread[convId] ?? 0) + 1 } }))
        window.clearTimeout(deliveredTimers[convId])
        deliveredTimers[convId] = window.setTimeout(() => supabase.rpc('mark_delivered', { conv: convId }), 600)
      }
      if (m.sender_id) get().fetchProfiles([m.sender_id])
      if (m.reply_to) get().fetchMessagesByIds([m.reply_to])
      notifyIncoming(m, isActive)
    }
  },

  onReaction: (r, event) => {
    if (!r.message_id) return
    set((s) => {
      const list = (s.reactions[r.message_id!] ?? []).filter((x) => x.user_id !== r.user_id)
      if (event !== 'DELETE') list.push(r as Reaction)
      return { reactions: { ...s.reactions, [r.message_id!]: list } }
    })
  },

  onMember: (m, event) => {
    const uid = get().session?.user.id
    const convId = m.conversation_id
    if (!convId) return
    if (event === 'DELETE') {
      if (m.user_id === uid) {
        set((s) => {
          const conversations = { ...s.conversations }
          delete conversations[convId]
          return { conversations, activeId: s.activeId === convId ? null : s.activeId }
        })
      } else {
        set((s) => ({
          members: { ...s.members, [convId]: (s.members[convId] ?? []).filter((x) => x.user_id !== m.user_id) },
        }))
      }
      return
    }
    if (!get().conversations[convId] || (event === 'INSERT' && m.user_id === uid)) {
      get().loadChats()
      return
    }
    set((s) => {
      const list = s.members[convId] ?? []
      const exists = list.some((x) => x.user_id === m.user_id)
      return {
        members: {
          ...s.members,
          [convId]: exists
            ? list.map((x) => (x.user_id === m.user_id ? { ...x, ...(m as Member) } : x))
            : [...list, m as Member],
        },
      }
    })
    if (m.user_id) get().fetchProfiles([m.user_id])
  },

  onConversation: (c) => {
    if (!get().conversations[c.id]) return
    set((s) => ({ conversations: { ...s.conversations, [c.id]: { ...s.conversations[c.id], ...c } } }))
  },

  onProfile: (p) => {
    set((s) => ({
      profiles: { ...s.profiles, [p.id]: p },
      me: s.me?.id === p.id ? p : s.me,
    }))
  },

  onStatus: (st) => {
    set((s) => (s.statuses.some((x) => x.id === st.id) ? s : { statuses: [...s.statuses, st] }))
    get().fetchProfiles([st.user_id])
  },

  setTyping: (convId, userId, kind) => {
    set((s) => {
      const conv = { ...(s.typing[convId] ?? {}) }
      if (kind) conv[userId] = { kind, at: Date.now() }
      else delete conv[userId]
      return { typing: { ...s.typing, [convId]: conv } }
    })
  },

  setOnline: (ids) => set({ online: new Set(ids) }),
}))

/**
 * Quantas conversas têm mensagens não lidas (não a quantidade de mensagens), como no original:
 * ignora conversas arquivadas e silenciadas; conta as marcadas manualmente como "não lida".
 */
export function selectUnreadChats(s: State) {
  const uid = s.session?.user.id
  if (!uid) return 0
  let n = 0
  for (const id of Object.keys(s.conversations)) {
    const mine = s.members[id]?.find((m) => m.user_id === uid)
    if (!mine || mine.archived || mine.muted) continue
    if ((s.unread[id] ?? 0) > 0 || mine.marked_unread) n++
  }
  return n
}

// ---------------------------------------------------------------- notificações
let audioCtx: AudioContext | null = null
function beep() {
  try {
    audioCtx ??= new AudioContext()
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(880, audioCtx.currentTime)
    o.frequency.exponentialRampToValueAtTime(1320, audioCtx.currentTime + 0.08)
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25)
    o.connect(g).connect(audioCtx.destination)
    o.start()
    o.stop(audioCtx.currentTime + 0.26)
  } catch {
    /* sem áudio */
  }
}

function notifyIncoming(m: Message, isActive: boolean) {
  const s = useChat.getState()
  const uid = s.session?.user.id
  const member = s.members[m.conversation_id]?.find((x) => x.user_id === uid)
  if (member?.muted) return
  if (s.settings.sounds && !isActive) beep()
  if (!s.settings.notifications || document.visibilityState === 'visible') return
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const conv = s.conversations[m.conversation_id]
  const title = conv ? conversationTitle(conv, s.members[conv.id], s.profiles, uid!) : 'Nova mensagem'
  const sender = m.sender_id ? s.profiles[m.sender_id]?.full_name : ''
  const body = (conv?.is_group && sender ? `${sender}: ` : '') + messagePreview(m)
  const n = new Notification(title, { body, icon: '/favicon.svg', tag: m.conversation_id })
  n.onclick = () => {
    window.focus()
    useChat.getState().openChat(m.conversation_id)
    n.close()
  }
}
