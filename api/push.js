// Função da Vercel: POST /api/push
// Envia notificações push (Web Push) para os aparelhos dos outros participantes, como o WhatsApp:
// chegam mesmo com o app fechado e com a tela do celular desligada.
//
// Quem chama é o próprio app, logo depois de enviar a mensagem / iniciar a ligação:
//   { type: 'message',  message_id }   → "Fulano: oi"
//   { type: 'call',     call_id }      → "Chamada de voz recebida" (toca até atender)
//   { type: 'call_end', call_id }      → troca a chamada por "Chamada perdida"
// O servidor confere tudo no banco (quem pede precisa ser o autor da mensagem / quem ligou),
// então ninguém consegue disparar notificação falsa.
//
// Variáveis de ambiente na Vercel:
//   VAPID_PRIVATE_KEY     (obrigatória) — par da chave pública abaixo
//   SUPABASE_SECRET_KEY   (obrigatória) — chave secreta sb_secret_... (ou SUPABASE_SERVICE_ROLE_KEY)
//   SUPABASE_URL          (opcional)    — usa VITE_SUPABASE_URL ou o projeto padrão

import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'

const VAPID_PUBLIC_KEY = 'BIr4I2ta0-gG8oFwZDC-90zoPwnRGnlJrdeN_pwyyDZJhn4n3F5y2BqB8rf8ZFHYVBSxEu3fn85CV-0vvBIg7DA'
const DEFAULT_URL = 'https://zxtkkejltqxcdwvgzzvw.supabase.co'

/** mensagens com mais de 5 min não geram push (evita reenvio de mensagem antiga) */
const MAX_AGE_MS = 5 * 60 * 1000

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' })

  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  const secret = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || DEFAULT_URL).trim()
  if (!privateKey || !secret) {
    return res.status(500).json({ error: 'Faltam VAPID_PRIVATE_KEY e/ou SUPABASE_SECRET_KEY nas variáveis da Vercel' })
  }

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'sem login' })

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = null
    }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'corpo inválido' })

  const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: auth } = await db.auth.getUser(token)
  const me = auth?.user
  if (!me) return res.status(401).json({ error: 'login inválido' })

  let job = null
  try {
    if (body.type === 'message') job = await messageJob(db, me.id, String(body.message_id || ''))
    else if (body.type === 'call' || body.type === 'call_end') job = await callJob(db, me.id, String(body.call_id || ''), body.type)
    else return res.status(400).json({ error: 'tipo desconhecido' })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
  if (!job || !job.userIds.length) return res.status(200).json({ sent: 0 })

  const { data: subs, error } = await db
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth, user_id')
    .in('user_id', job.userIds)
  if (error) return res.status(500).json({ error: error.message })

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'zap.app'
  const options = {
    TTL: job.ttl,
    urgency: 'high', // entrega imediata mesmo com o Android em economia de bateria (Doze)
    vapidDetails: { subject: `https://${host}`, publicKey: VAPID_PUBLIC_KEY, privateKey },
  }
  const payload = JSON.stringify(job.payload)

  let sent = 0
  const dead = []
  await Promise.all(
    (subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options)
        sent++
      } catch (e) {
        // 404/410: o aparelho cancelou a inscrição (app desinstalado, permissão revogada...)
        if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.endpoint)
        else console.warn('push falhou', e?.statusCode, e?.body || e?.message)
      }
    }),
  )
  if (dead.length) await db.from('push_subscriptions').delete().in('endpoint', dead)
  return res.status(200).json({ sent, removed: dead.length })
}

