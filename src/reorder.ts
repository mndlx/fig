/** Sposta un elemento da una posizione a un'altra, senza toccare l'array di partenza. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  const next = [...items]
  if (from === to || from < 0 || from >= next.length) return next
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item)
  return next
}

/** Posizione di arrivo durante un trascinamento: spostamento in pixel → indice, dentro i limiti della lista. */
export function dropIndex(from: number, dy: number, step: number, length: number): number {
  if (!(step > 0)) return from
  return Math.max(0, Math.min(length - 1, from + Math.round(dy / step)))
}

/**
 * Nuovo ordinamento dopo uno spostamento. Riusa i valori di `order` già presenti nella lista
 * (così non si scontra con le altre liste) e restituisce solo gli elementi che cambiano.
 * Se due elementi avevano lo stesso valore, lo rende crescente.
 */
export function reorder<T extends { order: number }>(items: T[], from: number, to: number): T[] {
  const moved = moveItem(items, from, to)
  const slots = items.map((x) => x.order).sort((a, b) => a - b)
  for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1
  return moved.flatMap((item, i) => (item.order === slots[i] ? [] : [{ ...item, order: slots[i] }]))
}
