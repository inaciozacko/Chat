import { useEffect, useRef } from 'react'

/**
 * Botão "voltar" do Android.
 * Cada coisa aberta por cima (janela, menu, painel de emojis, foto...) se registra aqui enquanto está aberta;
 * o voltar fecha a mais recente. Sem nada registrado, o App decide (fechar conversa, voltar para a lista...).
 */
const stack: { id: number; close: () => void }[] = []
let seq = 0

export function useBackHandler(active: boolean, close: () => void) {
  const ref = useRef(close)
  useEffect(() => {
    ref.current = close
  })
  useEffect(() => {
    if (!active) return
    const id = ++seq
    stack.push({ id, close: () => ref.current() })
    return () => {
      const i = stack.findIndex((h) => h.id === id)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [active])
}

/** fecha a coisa aberta mais recente; devolve false se não havia nada */
export function closeTopmost(): boolean {
  const top = stack[stack.length - 1]
  if (!top) return false
  top.close()
  return true
}
