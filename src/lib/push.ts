import { supabase } from './supabase'
import { API_BASE, isNative, Zap } from './native'

/**
 * Notificações push, como no WhatsApp: chegam com o app fechado.
 *
 * Navegador / PWA (Web Push):
 *   o navegador se inscreve com a chave pública abaixo → inscrição salva no Supabase (push_subscriptions)
 *   → public/sw.js mostra a notificação.
 * App Android (Firebase):
 *   o app pega o token do Firebase e gera um segredo do aparelho → salvos no Supabase (native_devices)
 *   → a parte nativa monta a notificação com "Responder" e "Marcar como lida", que usam o segredo
 *   para falar com /api/reply sem abrir o app.
 * Em ambos, depois de enviar uma mensagem/ligar, o app chama /api/push (api/push.js), que avisa os outros.
 */
export const VAPID_PUBLIC_KEY = 'BIr4I2ta0-gG8oFwZDC-90zoPwnRGnlJrdeN_pwyyDZJhn4n3F5y2BqB8rf8ZFHYVBSxEu3fn85CV-0vvBIg7DA'

/** em `npm run dev` não existe /api; defina VITE_PUSH_API para testar contra a Vercel */
const PUSH_API = isNative()
  ? `${API_BASE}/api/push`
  : (import.meta.env.VITE_PUSH_API as string | undefined) || (import.meta.env.DEV ? '' : '/api/push')

export type PushState = 'on' | 'off' | 'denied' | 'unsupported' | 'error'
export type PermissionValue = 'granted' | 'denied' | 'default'

let registration: Promise<ServiceWorkerRegistration | null> | null = null
let active = false

export function pushSupported() {
  if (isNative()) return true
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** permissão de notificação deste aparelho (no app Android vem do sistema) */
export async function notificationPermission(): Promise<PermissionValue> {
  if (isNative()) {
    try {
      const p = await Zap.notificationPermission()
      if (p.enabled) return 'granted'
      return p.state === 'denied' ? 'denied' : 'default'
    } catch {
      return 'default'
    }
  }
  return typeof Notification === 'undefined' ? 'denied' : Notification.permission
}

/** registra o service worker (uma vez). Também é ele que deixa o site "instalável". */
export function registerServiceWorker() {
  if (isNative() || !('serviceWorker' in navigator)) return Promise.resolve(null)
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
  if (isNative()) return syncNative(enabled)
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

// ------------------------------------------------------------------ app Android
/** segredo aleatório deste aparelho (o banco guarda só o hash) — autoriza responder pela notificação */
function deviceSecret() {
  const KEY = 'zap-device-secret'
  try {
    let s = localStorage.getItem(KEY)
    if (!s || s.length < 32) {
      s = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
      localStorage.setItem(KEY, s)
    }
    return s
  } catch {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
  }
}

/** passa para a parte nativa quem está logado (usado pelas notificações e pelo modo emergência) */
export async function setNativeSession(userId: string) {
  if (!isNative()) return
  await Zap.setSession({ apiBase: API_BASE, secret: deviceSecret(), userId }).catch(() => {})
}

async function syncNative(enabled: boolean): Promise<PushState> {
  const uid = (await supabase.auth.getSession()).data.session?.user.id
  if (!uid) return 'off'
  if (!enabled) {
    await removeNative(false)
    return 'off'
  }
  const perm = await notificationPermission()
  if (perm !== 'granted') {
    active = false
    return perm === 'denied' ? 'denied' : 'off'
  }
  try {
    const { token } = await Zap.getPushToken()
    const secret = deviceSecret()
    const { error } = await supabase.rpc('save_native_device', { p_token: token, p_secret: secret })
    if (error) throw error
    await Zap.setSession({ apiBase: API_BASE, secret, userId: uid })
    active = true
    return 'on'
  } catch (e) {
    console.warn('Push (Firebase) indisponível:', e)
    active = false
    return 'error'
  }
}

async function removeNative(signOut: boolean) {
  try {
    const { token } = await Zap.getPushToken()
    await supabase.rpc('delete_native_device', { p_token: token })
  } catch {
    /* sem Firebase/sem rede: a função da Vercel limpa aparelhos mortos sozinha */
  }
  if (signOut) await Zap.clearSession().catch(() => {})
  active = false
}

// ------------------------------------------------------------------ comum
/** pede permissão (precisa ser chamado num clique) e inscreve */
export async function enablePush(): Promise<PushState> {
  if (isNative()) {
    await Zap.requestNotificationPermission().catch(() => null)
    return syncPush(true)
  }
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'default') await Notification.requestPermission()
  return syncPush(true)
}

/** ao sair da conta: este aparelho para de receber as notificações dela */
export async function removePush() {
  if (isNative()) return removeNative(true)
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

type PushRequest =
  | { type: 'message'; message_id: string }
  | { type: 'call' | 'call_end'; call_id: string }
  | { type: 'mesh'; envelope_id: string }

/** pede ao servidor para avisar os outros participantes (não espera, não trava o envio) */
export function sendPush(body: PushRequest) {
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
  if (isNative() || !('Notification' in window) || Notification.permission !== 'granted') return
  const reg = await registerServiceWorker()
  if (reg) return reg.showNotification(title, { badge: '/icons/badge-96.png', icon: '/icons/icon-192.png', ...options })
  new Notification(title, options) // navegador sem service worker
}

/** fecha as notificações de uma conversa (ex.: ao abri-la), como o WhatsApp faz */
export function clearNotifications(tag: string) {
  if (isNative()) {
    Zap.clearNotifications(tag.startsWith('call-') ? { callId: tag.slice(5) } : { conversationId: tag }).catch(() => {})
    return
  }
  navigator.serviceWorker?.controller?.postMessage({ type: 'clear', tag })
}

export function markCallHandled(callId: string) {
  if (!isNative()) navigator.serviceWorker?.controller?.postMessage({ type: 'call-handled', callId })
  clearNotifications(`call-${callId}`)
}

type OpenData = { conversationId?: string; callId?: string; action?: string; mesh?: boolean }

/** toque numa notificação (app aberto em segundo plano, ou recém-aberto por ela) */
export function onNotificationOpen(cb: (d: OpenData) => void) {
  if (isNative()) {
    const h = Zap.addListener('notificationOpen', cb)
    return () => void h.then((x) => x.remove())
  }
  if (!('serviceWorker' in navigator)) return () => {}
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'open-chat') cb(e.data)
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}

/** token do Firebase trocado pelo sistema: registra o novo */
export function onPushTokenChange(cb: () => void) {
  if (!isNative()) return () => {}
  const h = Zap.addListener('pushToken', cb)
  return () => void h.then((x) => x.remove())
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
