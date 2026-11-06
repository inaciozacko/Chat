// Lógica compartilhada pelas funções da Vercel (pastas/arquivos com "_" não viram rotas).
import crypto from 'node:crypto'
import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'

export const VAPID_PUBLIC_KEY = 'BIr4I2ta0-gG8oFwZDC-90zoPwnRGnlJrdeN_pwyyDZJhn4n3F5y2BqB8rf8ZFHYVBSxEu3fn85CV-0vvBIg7DA'
const DEFAULT_URL = 'https://zxtkkejltqxcdwvgzzvw.supabase.co'

/** mensagens/ligações com mais de 5 min não geram push (evita reenvio de coisa antiga) */
export const MAX_AGE_MS = 5 * 60 * 1000

/** o app nativo roda em https://localhost: libera chamadas de outra origem */
export function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }
  return false
}

export function readBody(req) {
  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = null
    }
  }
  return body && typeof body === 'object' ? body : null
}

export function adminClient() {
  const secret = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || DEFAULT_URL).trim()
  if (!secret) return null
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
}

export function missingConfig() {
  const miss = []
  if (!process.env.VAPID_PRIVATE_KEY?.trim()) miss.push('VAPID_PRIVATE_KEY')
  if (!(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) miss.push('SUPABASE_SECRET_KEY')
  return miss
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

// ------------------------------------------------------------------ montagem das notificações
export async function messageJob(db, myId, messageId) {
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
    ttl: 60 * 60 * 24 * 3, // celular desligado: entrega quando ligar (até 3 dias)
    payload: {
      kind: 'message',
      conversationId: conv.id,
      messageId: m.id,
      isGroup: !!conv.is_group,
      title: conv.is_group ? conv.name || 'Grupo' : senderName,
      sender: senderName,
      text: preview,
      line: conv.is_group ? `${senderName}: ${preview}` : preview,
      icon: (conv.is_group ? conv.avatar_url : sender?.avatar_url) || null,
      senderIcon: sender?.avatar_url || null,
      image: m.type === 'image' && m.media_url ? m.media_url : null,
      ts: new Date(m.created_at).getTime(),
    },
  }
}

export async function callJob(db, myId, callId, type) {
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

/** mensagem de emergência que chegou à caixa postal (alguém com internet a depositou) */
export async function meshJob(db, envelopeId) {
  if (!envelopeId) return null
  const { data: env } = await db.from('mesh_envelopes').select('id, to_user, from_user, kind, created_at').eq('id', envelopeId).maybeSingle()
  if (!env || env.kind !== 'm') return null
  if (Date.now() - new Date(env.created_at).getTime() > MAX_AGE_MS) return null
  const { data: from } = env.from_user
    ? await db.from('profiles').select('full_name').eq('id', env.from_user).maybeSingle()
    : { data: null }
  return {
    userIds: [env.to_user],
    ttl: 60 * 60 * 24 * 3,
    payload: {
      kind: 'mesh',
      envelopeId: env.id,
      title: '🆘 Mensagem de emergência',
      line: `${from?.full_name || 'Alguém'} te enviou uma mensagem pelo modo emergência`,
      ts: Date.now(),
    },
  }
}

// ------------------------------------------------------------------ envio
/** entrega o payload em todos os aparelhos dos usuários: navegador/PWA (Web Push) e app nativo (Firebase) */
export async function deliver(db, job, host) {
  if (!job || !job.userIds.length) return { sent: 0, removed: 0 }
  const [{ data: subs }, { data: devices }] = await Promise.all([
    db.from('push_subscriptions').select('endpoint, p256dh, auth').in('user_id', job.userIds),
    db.from('native_devices').select('fcm_token').in('user_id', job.userIds),
  ])
  let sent = 0
  const deadSubs = []
  const deadDevices = []

  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  if (privateKey && subs?.length) {
    const options = {
      TTL: job.ttl,
      urgency: 'high', // entrega imediata mesmo com o Android em economia de bateria
      vapidDetails: { subject: `https://${host || 'zap.app'}`, publicKey: VAPID_PUBLIC_KEY, privateKey },
    }
    const payload = JSON.stringify(job.payload)
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options)
          sent++
        } catch (e) {
          if (e?.statusCode === 404 || e?.statusCode === 410) deadSubs.push(s.endpoint)
          else console.warn('web push falhou', e?.statusCode, e?.body || e?.message)
        }
      }),
    )
  }

  if (devices?.length) {
    const fcm = await fcmClient()
    if (fcm) {
      const data = Object.fromEntries(
        Object.entries(job.payload)
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      )
      await Promise.all(
        devices.map(async (d) => {
          const r = await fcm.send(d.fcm_token, data, job.ttl)
          if (r === 'ok') sent++
          else if (r === 'dead') deadDevices.push(d.fcm_token)
        }),
      )
    }
  }

  if (deadSubs.length) await db.from('push_subscriptions').delete().in('endpoint', deadSubs)
  if (deadDevices.length) await db.from('native_devices').delete().in('fcm_token', deadDevices)
  return { sent, removed: deadSubs.length + deadDevices.length }
}

// ------------------------------------------------------------------ Firebase Cloud Messaging (HTTP v1)
// Variável FIREBASE_SERVICE_ACCOUNT = conteúdo do JSON da conta de serviço do Firebase.
let fcmCache = null
async function fcmClient() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim()
  if (!raw) return null
  let sa
  try {
    sa = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'))
  } catch {
    console.warn('FIREBASE_SERVICE_ACCOUNT inválida (cole o JSON inteiro)')
    return null
  }
  const token = async () => {
    if (fcmCache && fcmCache.exp > Date.now() + 60_000) return fcmCache.token
    const now = Math.floor(Date.now() / 1000)
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`
    const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    })
    const j = await r.json()
    if (!j.access_token) throw new Error('Firebase recusou a conta de serviço: ' + JSON.stringify(j))
    fcmCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }
    return fcmCache.token
  }
  return {
    async send(fcmToken, data, ttl) {
      try {
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // só "data": quem monta a notificação (com botão Responder) é o próprio app
            message: { token: fcmToken, data, android: { priority: 'HIGH', ttl: `${ttl}s` } },
          }),
        })
        if (r.ok) return 'ok'
        const err = await r.text()
        if (r.status === 404 || err.includes('UNREGISTERED')) return 'dead'
        console.warn('FCM falhou', r.status, err)
        return 'error'
      } catch (e) {
        console.warn('FCM falhou', e?.message)
        return 'error'
      }
    },
  }
}

// ------------------------------------------------------------------ texto
// mesmo texto da lista de conversas (src/lib/utils.ts → messagePreview)
export function messagePreview(m) {
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
export function stripFormatting(t) {
  return t
    .replace(/```([\s\S]+?)```/g, '$1')
    .replace(/(^|[^\w*])\*(\S[^*\n]*?)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w_])_(\S[^_\n]*?)_(?![\w_])/g, '$1$2')
    .replace(/(^|[^\w~])~(\S[^~\n]*?)~(?![\w~])/g, '$1$2')
}

export function clip(t, n) {
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
