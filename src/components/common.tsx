import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconClock, IconDoubleCheck, IconGroup, IconUser } from '../lib/icons'
import { cx } from '../lib/utils'
import { useBackHandler } from '../lib/back'

export function Avatar({
  url,
  size = 49,
  group = false,
  ring,
  onClick,
}: {
  url?: string | null
  size?: number
  group?: boolean
  ring?: 'unseen' | 'seen' | null
  onClick?: () => void
}) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])
  return (
    <div
      className={cx('avatar', ring && `avatar-ring ${ring}`, onClick && 'clickable')}
      style={{ width: size, height: size, minWidth: size }}
      onClick={onClick}
    >
      {url && !broken ? (
        <img src={url} alt="" onError={() => setBroken(true)} draggable={false} />
      ) : (
        <div className="avatar-fallback">
          {group ? <IconGroup size={size * 0.6} /> : <IconUser size={size * 0.7} />}
        </div>
      )}
    </div>
  )
}

export type MenuItem = { label: string; onClick: () => void; danger?: boolean; icon?: ReactNode } | 'divider'

/** Menu suspenso posicionado a partir de um elemento âncora */
export function Menu({
  anchor,
  items,
  onClose,
  align = 'right',
}: {
  anchor: HTMLElement | { x: number; y: number }
  items: MenuItem[]
  onClose: () => void
  align?: 'left' | 'right'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 })
  useBackHandler(true, onClose) // botão voltar do celular fecha o menu

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let top: number, left: number
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect()
      top = r.bottom + 4
      left = align === 'right' ? r.right - w : r.left
      if (top + h > window.innerHeight - 8) top = r.top - h - 4
    } else {
      top = anchor.y
      left = anchor.x
      if (top + h > window.innerHeight - 8) top = anchor.y - h
      if (left + w > window.innerWidth - 8) left = anchor.x - w
    }
    setPos({ top: Math.max(8, top), left: Math.max(8, Math.min(left, window.innerWidth - w - 8)) })
  }, [anchor, align])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    setTimeout(() => document.addEventListener('mousedown', down), 0)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])

  return createPortal(
    <div className="menu" ref={ref} style={pos} role="menu">
      {items.map((it, i) =>
        it === 'divider' ? (
          <div key={i} className="menu-divider" />
        ) : (
          <button
            key={i}
            className={cx('menu-item', it.danger && 'danger')}
            role="menuitem"
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.icon && <span className="menu-icon">{it.icon}</span>}
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

export function Modal({
  children,
  onClose,
  className,
}: {
  children: ReactNode
  onClose: () => void
  className?: string
}) {
  useBackHandler(true, onClose) // botão voltar do celular fecha a janela
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', className)}>{children}</div>
    </div>,
    document.body,
  )
}

export function Confirm({
  title,
  text,
  confirmLabel = 'OK',
  danger,
  onConfirm,
  onClose,
  extra,
}: {
  title?: string
  text: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
  extra?: ReactNode
}) {
  return (
    <Modal onClose={onClose} className="confirm">
      {title && <h3>{title}</h3>}
      <div className="confirm-text">{text}</div>
      {extra}
      <div className="confirm-actions">
        <button className="btn-outline" onClick={onClose}>
          Cancelar
        </button>
        <button
          className={cx('btn-primary', danger && 'danger')}
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

export function Ticks({ state }: { state: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' }) {
  if (state === 'pending') return <IconClock size={16} className="tick pending" />
  if (state === 'failed') return <span className="tick failed">!</span>
  if (state === 'sent') return <IconCheck size={16} className="tick" />
  return <IconDoubleCheck size={16} className={cx('tick', state === 'read' && 'read')} />
}

export function Spinner({ size = 24 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 44 44">
      <circle cx="22" cy="22" r="20" fill="none" strokeWidth="4" />
    </svg>
  )
}

export function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="panel-header">
      <button className="icon-btn" onClick={onBack} aria-label="Voltar">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M12 4l1.4 1.4L7.8 11H20v2H7.8l5.6 5.6L12 20l-8-8 8-8z" />
        </svg>
      </button>
      <h2>{title}</h2>
    </div>
  )
}

/** Campo editável "inline" (nome, recado) como na tela de perfil */
export function EditableField({
  label,
  value,
  onSave,
  maxLength = 140,
  multiline,
}: {
  label: string
  value: string
  onSave: (v: string) => void
  maxLength?: number
  multiline?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const save = () => {
    setEditing(false)
    if (v.trim() !== value) onSave(v.trim())
  }
  return (
    <div className="editable">
      <div className="editable-label">{label}</div>
      {editing ? (
        <div className="editable-row editing">
          {multiline ? (
            <textarea
              autoFocus
              value={v}
              maxLength={maxLength}
              onChange={(e) => setV(e.target.value)}
              onBlur={save}
              rows={2}
            />
          ) : (
            <input
              autoFocus
              value={v}
              maxLength={maxLength}
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              onBlur={save}
            />
          )}
          <span className="counter">{maxLength - v.length}</span>
          <button className="icon-btn" onMouseDown={(e) => e.preventDefault()} onClick={save} aria-label="Salvar">
            <IconCheck size={20} />
          </button>
        </div>
      ) : (
        <div className="editable-row">
          <span className="editable-value">{value || <em className="muted">—</em>}</span>
          <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Editar">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Toque longo (celular): abre o menu de opções como no app. No iPhone não existe "clique direito",
 * então sem isso não haveria como responder, apagar, reagir etc. pelo toque.
 */
export function useLongPress(onLong: (pos: { x: number; y: number }, el: HTMLElement) => void, ms = 450) {
  const timer = useRef<number | undefined>(undefined)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const cb = useRef(onLong)
  cb.current = onLong
  const cancel = () => window.clearTimeout(timer.current)
  return {
    onTouchStart: (e: React.TouchEvent<HTMLElement>) => {
      const t = e.touches[0]
      if (!t || e.touches.length > 1) return
      start.current = { x: t.clientX, y: t.clientY }
      fired.current = false
      const el = e.currentTarget
      cancel()
      timer.current = window.setTimeout(() => {
        fired.current = true
        navigator.vibrate?.(25)
        cb.current(start.current!, el)
      }, ms)
    },
    onTouchMove: (e: React.TouchEvent<HTMLElement>) => {
      const t = e.touches[0]
      if (t && start.current && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) cancel()
    },
    onTouchEnd: (e: React.TouchEvent<HTMLElement>) => {
      cancel()
      if (fired.current) e.preventDefault() // não dispara o "clique" depois do toque longo
    },
    onTouchCancel: cancel,
  }
}

/** Input de arquivo escondido acionado por função */
export function useFilePicker(accept: string, onPick: (files: File[]) => void, multiple = false) {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    document.body.appendChild(input)
    ref.current = input
    return () => input.remove()
  }, [accept, multiple])
  const cb = useRef(onPick)
  cb.current = onPick
  return () => {
    const input = ref.current
    if (!input) return
    input.value = ''
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      if (files.length) cb.current(files)
    }
    input.click()
  }
}
