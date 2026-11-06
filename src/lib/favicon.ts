/**
 * Ícone da aba do navegador.
 *  - sem mensagens: logo normal (balão índigo com raio) — /favicon.svg
 *  - com mensagens: o mesmo balão com o número de CONVERSAS não lidas dentro ("9+" acima de 9)
 * Gerado em canvas (PNG) para funcionar em todos os navegadores.
 */
const BUBBLE =
  'M32 4C16.5 4 4 15.6 4 30c0 7.4 3.3 14.1 8.7 18.8L10 60l12.6-5.6c2.9.9 6.1 1.4 9.4 1.4 15.5 0 28-11.6 28-26S47.5 4 32 4z'
const DEFAULT_ICON = '/favicon.svg'

let lastLabel: string | null = null

function iconLinks(): HTMLLinkElement[] {
  let links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
  if (!links.length) {
    const l = document.createElement('link')
    l.rel = 'icon'
    document.head.appendChild(l)
    links = [l]
  }
  return links
}

function setIcon(href: string, type: string) {
  for (const l of iconLinks()) {
    l.type = type
    l.href = href
  }
}

export function setFaviconCount(count: number) {
  const label = count <= 0 ? '' : count > 9 ? '9+' : String(count)
  if (label === lastLabel) return
  lastLabel = label
  if (!label) return setIcon(DEFAULT_ICON, 'image/svg+xml')

  const scale = 2 // desenha em 128px para ficar nítido em telas de alta densidade
  const c = document.createElement('canvas')
  c.width = c.height = 64 * scale
  const ctx = c.getContext('2d')
  if (!ctx) return
  ctx.scale(scale, scale)
  const grad = ctx.createLinearGradient(4, 4, 60, 60) // mesmo degradê índigo do /favicon.svg
  grad.addColorStop(0, '#6f7cd2')
  grad.addColorStop(1, '#4f5cae')
  ctx.fillStyle = grad
  ctx.fill(new Path2D(BUBBLE))
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 ${label.length > 1 ? 29 : 38}px "Segoe UI", Roboto, Arial, sans-serif`
  ctx.fillText(label, label.length > 1 ? 31 : 32, 32)
  setIcon(c.toDataURL('image/png'), 'image/png')
}
