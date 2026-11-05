import type { Conversation, Member, Message, Profile } from './types'

const pad = (n: number) => String(n).padStart(2, '0')

/** Converte timestamps do Postgres/Realtime/cliente em milissegundos de forma consistente */
export function ts(iso: string | null | undefined) {
  if (!iso) return 0
  let s = iso.replace(' ', 'T')
  if (/[+-]\d\d$/.test(s)) s += ':00'
  return Date.parse(s)
}

export type TickState = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

export function tickState(m: Message, members: Member[] | undefined, myId: string): TickState {
  if (m.failed) return 'failed'
  if (m.pending) return 'pending'
  const others = (members ?? []).filter((x) => x.user_id !== myId)
  if (!others.length) return 'read'
  const t = ts(m.created_at)
  if (others.every((o) => ts(o.last_read_at) >= t)) return 'read'
  if (others.every((o) => ts(o.last_delivered_at) >= t)) return 'delivered'
  return 'sent'
}

export function formatTime(iso: string) {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']

/** Data no estilo da lista de conversas: 14:32 / Ontem / quarta-feira / 12/03/2026 */
export function formatListDate(iso: string) {
  const d = new Date(iso)
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000)
  if (days <= 0) return formatTime(iso)
  if (days === 1) return 'Ontem'
  if (days < 7) return WEEKDAYS[d.getDay()]
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

/** Separador de data dentro da conversa */
export function formatDayLabel(iso: string) {
  const d = new Date(iso)
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000)
  if (days <= 0) return 'HOJE'
  if (days === 1) return 'ONTEM'
  if (days < 7) return WEEKDAYS[d.getDay()].toUpperCase()
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

export function sameDay(a: string, b: string) {
  return startOfDay(new Date(a)) === startOfDay(new Date(b))
}

export function formatLastSeen(iso: string) {
  const d = new Date(iso)
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000)
  if (days <= 0) return `visto por último hoje às ${formatTime(iso)}`
  if (days === 1) return `visto por último ontem às ${formatTime(iso)}`
  return `visto por último em ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} às ${formatTime(iso)}`
}

export function formatDuration(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${pad(s)}`
}

export function formatBytes(bytes: number | null | undefined) {
  if (!bytes) return ''
  const units = ['B', 'kB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** Cores dos nomes nos grupos */
const NAME_COLORS = [
  '#e542a3', '#1f7aec', '#dfb610', '#029d00', '#8b7add', '#fe7c7f', '#ba33dc', '#59d368',
  '#b04632', '#fd85d4', '#8393ca', '#ff8f2c', '#3bdec3', '#b4876e', '#c90379', '#ef4b4f',
]
export function colorFor(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return NAME_COLORS[Math.abs(h) % NAME_COLORS.length]
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
}

export function conversationTitle(
  conv: Conversation,
  members: Member[] | undefined,
  profiles: Record<string, Profile>,
  myId: string,
) {
  if (conv.is_group) return conv.name || 'Grupo'
  const other = members?.find((m) => m.user_id !== myId)
  if (!other) return `${profiles[myId]?.full_name ?? 'Você'} (Você)`
  return profiles[other.user_id]?.full_name || 'Usuário'
}

export function otherMemberId(members: Member[] | undefined, myId: string) {
  return members?.find((m) => m.user_id !== myId)?.user_id ?? myId
}

/** Texto curto para prévia na lista e em respostas */
export function messagePreview(m: Message) {
  if (m.deleted_for_everyone) return '🚫 Mensagem apagada'
  switch (m.type) {
    case 'image':
      return `📷 ${m.content || 'Foto'}`
    case 'video':
      return `🎥 ${m.content || 'Vídeo'}`
    case 'audio':
      return `🎤 ${formatDuration(Number(m.media_duration ?? 0))}`
    case 'document':
      return `📄 ${m.media_name || 'Documento'}`
    case 'sticker':
      return '🏷️ Figurinha'
    default:
      return m.content ?? ''
  }
}

export function systemText(m: Message, profiles: Record<string, Profile>, myId: string) {
  const who = (id: string | null) => (id === myId ? 'Você' : (id && profiles[id]?.full_name) || 'Alguém')
  const c = m.content ?? ''
  if (c.startsWith('created_group:')) return `${who(m.sender_id)} criou o grupo "${c.slice(14)}"`
  if (c.startsWith('added:')) return `${who(m.sender_id)} adicionou ${who(c.slice(6)).replace('Você', 'você')}`
  if (c.startsWith('removed:')) return `${who(m.sender_id)} removeu ${who(c.slice(8)).replace('Você', 'você')}`
  if (c === 'left') return `${who(m.sender_id)} saiu`
  if (c.startsWith('renamed:')) return `${who(m.sender_id)} mudou o nome do grupo para "${c.slice(8)}"`
  if (c === 'changed_icon') return `${who(m.sender_id)} mudou a imagem deste grupo`
  if (c === 'changed_description') return `${who(m.sender_id)} mudou a descrição do grupo`
  return c
}

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}

/** Destaca links em texto simples */
export const URL_RE = /(https?:\/\/[^\s]+)/g

export function isOnlyEmoji(text: string) {
  const t = text.trim()
  if (!t || t.length > 24) return false
  return /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && !/^[\d#*\s]+$/.test(t)
}

export function downscaleImage(file: Blob, maxSide = 1600, quality = 0.85): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
      if (scale === 1 && file.size < 1_500_000) {
        URL.revokeObjectURL(url)
        resolve(file)
        return
      }
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * scale)
      c.height = Math.round(img.height * scale)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      c.toBlob((b) => resolve(b ?? file), 'image/jpeg', quality)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(file)
    }
    img.src = url
  })
}