// ------------------------------------------------------------------ mensagens
async function messageJob(db, myId, messageId) {
  if (!messageId) return null
  const { data: m } = await db.from('messages').select('*').eq('id', messageId).maybeSingle()
  if (!m || m.sender_id !== myId || m.type === 'system' || m.deleted_for_everyone) return null
  if (Date.now() - new Date(m.created_at).getTime() > MAX_AGE_MS) return null

  const [{ data: conv }, { data: members }, { data: sender }] = await Promise.all([
    db.from('conversations').select('id, is_group, name, avatar_url').eq('id', m.conversation_id).maybeSingle(),
    db.from('conversation_members').select('user_id, muted').eq('conversation_id', m.conversation_id),
    db.from('profiles').select('full_name, avatar_url').eq('id', myId).maybeSingle(),
  ])
  if (!conv) return null
  // conversa silenciada = sem notificação (igual ao WhatsApp)
  const userIds = (members ?? []).filter((x) => x.user_id !== myId && !x.muted).map((x) => x.user_id)
  const senderName = sender?.full_name || 'Alguém'
  const preview = clip(messagePreview(m), 400)

  return {
    userIds,
    ttl: 60 * 60 * 24 * 3, // se o celular estiver desligado, entrega quando ligar (até 3 dias)
    payload: {
      kind: 'message',
      conversationId: conv.id,
      messageId: m.id,
      isGroup: !!conv.is_group,
      title: conv.is_group ? conv.name || 'Grupo' : senderName,
      line: conv.is_group ? `${senderName}: ${preview}` : preview,
      icon: (conv.is_group ? conv.avatar_url : sender?.avatar_url) || null,
      image: m.type === 'image' && m.media_url ? m.media_url : null,
      ts: new Date(m.created_at).getTime(),
    },
  }
}

// ------------------------------------------------------------------ ligações
async function callJob(db, myId, callId, type) {
  if (!callId) return null
  const { data: call } = await db.from('calls').select('*').eq('id', callId).maybeSingle()
  if (!call || call.caller_id !== myId) return null
  if (Date.now() - new Date(call.started_at).getTime() > MAX_AGE_MS) return null
  if (type === 'call' && call.status !== 'ringing') return null
  if (type === 'call_end' && (call.status === 'answered' || call.status === 'rejected')) return null

  const { data: caller } = await db.from('profiles').select('full_name, avatar_url').eq('id', myId).maybeSingle()
  const what = call.video ? 'vídeo' : 'voz'
  return {
    userIds: [call.callee_id],
    ttl: type === 'call' ? 45 : 60 * 60 * 24 * 3, // chamada que não tocou em 45 s não serve mais
    payload: {
      kind: type === 'call' ? 'call' : 'call_missed',
      callId: call.id,
      conversationId: call.conversation_id,
      video: !!call.video,
      title: caller?.full_name || 'Zap',
      line: type === 'call' ? `${call.video ? '📹' : '📞'} Chamada de ${what} recebida` : `Chamada de ${what} perdida`,
      icon: caller?.avatar_url || null,
      ts: Date.now(),
    },
  }
}

// mesmo texto da lista de conversas (src/lib/utils.ts → messagePreview)
function messagePreview(m) {
  switch (m.type) {
    case 'image':
      return `📷 ${m.content || 'Foto'}`
    case 'video':
      return `🎥 ${m.content || 'Vídeo'}`
    case 'audio':
      return `🎤 Mensagem de voz (${duration(Number(m.media_duration || 0))})`
    case 'document':
      return `📄 ${m.media_name || 'Documento'}`
    case 'sticker':
      return '🏷️ Figurinha'
    default:
      return stripFormatting(m.content || '')
  }
}

function duration(sec) {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** tira *negrito*, _itálico_, ~tachado~ e ```mono``` (a notificação mostra texto puro) */
function stripFormatting(t) {
  return t
    .replace(/```([\s\S]+?)```/g, '$1')
    .replace(/(^|[^\w*])\*(\S[^*\n]*?)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w_])_(\S[^_\n]*?)_(?![\w_])/g, '$1$2')
    .replace(/(^|[^\w~])~(\S[^~\n]*?)~(?![\w~])/g, '$1$2')
}

function clip(t, n) {
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
