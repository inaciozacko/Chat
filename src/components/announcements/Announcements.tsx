import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { useChat } from '../../store/chat'
import { supabase, uploadFile } from '../../lib/supabase'
import type { Announcement } from '../../lib/types'
import { IconClose, IconImage, IconMegaphone, IconTrash } from '../../lib/icons'
import { Confirm, Modal, PanelHeader, Spinner, useFilePicker } from '../common'
import { URL_RE, cx, formatListDate, ts } from '../../lib/utils'

const nowIso = () => new Date().toISOString()

function isLive(a: Announcement) {
  return a.active && (!a.expires_at || ts(a.expires_at) > Date.now())
}

function Linkify({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noreferrer noopener">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

/** O cartão do pop-up (usado para todos e na pré-visualização do admin) */
export function AnnouncementCard({
  a,
  onClose,
  preview,
}: {
  a: Pick<Announcement, 'title' | 'body' | 'image_url' | 'link_url' | 'link_label'>
  onClose: () => void
  preview?: boolean
}) {
  return (
    <Modal onClose={onClose} className="announcement-modal">
      {a.image_url && <img className="announcement-img" src={a.image_url} alt="" />}
      <div className="announcement-content">
        <div className="announcement-kicker">
          <IconMegaphone size={16} /> {preview ? 'Pré-visualização do anúncio' : 'Aviso'}
        </div>
        <h2>{a.title}</h2>
        {a.body && (
          <p className="announcement-body">
            <Linkify text={a.body} />
          </p>
        )}
        <div className="announcement-actions">
          {a.link_url && (
            <a className="btn-outline" href={a.link_url} target="_blank" rel="noreferrer noopener" onClick={onClose}>
              {a.link_label || 'Saiba mais'}
            </a>
          )}
          <button className="btn-primary" onClick={onClose} autoFocus>
            Entendi
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Mostra para o usuário o anúncio ATUAL (só existe um ativo; o mais recente substitui os anteriores),
 * uma única vez por pessoa. Chega em tempo real para quem está online.
 */
// Canal de broadcast "ao vivo": o admin dispara um sinal ao publicar/encerrar e todos os
// clientes online consultam o banco na hora. (O conteúdo continua vindo do banco, protegido por RLS;
// o sinal só diz "verifique agora", então não há risco se alguém mais enviá-lo.)
let liveChannel: RealtimeChannel | null = null

/** Avisa todos os usuários online que o anúncio mudou (chamado pelo painel do admin) */
export function pingAnnouncements() {
  liveChannel?.send({ type: 'broadcast', event: 'changed', payload: { at: Date.now() } })
}

export function AnnouncementPopup() {
  const uid = useChat((s) => s.session?.user.id)
  const [current, setCurrent] = useState<Announcement | null>(null)
  const seq = useRef(0)

  const check = useCallback(async () => {
    if (!uid) return
    const mySeq = ++seq.current // ignora respostas antigas que chegarem fora de ordem
    const { data } = await supabase
      .from('announcements')
      .select('*')
      .eq('active', true)
      .or(`expires_at.is.null,expires_at.gt.${nowIso()}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const latest = data as Announcement | null
    // quem publicou não precisa ver o próprio pop-up
    if (!latest || latest.created_by === uid) {
      if (mySeq === seq.current) setCurrent(null)
      return
    }
    const { data: seen } = await supabase
      .from('announcement_reads')
      .select('announcement_id')
      .eq('announcement_id', latest.id)
      .eq('user_id', uid)
      .maybeSingle()
    if (mySeq === seq.current) setCurrent(seen ? null : latest)
  }, [uid])

  useEffect(() => {
    check()
    // 1) sinal instantâneo do admin (broadcast)
    const live = supabase
      .channel('announcements-live', { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'changed' }, () => check())
      .subscribe()
    liveChannel = live
    // 2) mudanças no banco (postgres_changes), caso o anúncio venha de outro lugar
    const db = supabase
      .channel('announcements-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'announcements' }, () => check())
      .subscribe()
    // 3) rede de segurança: ao voltar para a aba e a cada minuto
    const onVisible = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    const poll = window.setInterval(check, 60000)
    return () => {
      supabase.removeChannel(live)
      supabase.removeChannel(db)
      if (liveChannel === live) liveChannel = null
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.clearInterval(poll)
    }
  }, [check])

  if (!current) return null
  return (
    <AnnouncementCard
      a={current}
      onClose={() => {
        const id = current.id
        setCurrent(null)
        if (uid) supabase.from('announcement_reads').upsert({ announcement_id: id, user_id: uid }).then()
      }}
    />
  )
}

const DURATIONS: [string, number | null][] = [
  ['24 horas', 1],
  ['3 dias', 3],
  ['7 dias', 7],
  ['30 dias', 30],
  ['Sem prazo', null],
]

/** Painel do administrador: criar e gerenciar o anúncio */
export function AnnouncementsPanel() {
  const s = useChat()
  const uid = s.session!.user.id
  const [list, setList] = useState<Announcement[] | null>(null)
  const [views, setViews] = useState<Record<string, number>>({})
  const [totalUsers, setTotalUsers] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [image, setImage] = useState<File | null>(null)
  const [linkLabel, setLinkLabel] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [days, setDays] = useState<number | null>(7)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(false)
  const [confirm, setConfirm] = useState<{ text: string; label: string; action: () => void } | null>(null)
  const pickImage = useFilePicker('image/*', ([f]) => setImage(f))
  const imageUrl = useMemo(() => (image ? URL.createObjectURL(image) : null), [image])

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('announcements')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) {
      s.showToast(
        error.message.includes('announcements')
          ? 'Rode o arquivo supabase/announcements.sql no Supabase para ativar os anúncios.'
          : error.message,
      )
      setList([])
      return
    }
    const rows = (data ?? []) as Announcement[]
    setList(rows)
    if (rows.length) {
      const { data: reads } = await supabase
        .from('announcement_reads')
        .select('announcement_id')
        .in(
          'announcement_id',
          rows.map((r) => r.id),
        )
      const counts: Record<string, number> = {}
      for (const r of reads ?? []) counts[r.announcement_id] = (counts[r.announcement_id] ?? 0) + 1
      setViews(counts)
    }
    const { count } = await supabase.from('profiles').select('id', { count: 'exact', head: true })
    setTotalUsers(count ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const linkOk = !linkUrl.trim() || /^https?:\/\/\S+$/i.test(linkUrl.trim())
  const canPublish = title.trim().length > 0 && linkOk && !busy

  const publish = async () => {
    if (!canPublish) return
    setBusy(true)
    try {
      let image_url: string | null = null
      if (image) image_url = (await uploadFile('media', image, uid)).url
      const { error } = await supabase.from('announcements').insert({
        title: title.trim(),
        body: body.trim(),
        image_url,
        link_url: linkUrl.trim() || null,
        link_label: linkUrl.trim() ? linkLabel.trim() || null : null,
        expires_at: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
      })
      if (error) throw error
      setTitle('')
      setBody('')
      setImage(null)
      setLinkLabel('')
      setLinkUrl('')
      pingAnnouncements() // aparece na hora para quem está online
      s.showToast('Anúncio publicado. Ele substituiu o anterior.')
      load()
    } catch (e) {
      s.showToast('Não foi possível publicar: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const setActive = async (a: Announcement, active: boolean) => {
    const { error } = await supabase.from('announcements').update({ active }).eq('id', a.id)
    if (error) s.showToast(error.message)
    else pingAnnouncements() // ao encerrar, o pop-up some na hora para quem estiver vendo
    load()
  }

  const republish = async (a: Announcement) => {
    // cria uma cópia nova para que todos vejam de novo (quem já viu a original não veria)
    const { error } = await supabase.from('announcements').insert({
      title: a.title,
      body: a.body,
      image_url: a.image_url,
      link_url: a.link_url,
      link_label: a.link_label,
      expires_at: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
    })
    if (error) s.showToast(error.message)
    else {
      pingAnnouncements()
      s.showToast('Anúncio publicado novamente')
    }
    load()
  }

  const remove = async (a: Announcement) => {
    const { error } = await supabase.from('announcements').delete().eq('id', a.id)
    if (error) s.showToast(error.message)
    else pingAnnouncements()
    load()
  }

  const current = list?.find(isLive)
  const history = list?.filter((a) => a !== current) ?? []

  const statusOf = (a: Announcement) =>
    isLive(a)
      ? { label: 'No ar', cls: 'live' }
      : a.active
        ? { label: 'Expirado', cls: 'off' }
        : { label: 'Encerrado', cls: 'off' }

  return (
    <div className="panel">
      <PanelHeader title="Anúncios" onBack={() => s.set({ leftPanel: 'chats' })} />
      <div className="scroll announce-panel">
        <section className="announce-form">
          <div className="announce-note">
            <IconMegaphone size={18} />
            <span>
              Aparece como pop-up para todos os usuários, <b>uma vez por pessoa</b>. Só existe um anúncio no ar: publicar
              um novo substitui o atual.
            </span>
          </div>
          <label>
            Título
            <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Novidade!" />
          </label>
          <label>
            Mensagem
            <textarea
              value={body}
              maxLength={1000}
              rows={4}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Escreva o aviso…"
            />
          </label>
          <div className="announce-image">
            {imageUrl ? (
              <>
                <img src={imageUrl} alt="" />
                <button className="icon-btn small" onClick={() => setImage(null)} aria-label="Remover imagem">
                  <IconClose size={18} />
                </button>
              </>
            ) : (
              <button className="btn-text" onClick={pickImage}>
                <IconImage size={18} /> Adicionar imagem (opcional)
              </button>
            )}
          </div>
          <div className="announce-row">
            <label>
              Texto do botão
              <input
                value={linkLabel}
                maxLength={30}
                onChange={(e) => setLinkLabel(e.target.value)}
                placeholder="Saiba mais"
              />
            </label>
            <label>
              Link do botão (opcional)
              <input
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://..."
                className={cx(!linkOk && 'invalid')}
              />
            </label>
          </div>
          <label>
            Fica no ar por
            <select value={days ?? ''} onChange={(e) => setDays(e.target.value ? +e.target.value : null)}>
              {DURATIONS.map(([label, d]) => (
                <option key={label} value={d ?? ''}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="announce-buttons">
            <button className="btn-outline" disabled={!title.trim()} onClick={() => setPreview(true)}>
              Pré-visualizar
            </button>
            <button
              className="btn-primary"
              disabled={!canPublish}
              onClick={() =>
                current
                  ? setConfirm({
                      text: `Publicar este anúncio? O anúncio atual ("${current.title}") será retirado do ar.`,
                      label: 'Publicar',
                      action: publish,
                    })
                  : publish()
              }
            >
              {busy ? <Spinner size={18} /> : 'Publicar'}
            </button>
          </div>
        </section>

        <div className="section-label">No ar agora</div>
        {list === null ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : current ? (
          <AnnouncementRow
            a={current}
            status={statusOf(current)}
            views={views[current.id] ?? 0}
            totalUsers={totalUsers}
            actions={
              <button className="link-btn" onClick={() => setActive(current, false)}>
                Encerrar
              </button>
            }
          />
        ) : (
          <div className="empty-list">Nenhum anúncio no ar.</div>
        )}

        {history.length > 0 && <div className="section-label">Anteriores</div>}
        {history.map((a) => (
          <AnnouncementRow
            key={a.id}
            a={a}
            status={statusOf(a)}
            views={views[a.id] ?? 0}
            totalUsers={totalUsers}
            actions={
              <>
                <button className="link-btn" onClick={() => republish(a)}>
                  Publicar de novo
                </button>
                <button
                  className="icon-btn small"
                  title="Apagar"
                  onClick={() =>
                    setConfirm({ text: `Apagar o anúncio "${a.title}"?`, label: 'Apagar', action: () => remove(a) })
                  }
                >
                  <IconTrash size={18} />
                </button>
              </>
            }
          />
        ))}
      </div>

      {preview && (
        <AnnouncementCard
          preview
          a={{
            title: title.trim(),
            body: body.trim(),
            image_url: imageUrl,
            link_url: linkUrl.trim() || null,
            link_label: linkLabel.trim() || null,
          }}
          onClose={() => setPreview(false)}
        />
      )}
      {confirm && (
        <Confirm
          text={confirm.text}
          confirmLabel={confirm.label}
          onConfirm={confirm.action}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

function AnnouncementRow({
  a,
  status,
  views,
  totalUsers,
  actions,
}: {
  a: Announcement
  status: { label: string; cls: string }
  views: number
  totalUsers: number | null
  actions: React.ReactNode
}) {
  return (
    <div className="announce-item">
      {a.image_url && <img src={a.image_url} alt="" />}
      <div className="announce-item-body">
        <div className="announce-item-top">
          <span className="announce-item-title">{a.title}</span>
          <span className={cx('announce-status', status.cls)}>{status.label}</span>
        </div>
        {a.body && <div className="announce-item-text">{a.body}</div>}
        <div className="announce-item-meta">
          <span>
            {formatListDate(a.created_at)} · 👁 {views}
            {totalUsers ? ` de ${Math.max(0, totalUsers - 1)}` : ''} visualizaç{views === 1 ? 'ão' : 'ões'}
            {a.expires_at && isLive(a) ? ` · até ${new Date(a.expires_at).toLocaleDateString('pt-BR')}` : ''}
          </span>
          <span className="announce-item-actions">{actions}</span>
        </div>
      </div>
    </div>
  )
}
