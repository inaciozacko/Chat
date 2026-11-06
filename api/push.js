// Função da Vercel: POST /api/push
// Envia notificações para os aparelhos dos outros participantes (navegador/PWA e app Android),
// como o WhatsApp: chegam com o app fechado e a tela desligada.
//
// Quem chama é o próprio app, logo depois de enviar a mensagem / iniciar a ligação:
//   { type: 'message',  message_id }   → "Fulano: oi"
//   { type: 'call',     call_id }      → "Chamada de voz recebida" (toca até atender)
//   { type: 'call_end', call_id }      → troca a chamada por "Chamada perdida"
//   { type: 'mesh',     envelope_id }  → "Mensagem de emergência" depositada por outro aparelho
// O servidor confere tudo no banco (quem pede precisa ser o autor / quem ligou),
// então ninguém consegue disparar notificação falsa.
//
// Variáveis de ambiente na Vercel:
//   VAPID_PRIVATE_KEY          (obrigatória) — notificações do navegador/PWA
//   SUPABASE_SECRET_KEY        (obrigatória) — chave secreta sb_secret_... (ou SUPABASE_SERVICE_ROLE_KEY)
//   FIREBASE_SERVICE_ACCOUNT   (app Android) — JSON da conta de serviço do Firebase

import { adminClient, callJob, cors, deliver, meshJob, messageJob, missingConfig, readBody } from './_lib/core.js'

export default async function handler(req, res) {
  if (cors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' })

  const miss = missingConfig()
  if (miss.length) return res.status(500).json({ error: `Faltam ${miss.join(' e ')} nas variáveis da Vercel` })

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'sem login' })
  const body = readBody(req)
  if (!body) return res.status(400).json({ error: 'corpo inválido' })

  const db = adminClient()
  const { data: auth } = await db.auth.getUser(token)
  const me = auth?.user
  if (!me) return res.status(401).json({ error: 'login inválido' })

  let job = null
  try {
    if (body.type === 'message') job = await messageJob(db, me.id, String(body.message_id || ''))
    else if (body.type === 'call' || body.type === 'call_end') job = await callJob(db, me.id, String(body.call_id || ''), body.type)
    else if (body.type === 'mesh') job = await meshJob(db, String(body.envelope_id || ''))
    else return res.status(400).json({ error: 'tipo desconhecido' })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host
  return res.status(200).json(await deliver(db, job, host))
}
