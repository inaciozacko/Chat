import { createClient } from '@supabase/supabase-js'

// Valores padrão do projeto. A chave "publishable" é pública por design (vai no JS do navegador);
// a segurança dos dados vem das policies de RLS em supabase/schema.sql.
// Variáveis de ambiente (.env.local ou painel da Vercel), se definidas, têm prioridade.
const DEFAULT_URL = 'https://zxtkkejltqxcdwvgzzvw.supabase.co'
const DEFAULT_KEY = 'sb_publishable_2MUose0f8qsvJBi5r2Nd_w_W3-j6KG9'

const url = ((import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || DEFAULT_URL) as string
const key = (
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim() ||
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ||
  DEFAULT_KEY
) as string

export const isConfigured = Boolean(url && key)

export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 20 } },
})

export type Bucket = 'avatars' | 'media' | 'stickers'

/** Faz upload para <bucket>/<uid>/<uuid>.<ext> e devolve a URL pública. */
export async function uploadFile(bucket: Bucket, file: Blob, userId: string, ext?: string) {
  const extension =
    ext ?? (file instanceof File && file.name.includes('.') ? file.name.split('.').pop()! : mimeExt(file.type))
  const path = `${userId}/${crypto.randomUUID()}.${extension}`
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    cacheControl: '31536000',
    upsert: false,
  })
  if (error) throw error
  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return { path, url: data.publicUrl }
}

function mimeExt(mime: string) {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  }
  return map[mime.split(';')[0]] ?? 'bin'
}
