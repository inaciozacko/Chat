/* =====================================================================
   Zap — service worker
   - Notificações push (chegam com o app fechado), agrupadas por conversa como no WhatsApp
   - Ligações: a notificação "toca" de novo a cada poucos segundos até atender/recusar/desistir
   - Toque na notificação abre direto a conversa
   - Cache leve: o app abre mesmo sem internet (mostra o que já foi carregado)
   ===================================================================== */

const CACHE = 'zap-v1'
const ICON = '/icons/icon-192.png'
const BADGE = '/icons/badge-96.png'

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['/', ICON, BADGE]))
      .catch(() => {}),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

// ------------------------------------------------------------------ cache
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  // páginas: sempre tenta a internet primeiro (pega a versão nova do app); sem internet, usa a última salva
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put('/', copy))
          }
          return res
        })
        .catch(async () => (await caches.match('/')) || Response.error()),
    )
    return
  }

  // arquivos do build têm hash no nome (nunca mudam): cache primeiro
  if (/^\/assets\/.+\.(js|css|svg|png|webp|woff2?)$/.test(url.pathname) || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((c) => c.put(req, copy))
            }
            return res
          }),
      ),
    )
  }
})

// ------------------------------------------------------------------ push
/** ligações que já foram atendidas / recusadas / perdidas: para de tocar */
const stoppedCalls = new Set()

self.addEventListener('push', (event) => {
  let d = {}
  try {
    d = event.data ? event.data.json() : {}
  } catch {
    d = { kind: 'message', title: 'Zap', line: event.data ? event.data.text() : 'Nova mensagem' }
  }
  event.waitUntil(handlePush(d))
})

async function appIsOpen() {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  return wins.some((w) => w.visibilityState === 'visible')
}

async function handlePush(d) {
  if (d.kind === 'call_missed') {
    // a ligação acabou: para de tocar e tira a notificação dela, com o app aberto ou não
    stoppedCalls.add(d.callId)
    for (const n of await self.registration.getNotifications({ tag: `call-${d.callId}` })) n.close()
  }
  // app aberto na tela: o próprio app avisa (som, contador, tela de chamada) — igual ao WhatsApp
  if (await appIsOpen()) return

  if (d.kind === 'call') return ringCall(d)
  if (d.kind === 'call_missed') return missedCall(d)
  return showMessage(d)
}

async function showMessage(d) {
  const tag = d.conversationId || 'zap'
  const [prev] = await self.registration.getNotifications({ tag })
  const old = (prev && prev.data) || {}
  const ids = old.ids || []
  if (d.messageId && ids.includes(d.messageId)) return // já mostrada

  const lines = [...(old.lines || []), d.line || 'Nova mensagem'].slice(-6)
  const count = (old.count || 0) + 1
  const title = count > 1 ? `${d.title} (${count} mensagens)` : d.title || 'Zap'

  await self.registration.showNotification(title, {
    body: lines.join('\n'),
    icon: d.icon || ICON,
    badge: BADGE,
    image: count === 1 && d.image ? d.image : undefined,
    tag,
    renotify: true,
    timestamp: d.ts || Date.now(),
    vibrate: [90, 60, 90],
    data: {
      kind: 'message',
      conversationId: d.conversationId,
      url: d.conversationId ? `/?c=${d.conversationId}` : '/',
      lines,
      count,
      ids: [...ids, d.messageId].filter(Boolean).slice(-50),
    },
  })
}

async function ringCall(d) {
  const tag = `call-${d.callId}`
  const show = (renotify) =>
    self.registration.showNotification(d.title || 'Zap', {
      body: d.line,
      icon: d.icon || ICON,
      badge: BADGE,
      tag,
      renotify,
      requireInteraction: true,
      timestamp: d.ts || Date.now(),
      vibrate: [700, 350, 700, 350, 700],
      actions: [{ action: 'answer', title: 'Atender' }],
      data: { kind: 'call', callId: d.callId, conversationId: d.conversationId, url: `/?c=${d.conversationId}&call=${d.callId}` },
    })

  await show(true)
  // "toca" de novo a cada 4 s por até ~40 s, enquanto ninguém mexer na notificação
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 4000))
    if (stoppedCalls.has(d.callId)) return
    const [n] = await self.registration.getNotifications({ tag })
    if (!n) return // usuário tocou ou dispensou
    if (await appIsOpen()) return // abriu o app: a tela de chamada assume
    await show(true)
  }
}

async function missedCall(d) {
  stoppedCalls.add(d.callId)
  for (const n of await self.registration.getNotifications({ tag: `call-${d.callId}` })) n.close()

  const tag = `missed-${d.conversationId}`
  const [prev] = await self.registration.getNotifications({ tag })
  const count = ((prev && prev.data && prev.data.count) || 0) + 1
  await self.registration.showNotification(d.title || 'Zap', {
    body: count > 1 ? `${count} chamadas perdidas` : d.line,
    icon: d.icon || ICON,
    badge: BADGE,
    tag,
    renotify: true,
    timestamp: d.ts || Date.now(),
    data: { kind: 'call_missed', conversationId: d.conversationId, url: `/?c=${d.conversationId}`, count },
  })
}

// ------------------------------------------------------------------ cliques
self.addEventListener('notificationclick', (event) => {
  const n = event.notification
  const d = n.data || {}
  n.close()
  if (d.callId) stoppedCalls.add(d.callId)
  event.waitUntil(openApp(d))
})

self.addEventListener('notificationclose', (event) => {
  const d = event.notification.data || {}
  if (d.callId) stoppedCalls.add(d.callId) // dispensou a chamada: para de tocar
})

async function openApp(d) {
  const target = new URL(d.url || '/', self.location.origin).href
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const win = wins.find((w) => new URL(w.url).origin === self.location.origin)
  if (win) {
    try {
      await win.focus()
    } catch {
      /* alguns navegadores não deixam focar */
    }
    win.postMessage({ type: 'open-chat', conversationId: d.conversationId, callId: d.callId })
    return
  }
  await self.clients.openWindow(target)
}

// a página pede para limpar as notificações de uma conversa quando ela é lida
self.addEventListener('message', (event) => {
  const msg = event.data || {}
  if (msg.type === 'clear' && msg.tag) {
    event.waitUntil(
      self.registration.getNotifications({ tag: msg.tag }).then((ns) => ns.forEach((n) => n.close())),
    )
  }
  if (msg.type === 'call-handled' && msg.callId) stoppedCalls.add(msg.callId)
})
