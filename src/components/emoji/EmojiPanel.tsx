import { useMemo, useRef, useState } from 'react'
import EmojiPicker, { EmojiStyle, Theme } from 'emoji-picker-react'
import { PICKER_GROUPS } from '../../lib/emojiPickerData'
import { charFromCode, Emoji, staticEmojiUrl } from './AnimatedEmoji'
import { cx } from '../../lib/utils'

/**
 * Painel de emojis no estilo do Microsoft Teams: emojis 3D que se mexem ao passar o mouse,
 * categorias, recentes e busca (em português e inglês). A aba "Todos" mostra a lista completa.
 */

const LABELS: Record<string, string> = {
  recent: 'Recentes',
  smileys: 'Carinhas e pessoas',
  animals: 'Animais e natureza',
  food: 'Comidas e bebidas',
  travel: 'Viagens e lugares',
  activities: 'Atividades',
  objects: 'Objetos',
  symbols: 'Símbolos',
  flags: 'Bandeiras',
  all: 'Todos os emojis',
}
const TAB_ICON: Record<string, string> = {
  recent: '🕒',
  smileys: '😀',
  animals: '🐶',
  food: '🍕',
  travel: '✈️',
  activities: '⚽',
  objects: '💡',
  symbols: '❤️',
  flags: '🏁',
}

// busca em português → termos das etiquetas (em inglês) do catálogo
const PT: Record<string, string> = {
  rir: 'joy rofl laugh grin smile',
  risada: 'joy rofl laugh grin',
  kkk: 'joy rofl laugh',
  feliz: 'smile grin blush happy',
  sorriso: 'smile grin',
  amor: 'heart love kiss',
  coracao: 'heart',
  beijo: 'kiss',
  triste: 'cry sad pleading frown disappointed',
  chorar: 'cry crying sob',
  choro: 'cry crying',
  raiva: 'rage angry cursing triumph',
  bravo: 'rage angry',
  medo: 'scream fear anxious',
  susto: 'scream surprise shock mind-blown',
  surpreso: 'surprise astonished open-mouth shock',
  pensando: 'thinking',
  duvida: 'thinking',
  sono: 'sleep yawn',
  dormir: 'sleep',
  doente: 'sick thermometer mask vomit',
  vergonha: 'blush flushed see-no-evil',
  legal: 'sunglasses cool thumbs',
  joia: 'thumbs-up',
  joinha: 'thumbs-up',
  ok: 'ok thumbs-up',
  palmas: 'clap',
  maos: 'hands clap pray',
  obrigado: 'pray thank-you folded-hands',
  por: 'please pray',
  tchau: 'wave',
  oi: 'wave',
  forca: 'muscle flex strong',
  festa: 'party partying confetti',
  parabens: 'party birthday cake confetti',
  aniversario: 'birthday cake gift',
  presente: 'gift',
  fogo: 'fire',
  olhos: 'eyes',
  cachorro: 'dog',
  gato: 'cat',
  macaco: 'monkey',
  passaro: 'bird',
  peixe: 'fish',
  flor: 'rose flower blossom tulip',
  sol: 'sun',
  chuva: 'rain',
  estrela: 'star',
  arco: 'rainbow',
  pizza: 'pizza',
  bolo: 'cake',
  cerveja: 'beer',
  cafe: 'hot-beverage coffee',
  comida: 'food pizza burger',
  dinheiro: 'money',
  musica: 'music note',
  bola: 'ball soccer',
  futebol: 'soccer',
  carro: 'automobile car',
  aviao: 'airplane',
  casa: 'house',
  caveira: 'skull',
  morto: 'skull',
  fantasma: 'ghost',
  palhaco: 'clown',
  coco: 'poop',
  cem: '100',
  bandeira: 'flag',
}

type Item = { code: string; char: string; tags: string }

const GROUPS: { key: string; items: Item[] }[] = PICKER_GROUPS.map(([key, data]) => ({
  key,
  items: data
    .split(/\s+/)
    .filter((entry) => /^[0-9a-f]+(_[0-9a-f]+)*(:|$)/.test(entry)) // ignora qualquer entrada malformada
    .map((entry) => {
      const [code, tags = ''] = entry.split(':')
      return { code, char: charFromCode(code), tags: tags.replace(/,/g, ' ') }
    }),
}))

const RECENT_KEY = 'zap-recent-emoji'
function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(v) ? v.slice(0, 24) : []
  } catch {
    return []
  }
}
function pushRecent(char: string) {
  const next = [char, ...loadRecent().filter((c) => c !== char)].slice(0, 24)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* modo privado */
  }
  return next
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

