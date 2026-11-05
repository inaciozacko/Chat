import { useState } from 'react'
import { useChat } from '../../store/chat'
import { IconPlus, IconStar, IconSticker, IconWand } from '../../lib/icons'
import { Menu, useFilePicker } from '../common'
import type { Sticker } from '../../lib/types'
import { isAnimatedUrl } from '../../lib/sticker'
import { AnimatedSticker } from './AnimatedSticker'

export function StickerPanel({ onSend }: { onSend: (url: string) => void }) {
  const s = useChat()
  const [menu, setMenu] = useState<{ pos: { x: number; y: number }; st: Sticker } | null>(null)
  const [q, setQ] = useState('')
  const pick = useFilePicker('image/*', ([f]) => s.set({ stickerCreator: { file: f } }))

  const filtered = s.stickers.filter((st) => !q || (st.emoji ?? '').includes(q))
  const favorites = filtered.filter((st) => st.favorite)
  const others = filtered.filter((st) => !st.favorite)

  const grid = (list: Sticker[]) => (
    <div className="sticker-grid">
      {list.map((st) => (
        <button
          key={st.id}
          className="sticker-cell"
          onClick={() => onSend(st.image_url)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ pos: { x: e.clientX, y: e.clientY }, st })
          }}
          title={st.emoji ?? 'Figurinha'}
        >
          {isAnimatedUrl(st.image_url) ? (
            <>
              <AnimatedSticker url={st.image_url} trigger="hover" />
              <span className="sticker-gif-tag">GIF</span>
            </>
          ) : (
            <img src={st.image_url} alt="" loading="lazy" draggable={false} />
          )}
          {st.favorite && <IconStar size={12} className="sticker-fav" />}
        </button>
      ))}
    </div>
  )

  return (
    <div className="sticker-panel">
      <div className="sticker-toolbar">
        <input placeholder="Filtrar por emoji…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-primary small" onClick={pick}>
          <IconWand size={16} /> Criar figurinha
        </button>
      </div>
      <div className="sticker-scroll scroll">
        <div className="sticker-grid">
          <button className="sticker-cell create" onClick={pick} title="Criar figurinha a partir de uma imagem">
            <IconPlus size={30} />
            <span>Criar</span>
          </button>
        </div>
        {favorites.length > 0 && (
          <>
            <div className="sticker-section">
              <IconStar size={14} /> Favoritas
            </div>
            {grid(favorites)}
          </>
        )}
        {others.length > 0 && (
          <>
            <div className="sticker-section">
              <IconSticker size={14} /> Minhas figurinhas
            </div>
            {grid(others)}
          </>
        )}
        {s.stickers.length === 0 && (
          <div className="sticker-empty">
            <IconSticker size={56} />
            <p>Você ainda não tem figurinhas.</p>
            <span className="muted">
              Envie qualquer foto e o fundo será removido automaticamente para virar figurinha.
            </span>
          </div>
        )}
      </div>
      {menu && (
        <Menu
          anchor={menu.pos}
          onClose={() => setMenu(null)}
          items={[
            {
              label: menu.st.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos',
              onClick: () => s.toggleFavoriteSticker(menu.st),
            },
            { label: 'Apagar figurinha', danger: true, onClick: () => s.deleteSticker(menu.st) },
          ]}
        />
      )}
    </div>
  )
}
