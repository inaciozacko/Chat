import { useEffect, useMemo, useRef, useState } from 'react'
import { useMesh, type MeshContact, type MeshMsg } from '../../lib/mesh/mesh'
import { isNative } from '../../lib/native'
import { Avatar, PanelHeader } from '../common'
import { cx } from '../../lib/utils'

/**
 * Modo emergência: conversar SEM internet com quem tem o Zap.
 * Usado dentro do app (painel lateral) e sozinho, quando o app abre sem internet.
 */
export function EmergencyPanel({ onBack, standalone = false }: { onBack?: () => void; standalone?: boolean }) {
  const m = useMesh()
  const [peer, setPeer] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(t)
  }, [toast])

  const contacts = useMemo(() => {
    const last: Record<string, MeshMsg> = {}
    for (const x of m.msgs) last[x.peer] = x
    return Object.values(m.contacts)
      .filter((c) => c.id !== m.uid && c.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => (last[b.id]?.ts ?? 0) - (last[a.id]?.ts ?? 0) || a.name.localeCompare(b.name))
      .map((c) => ({ ...c, last: last[c.id] }))
  }, [m.contacts, m.msgs, m.uid, q])

  const sendAll = async (text: string, withLocation = false) => {
    const ids = Object.keys(m.contacts).filter((id) => id !== m.uid)
    if (!ids.length) return setToast('Nenhum contato salvo ainda. Abra o Zap uma vez com internet.')
    if (!confirm(`Enviar "${text}" para todos os ${ids.length} contatos?`)) return
    setBusy(true)
    try {
      const loc = withLocation ? await getLocation() : undefined
      const r = await m.send(ids, { text: loc ? `${text}\n${locText(loc)}` : text, loc })
      setToast(
        `Enviada para ${r.ok} contato(s).` +
          (r.missing.length ? ` ${r.missing.length} ainda não abriram a versão nova do app com internet.` : ''),
      )
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (peer) return <Thread peer={m.contacts[peer] ?? { id: peer, name: 'Contato' }} onBack={() => setPeer(null)} />

  return (
    <div className={cx('panel emg', standalone && 'emg-standalone')}>
      {standalone ? (
        <div className="panel-header">
          <h2>🆘 Modo emergência</h2>
        </div>
      ) : (
        <PanelHeader title="🆘 Modo emergência" onBack={onBack ?? (() => {})} />
      )}
      <div className="scroll">
        {standalone && (
          <div className="emg-offline">
            {m.online ? (
              <>
                A internet voltou.{' '}
                <button className="link-btn" onClick={() => location.reload()}>
                  Abrir o Zap normal
                </button>
              </>
            ) : (
              'Sem internet. Você ainda pode conversar com quem tem o Zap por perto.'
            )}
          </div>
        )}

        {!isNative() ? (
          <div className="emg-card">
            <strong>Disponível no app Android</strong>
            <p>O modo emergência usa o Bluetooth e o Wi-Fi do celular para conversar sem internet. Instale o app Zap no Android.</p>
          </div>
        ) : (
          <div className={cx('emg-card', m.status.running && 'on')}>
            <div className="emg-row">
              <div className="emg-dot" />
              <div className="grow">
                <strong>{m.status.running ? 'Procurando celulares por perto' : 'Rede sem internet desligada'}</strong>
                <div className="muted small">
                  {m.status.running
                    ? `${m.status.peers === 0 ? 'Nenhum celular conectado ainda' : `${m.status.peers} celular(es) conectado(s)`}` +
                      (m.status.carrying ? ` · levando ${m.status.carrying} mensagem(ns) de outras pessoas` : '')
                    : 'Ligue para enviar e receber por Bluetooth/Wi-Fi'}
                </div>
              </div>
              <button className={cx('toggle', m.status.running && 'on')} onClick={() => (m.status.running ? m.stop() : m.start())} role="switch" aria-checked={m.status.running}>
                <span />
              </button>
            </div>
            <div className="muted small emg-net">
              Internet: {m.online ? (m.syncing ? 'sincronizando…' : 'conectado ✓') : 'sem conexão'}
            </div>
            {m.error && <div className="emg-error">{m.error}</div>}
          </div>
        )}

        <div className="emg-quick">
          <button disabled={busy} onClick={() => sendAll('✅ Estou bem')}>✅ Estou bem</button>
          <button disabled={busy} onClick={() => sendAll('🆘 Preciso de ajuda')}>🆘 Preciso de ajuda</button>
          <button disabled={busy} onClick={() => sendAll('📍 Estou aqui', true)}>📍 Minha localização</button>
        </div>
        <div className="muted small emg-hint">Os atalhos enviam para todos os seus contatos.</div>

        <div className="search-bar">
          <div className="search-input">
            <input placeholder="Procurar contato" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>

        {contacts.length === 0 && (
          <div className="muted small emg-empty">
            Seus contatos aparecem aqui depois que você abrir o Zap com internet ao menos uma vez.
          </div>
        )}
        {contacts.map((c) => (
          <button key={c.id} className="emg-contact" onClick={() => { setPeer(c.id); m.markRead(c.id) }}>
            <Avatar url={m.online ? c.avatar : null} size={44} />
            <div className="grow">
              <div className="emg-contact-top">
                <span className="emg-name">{c.name}</span>
                {c.last && <span className="muted small">{time(c.last.ts)}</span>}
              </div>
              <div className="emg-contact-bottom">
                <span className="muted small ellipsis">
                  {c.last ? (c.last.dir === 'out' ? 'Você: ' : '') + (c.last.unreadable ? '🔒 mensagem protegida' : c.last.text.split('\n')[0]) : 'Toque para escrever'}
                </span>
                {(m.unread[c.id] ?? 0) > 0 && <span className="unread-badge">{m.unread[c.id]}</span>}
              </div>
            </div>
          </button>
        ))}

        <div className="emg-about muted small">
          <strong>Como funciona:</strong> sem internet, a mensagem pula de celular em celular (Bluetooth/Wi-Fi, uns 30–100 m
          entre cada um) e também viaja no bolso de quem se desloca, até chegar ao destino. Quando qualquer celular que a
          carregue encontrar internet, ela é entregue na hora. Tudo vai criptografado: quem carrega não consegue ler.
          ✓ = saiu daqui · ☁ = chegou à internet · ✓✓ = entregue.
        </div>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function Thread({ peer, onBack }: { peer: MeshContact; onBack: () => void }) {
  const m = useMesh()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const msgs = useMemo(() => m.msgs.filter((x) => x.peer === peer.id), [m.msgs, peer.id])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
    if ((m.unread[peer.id] ?? 0) > 0) m.markRead(peer.id)
  }, [msgs.length, peer.id, m])

  const send = async (withLocation = false) => {
    const t = text.trim()
    if (!t && !withLocation) return
    setBusy(true)
    setErr(null)
    try {
      const loc = withLocation ? await getLocation() : undefined
      const body = loc ? `${t || '📍 Estou aqui'}\n${locText(loc)}` : t
      const r = await m.send([peer.id], { text: body, loc })
      if (r.missing.length) setErr(`${peer.name} ainda não abriu a versão nova do Zap com internet, então ainda não dá para mandar mensagem protegida para ele(a).`)
      else setText('')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel emg">
      <PanelHeader title={peer.name} onBack={onBack} />
      <div className="scroll emg-thread">
        <div className="emg-banner">🆘 Conversa de emergência — funciona sem internet. Máx. 500 caracteres.</div>
        {msgs.map((x) => (
          <div key={x.id} className={cx('emg-msg', x.dir)}>
            {x.unreadable ? (
              <em>🔒 Mensagem protegida que este aparelho não consegue abrir (foi enviada para outro aparelho seu).</em>
            ) : (
              <MsgText text={x.text} loc={x.loc} />
            )}
            <div className="emg-meta">
              {x.dir === 'in' && x.verified === false && <span title="Assinatura não conferida">⚠️ remetente não confirmado · </span>}
              {time(x.ts)}
              {x.dir === 'out' && (
                <span className={cx('emg-tick', x.status)}>{x.status === 'delivered' ? ' ✓✓' : x.status === 'uploaded' ? ' ☁' : ' ✓'}</span>
              )}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {err && <div className="emg-error emg-thread-error">{err}</div>}
      <div className="emg-composer">
        <button className="icon-btn" title="Enviar minha localização (GPS funciona sem internet)" disabled={busy} onClick={() => send(true)}>
          📍
        </button>
        <textarea
          value={text}
          maxLength={500}
          rows={1}
          placeholder="Mensagem de emergência"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="emg-send" disabled={busy || !text.trim()} onClick={() => send()}>
          Enviar
        </button>
      </div>
    </div>
  )
}

function MsgText({ text, loc }: { text: string; loc?: MeshMsg['loc'] }) {
  const lines = text.split('\n').filter((l) => !(loc && l.startsWith('📍 ') && l.includes('maps')))
  return (
    <div className="emg-text">
      {lines.join('\n')}
      {loc && (
        <a className="emg-loc" href={`https://maps.google.com/?q=${loc.lat},${loc.lng}`} target="_blank" rel="noreferrer">
          📍 {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}
          {loc.acc ? ` (±${Math.round(loc.acc)} m)` : ''} — abrir no mapa
        </a>
      )}
    </div>
  )
}

/** GPS do celular: funciona sem internet */
function getLocation(): Promise<{ lat: number; lng: number; acc?: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Localização indisponível neste aparelho'))
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: p.coords.accuracy }),
      () => reject(new Error('Não consegui pegar sua localização. Ligue o GPS/Localização e tente de novo.')),
      { enableHighAccuracy: true, timeout: 30_000, maximumAge: 120_000 },
    )
  })
}

function locText(l: { lat: number; lng: number; acc?: number }) {
  return `📍 ${l.lat}, ${l.lng}${l.acc ? ` (±${Math.round(l.acc)} m)` : ''} https://maps.google.com/?q=${l.lat},${l.lng}`
}

function time(ts: number) {
  const d = new Date(ts)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