export function EmojiPanel({
  onPick,
  theme,
  height = 320,
}: {
  onPick: (emoji: string) => void
  theme: 'light' | 'dark'
  height?: number
}) {
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<string>('smileys')
  const [recent, setRecent] = useState<string[]>(loadRecent)
  const scroller = useRef<HTMLDivElement>(null)
  const sections = useRef<Record<string, HTMLElement | null>>({})

  const pick = (char: string) => {
    setRecent(pushRecent(char))
    onPick(char)
  }

  const results = useMemo(() => {
    const q = norm(query)
    if (!q) return null
    const terms = [q, ...Object.entries(PT).flatMap(([pt, en]) => (pt.startsWith(q) || q.startsWith(pt) ? en.split(' ') : []))]
    const out: Item[] = []
    for (const g of GROUPS)
      for (const it of g.items) if (terms.some((t) => it.tags.includes(t))) out.push(it)
    return out
  }, [query])

  const goTo = (key: string) => {
    setTab(key)
    setQuery('')
    if (key === 'all') return
    requestAnimationFrame(() => {
      const el = sections.current[key]
      if (el && scroller.current) scroller.current.scrollTop = el.offsetTop - scroller.current.offsetTop
    })
  }

  // destaca a categoria visível enquanto rola
  const onScroll = () => {
    const sc = scroller.current
    if (!sc) return
    let current = tab
    for (const key of ['recent', ...GROUPS.map((g) => g.key)]) {
      const el = sections.current[key]
      if (el && el.offsetTop - sc.offsetTop <= sc.scrollTop + 8) current = key
    }
    if (current !== tab) setTab(current)
  }

  const tabs = [...(recent.length ? ['recent'] : []), ...GROUPS.map((g) => g.key)]

  return (
    <div className="emoji-panel" style={{ height }}>
      {tab !== 'all' && (
        <div className="emoji-panel-top">
          <input
            className="emoji-search"
            placeholder="Pesquisar emoji (ex.: rir, amor, festa)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      <div className="emoji-tabs">
        {tabs.map((k) => (
          <button key={k} className={cx(tab === k && !query && 'on')} onClick={() => goTo(k)} title={LABELS[k]}>
            <img src={staticEmojiUrl(TAB_ICON[k])} alt="" draggable={false} />
          </button>
        ))}
        <button className={cx('emoji-tab-all', tab === 'all' && 'on')} onClick={() => goTo('all')} title={LABELS.all}>
          Todos
        </button>
      </div>

      {tab === 'all' ? (
        <div className="emoji-all">
          <EmojiPicker
            onEmojiClick={(e) => pick(e.emoji)}
            theme={theme === 'dark' ? Theme.DARK : Theme.LIGHT}
            emojiStyle={EmojiStyle.GOOGLE}
            searchPlaceholder="Pesquisar emoji (em inglês)"
            previewConfig={{ showPreview: false }}
            lazyLoadEmojis
            width="100%"
            height="100%"
          />
        </div>
      ) : (
        <div className="emoji-scroll" ref={scroller} onScroll={query ? undefined : onScroll}>
          {results ? (
            results.length ? (
              <div className="emoji-grid">
                {results.map((it) => (
                  <EmojiButton key={it.code} char={it.char} title={it.tags} onPick={pick} />
                ))}
              </div>
            ) : (
              <div className="emoji-empty">
                Nenhum emoji animado encontrado.{' '}
                <button className="btn-text" onClick={() => goTo('all')}>
                  Ver todos os emojis
                </button>
              </div>
            )
          ) : (
            <>
              {recent.length > 0 && (
                <section ref={(el) => void (sections.current.recent = el)}>
                  <h4>{LABELS.recent}</h4>
                  <div className="emoji-grid">
                    {recent.map((c) => (
                      <EmojiButton key={c} char={c} onPick={pick} />
                    ))}
                  </div>
                </section>
              )}
              {GROUPS.map((g) => (
                <section key={g.key} ref={(el) => void (sections.current[g.key] = el)}>
                  <h4>{LABELS[g.key]}</h4>
                  <div className="emoji-grid">
                    {g.items.map((it) => (
                      <EmojiButton key={it.code} char={it.char} title={it.tags} onPick={pick} />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function EmojiButton({ char, title, onPick }: { char: string; title?: string; onPick: (c: string) => void }) {
  return (
    <button className="emoji-cell" onClick={() => onPick(char)} title={title?.split(' ')[0]?.replace(/-/g, ' ')}>
      <Emoji char={char} mode="hover" />
    </button>
  )
}
