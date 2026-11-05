export type Profile = {
  id: string
  username: string | null
  full_name: string
  phone: string | null
  about: string
  avatar_url: string | null
  last_seen: string
  created_at: string
}

export type Conversation = {
  id: string
  is_group: boolean
  name: string | null
  description: string | null
  avatar_url: string | null
  created_by: string | null
  created_at: string
  last_message_at: string
}

export type Member = {
  conversation_id: string
  user_id: string
  role: 'admin' | 'member'
  joined_at: string
  last_read_at: string
  last_delivered_at: string
  cleared_at: string
  pinned: boolean
  archived: boolean
  muted: boolean
  marked_unread: boolean
}

export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'system'

export type Message = {
  id: string
  conversation_id: string
  sender_id: string | null
  type: MessageType
  content: string | null
  media_url: string | null
  media_name: string | null
  media_size: number | null
  media_mime: string | null
  media_duration: number | null
  reply_to: string | null
  forwarded: boolean
  edited_at: string | null
  deleted_for_everyone: boolean
  created_at: string
  /** somente no cliente: mensagem otimista ainda não confirmada */
  pending?: boolean
  failed?: boolean
}

export type Reaction = {
  message_id: string
  user_id: string
  emoji: string
  created_at: string
}

export type Sticker = {
  id: string
  owner_id: string
  image_url: string
  storage_path: string | null
  emoji: string | null
  favorite: boolean
  created_at: string
}

export type Status = {
  id: string
  user_id: string
  type: 'text' | 'image'
  content: string | null
  media_url: string | null
  bg_color: string | null
  created_at: string
  expires_at: string
}

export type Announcement = {
  id: string
  title: string
  body: string
  image_url: string | null
  link_url: string | null
  link_label: string | null
  active: boolean
  created_by: string | null
  created_at: string
  expires_at: string | null
}

export type CallLog = {
  id: string
  conversation_id: string
  caller_id: string
  callee_id: string
  video: boolean
  status: 'ringing' | 'answered' | 'missed' | 'rejected' | 'busy' | 'failed'
  started_at: string
  answered_at: string | null
  ended_at: string | null
}

export type LeftPanel =
  | 'chats'
  | 'newChat'
  | 'newGroup'
  | 'profile'
  | 'settings'
  | 'starred'
  | 'archived'
  | 'status'
  | 'announcements'
  | 'calls'

export type RightPanel = null | 'info' | 'search' | 'starred'
