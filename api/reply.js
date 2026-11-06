// Função da Vercel: POST /api/reply
// Usada pelo app Android direto da NOTIFICAÇÃO (sem abrir o app):
//   { secret, action: 'reply',   conversation_id, text, id? }  → envia a resposta escrita na notificação
//   { secret, action: 'read',    conversation_id }             → "Marcar como lida"
//   { secret, action: 'decline', call_id }                     → "Recusar" ligação
// "secret" é o segredo aleatório que o app gerou ao ativar as notificações (o banco guarda só o hash),
// então só aquele aparelho consegue responder em nome do seu dono.

import crypto from 'node:crypto'
import { adminClient, cors, deliver, messageJob, readBody, sha256 } from './_lib/core.js'

export default async function handler(req, res) {
  if (cors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' })
  const db = adminClient()
  if (!db) return res.status(500).json({ error: 'Falta SUPABASE_SECRET_KEY nas variáveis da Vercel' })

  const body = readBody(req)
  const secret = String(body?.secret || '')
  if (secret.length < 32) return res.status(401).json({ error: 'aparelho não autorizado' })
  const { data: device } = await db.from('native_devices').select('user_id').eq('secret_hash', sha256(secret)).maybeSingle()
  if (!device) return res.status(401).json({ error: 'aparelho não autorizado' })
  const uid = device.user_id

  if (body.action === 'decline') {
    const callId = String(body.call_id || '')
    await db.from('calls').update({ status: 'rejected', ended_at: new Date().toISOString() })
      .eq('id', callId).eq('callee_id', uid).eq('status', 'ringing')
    return res.status(200).json({ ok: true })
  }

  const convId = String(body.conversation_id || '')
  const { data: member } = await db.from('conversation_members').select('user_id')
    .eq('conversation_id', convId).eq('user_id', uid).maybeSingle()
  if (!member) return res.status(403).json({ error: 'você não participa desta conversa' })

  const markRead = () =>
    db.from('conversation_members')
      .update({ last_read_at: new Date().toISOString(), last_delivered_at: new Date().toISOString(), marked_unread: false })
      .eq('conversation_id', convId).eq('user_id', uid)

  if (body.action === 'read') {
    await markRead()
    return res.status(200).json({ ok: true })
  }

  if (body.action === 'reply') {
    const text = String(body.text || '').trim().slice(0, 4000)
    if (!text) return res.status(400).json({ error: 'mensagem vazia' })
    // id gerado no aparelho: se a internet cair no meio e o Android repetir, não duplica
    const id = /^[0-9a-f-]{36}$/i.test(String(body.id || '')) ? String(body.id) : crypto.randomUUID()
    const { error } = await db.from('messages').upsert(
      { id, conversation_id: convId, sender_id: uid, type: 'text', content: text },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    if (error) return res.status(500).json({ error: error.message })
    await markRead() // respondeu = leu (igual ao WhatsApp)
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const result = await deliver(db, await messageJob(db, uid, id), host)
    return res.status(200).json({ ok: true, id, ...result })
  }

  return res.status(400).json({ error: 'ação desconhecida' })
}
