import { supabase } from './supabase'

/**
 * Notificações push (Web Push), como no WhatsApp: chegam com o app fechado.
 *  1. o aparelho se inscreve no serviço de push do navegador/Android com a chave pública abaixo;
 *  2. a inscrição fica salva no Supabase (tabela push_subscriptions — supabase/push.sql);
 *  3. depois de enviar uma mensagem/ligar, o app chama /api/push (função da Vercel, api/push.js),
 *     que confere tudo no banco e entrega a notificação aos outros participantes;
 *  4. public/sw.js recebe e mostra a notificação.
 */
export const VAPID_PUBLIC_KEY = 'BIr4I2ta0-gG8oFwZDC-90zoPwnRGnlJrdeN_pwyyDZJhn4n3F5y2BqB8rf8ZFHYVBSxEu3fn85CV-0vvBIg7DA'

/** em `npm run dev` não existe /api; defina VITE_PUSH_API para testar contra a Vercel */
const PUSH_API = (import.meta.env.VITE_PUSH_API as string | undefined) || (import.meta.env.DEV ? '' : '/api/push')

export type PushState = 'on' | 'off' | 'denied' | 'unsupported' | 'error'

let registration: Promise<ServiceWorkerRegistration | null> | null = null
let active = false

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** registra o service worker (uma vez). Também é ele que deixa o app "instalável". */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null)
  registration ??= navigator.serviceWorker
    .register('/sw.js')
    .then(async (reg) => {
      await navigator.serviceWorker.ready
      return reg
    })
    .catch((e) => {
      console.warn('Service worker não registrado:', e)
      return null
    })
  return registration
}

/** true quando este aparelho recebe push (aí o app não precisa mostrar notificação própria) */
export function isPushActive() {
  return active
}

/**
 * Deixa a inscrição deste aparelho de acordo com a configuração:
 * ligado → inscreve (se já houver permissão) e salva no Supabase; desligado → remove.
 */
export async function syncPush(enabled: boolean): Promise<PushState> {
  if (!pushSupported()) return 'unsupported'
  const reg = await registerServiceWorker()
  if (!reg) return 'unsupported'
  let sub = await reg.pushManager.getSubscription()

  if (!enabled || Notification.permission !== 'granted') {
    if (sub && !enabled) {
      await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint })
      await sub.unsubscribe().catch(() => {})
    }
    active = false
    return Notification.permission === 'denied' ? 'denied' : 'off'
  }

  try {
    // chave trocada (ou inscrição antiga): refaz
    if (sub && !sameKey(sub.options.applicationServerKey, VAPID_PUBLIC_KEY)) {
      await sub.unsubscribe().catch(() => {})
      sub = null
    }
    sub ??= await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(VAPID_PUBLIC_KEY),
    })
    const json = sub.toJSON()
    const { error } = await supabase.rpc('save_push_subscription', {
      p_endpoint: sub.endpoint,
      p_p256dh: json.keys?.p256dh ?? '',
      p_auth: json.keys?.auth ?? '',
      p_user_agent: navigator.userAgent.slice(0, 250),
    })
    if (error) throw error
    active = true
    return 'on'
  } catch (e) {
    console.warn('Push indisponível:', e)
    active = false
    return 'error'
  }
}

/** pede permissão (precisa ser chamado num clique) e inscreve */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'default') await Notification.requestPermission()
  return syncPush(true)
}

/** ao sair da conta: este aparelho para de receber as notificações dela */
export async function removePush() {
  try {
    const reg = await registerServiceWorker()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint })
      await sub.unsubscribe()
    }
  } catch {
    /* sem rede: a função da Vercel limpa inscrições mortas sozinha */
  }
  active = false
}

/** pede ao servidor para avisar os outros participantes (não espera, não trava o envio) */
export function sendPush(body: { type: 'message'; message_id: string } | { type: 'call' | 'call_end'; call_id: string }) {
  if (!PUSH_API) return
  supabase.auth.getSession().then(({ data }) => {
    const token = data.session?.access_token
    if (!token) return
    fetch(PUSH_API, {
      method: 'POST',
      keepalive: true, // continua mesmo se o app for fechado logo depois de enviar
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).catch(() => {})
  })
}

/** notificação mostrada pelo próprio app (quando o push não está disponível) */
export async function showLocalNotification(title: string, options: NotificationOptions & { data?: unknown }) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const reg = await registerServiceWorker()
  if (reg) return reg.showNotification(title, { badge: '/icons/badge-96.png', icon: '/icons/icon-192.png', ...options })
  new Notification(title, options) // navegador sem service worker
}

/** fecha as notificações de uma conversa (ex.: ao abri-la), como o WhatsApp faz */
export function clearNotifications(tag: string) {
  navigator.serviceWorker?.controller?.postMessage({ type: 'clear', tag })
}

export function markCallHandled(callId: string) {
  navigator.serviceWorker?.controller?.postMessage({ type: 'call-handled', callId })
  clearNotifications(`call-${callId}`)
}

/** toque numa notificação com o app já aberto em segundo plano */
export function onNotificationOpen(cb: (d: { conversationId?: string; callId?: string }) => void) {
  if (!('serviceWorker' in navigator)) return () => {}
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'open-chat') cb(e.data)
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}

function base64UrlToBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function sameKey(key: ArrayBuffer | null, b64: string) {
  if (!key) return false
  const a = new Uint8Array(key)
  const b = base64UrlToBytes(b64)
  return a.length === b.length && a.every((v, i) => v === b[i])
}
