import { describe, expect, it } from 'vitest'
import { dropIndex, moveItem, reorder } from '../reorder'

const cats = (orders: number[]) => orders.map((order, i) => ({ id: String.fromCharCode(97 + i), order }))
/** Applica le modifiche e restituisce gli id nell'ordine finale. */
function after(list: { id: string; order: number }[], from: number, to: number): string {
  const changed = new Map(reorder(list, from, to).map((c) => [c.id, c]))
  return list
    .map((c) => changed.get(c.id) ?? c)
    .sort((a, b) => a.order - b.order)
    .map((c) => c.id)
    .join('')
}

describe('riordino con trascinamento', () => {
  it('sposta un elemento in giù e in su', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })

  it('la posizione di arrivo segue il dito e resta dentro la lista', () => {
    expect(dropIndex(2, 0, 56, 6)).toBe(2)
    expect(dropIndex(2, 27, 56, 6)).toBe(2)
    expect(dropIndex(2, 30, 56, 6)).toBe(3)
    expect(dropIndex(2, -120, 56, 6)).toBe(0)
    expect(dropIndex(2, 9999, 56, 6)).toBe(5)
    expect(dropIndex(2, -9999, 56, 6)).toBe(0)
    expect(dropIndex(2, 100, 0, 6)).toBe(2)
  })

  it('salva solo gli elementi che cambiano posizione, riusando i valori esistenti', () => {
    const list = cats([0, 1, 2, 5, 11.5])
    const changed = reorder(list, 4, 1)
    expect(after(list, 4, 1)).toBe('aebcd')
    // "a" resta dov'è: non va riscritta.
    expect(changed.map((c) => c.id).sort()).toEqual(['b', 'c', 'd', 'e'])
    expect(changed.map((c) => c.order).sort((x, y) => x - y)).toEqual([1, 2, 5, 11.5])
  })

  it('nessuno spostamento, nessuna scrittura', () => {
    expect(reorder(cats([0, 1, 2]), 1, 1)).toEqual([])
  })

  it('valori di ordine doppi vengono resi crescenti', () => {
    const list = cats([3, 3, 3])
    expect(after(list, 2, 0)).toBe('cab')
    const orders = list.map((c) => reorder(list, 2, 0).find((x) => x.id === c.id)?.order ?? c.order)
    expect(new Set(orders).size).toBe(3)
  })
})
