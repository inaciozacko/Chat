/**
 * Contas com acesso ao painel de anúncios.
 * Isto só controla o que aparece na tela; quem realmente pode publicar é decidido
 * no banco pela função public.is_app_admin() (supabase/announcements.sql) — mantenha as duas listas iguais.
 */
export const ADMIN_EMAILS = ['inacio.vitkoski@gmail.com']

export function isAdminEmail(email: string | null | undefined) {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase())
}
