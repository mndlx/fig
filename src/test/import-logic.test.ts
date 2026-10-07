import { describe, expect, it } from 'vitest'
import type { Currency, Transaction } from '../db'
import { accountEffect, matchExisting, openingForHistory, shiftedOpening, suggest, type ImportRow } from '../importLogic'
import { ALL, EUR, tx } from './helpers'

const at = (day: number, h = 12) => new Date(2026, 8, day, h).getTime()
const row = (index: number, day: number, kind: 'expense' | 'income', amount: number): ImportRow => ({ index, date: at(day), kind, amount })

describe('import: movimenti già presenti', () => {
  it('stesso giorno, stesso importo: già presente', () => {
    const m = matchExisting([row(0, 28, 'expense', 350)], [tx('expense', 350, at(28, 9))], 'main', 'EUR')
    expect(m.get(0)).toEqual({ exact: true, date: at(28, 9) })
  })

  it('due righe uguali nello stesso giorno e un solo movimento in FIG: una resta da importare', () => {
    const m = matchExisting([row(0, 28, 'expense', 120), row(1, 28, 'expense', 120)], [tx('expense', 120, at(28, 9))], 'main', 'EUR')
    expect(m.size).toBe(1)
    expect(m.has(0)).toBe(true)
    expect(m.has(1)).toBe(false)
  })

  it('registrato a mano due giorni prima della data contabile: probabile doppione', () => {
    const m = matchExisting([row(0, 30, 'expense', 4530)], [tx('expense', 4530, at(28, 18))], 'main', 'EUR')
    expect(m.get(0)).toEqual({ exact: false, date: at(28, 18) })
  })

  it('oltre la finestra di tre giorni non è un doppione', () => {
    expect(matchExisting([row(0, 30, 'expense', 4530)], [tx('expense', 4530, at(25))], 'main', 'EUR').size).toBe(0)
  })

  it('la corrispondenza nello stesso giorno vince su quella vicina', () => {
    const existing = [tx('expense', 500, at(27)), tx('expense', 500, at(28))]
    const m = matchExisting([row(0, 28, 'expense', 500), row(1, 29, 'expense', 500)], existing, 'main', 'EUR')
    expect(m.get(0)).toEqual({ exact: true, date: at(28) })
    // L'altra riga prende quello del 27, a due giorni di distanza.
    expect(m.get(1)).toEqual({ exact: false, date: at(27) })
  })

  it('un prelievo registrato come giroconto verso i contanti copre la riga della banca', () => {
    const withdrawal = tx('transfer', 10000, at(30, 18), { toAccountId: 'cash' })
    expect(accountEffect(withdrawal, 'main', 'EUR')).toEqual({ kind: 'expense', amount: 10000 })
    expect(accountEffect(withdrawal, 'cash', 'EUR')).toEqual({ kind: 'income', amount: 10000 })
    expect(matchExisting([row(0, 30, 'expense', 10000)], [withdrawal], 'main', 'EUR').get(0)?.exact).toBe(true)
  })

  it('non confonde verso, conto, valuta, né saldi iniziali e accantonamenti', () => {
    const existing = [
      tx('income', 350, at(28)),
      tx('expense', 350, at(28), { accountId: 'cash' }),
      tx('expense', 350, at(28), { currency: 'ALL' }),
      tx('opening', 350, at(28)),
      tx('save', 350, at(28), { goalId: 'g' }),
    ]
    expect(matchExisting([row(0, 28, 'expense', 350)], existing, 'main', 'EUR').size).toBe(0)
  })
})

describe('import: categoria suggerita', () => {
  it('riconosce i casi più comuni di un estratto', () => {
    expect(suggest('PAGAMENTO POS ESSELUNGA VIALE PIAVE MILANO', 'expense')).toEqual({ category: 'groceries' })
    expect(suggest('ADDEBITO SDD ENEL ENERGIA BOLLETTA', 'expense')).toEqual({ category: 'bills' })
    expect(suggest('PAGAMENTO POS BAR ROMA MILANO', 'expense')).toEqual({ category: 'coffee' })
    expect(suggest('PAGAMENTO POS TRENITALIA', 'expense')).toEqual({ category: 'transport' })
    expect(suggest('BONIFICO A VOSTRO FAVORE STIPENDIO ACME SRL', 'income')).toEqual({ category: 'salary' })
    expect(suggest('STORNO OPERAZIONE POS', 'income')).toEqual({ category: 'refunds' })
  })

  it('prelievo = giroconto verso i contanti, ma la commissione sul prelievo è una spesa', () => {
    expect(suggest('PRELIEVO BANCOMAT', 'expense')).toEqual({ cash: true })
    expect(suggest('TERHEQJE ATM', 'expense')).toEqual({ cash: true })
    expect(suggest('COMMISSIONE PRELIEVO ATM ALTRA BANCA', 'expense')).toEqual({ category: 'fees' })
    expect(suggest('COMMISSIONI BONIFICO', 'expense')).toEqual({ category: 'fees' })
  })

  it('senza indizi non inventa', () => {
    expect(suggest('PAGAMENTO POS XYZ SRL', 'expense')).toBeNull()
    // "bar" dentro un'altra parola non conta, e gli indizi di uscita non valgono per le entrate.
    expect(suggest('BARBIERE MARIO', 'expense')).toBeNull()
    expect(suggest('ESSELUNGA', 'income')).toBeNull()
  })
})

describe('import: storico precedente al saldo iniziale', () => {
  const opening = { amount: 120000, date: at(20, 8) }

  it('niente di precedente: il saldo iniziale non si tocca', () => {
    expect(openingForHistory(opening, [{ date: at(20), kind: 'expense', amount: 500 }, { date: at(25), kind: 'income', amount: 900 }])).toBeNull()
  })

  it('riporta il saldo a prima dei movimenti, e il saldo di oggi resta uguale', () => {
    const earlier = [
      { date: at(12), kind: 'expense' as const, amount: 2990 },
      { date: at(15), kind: 'income' as const, amount: 10000 },
      { date: at(11), kind: 'expense' as const, amount: 10000 },
    ]
    const later = [{ date: at(22), kind: 'expense' as const, amount: 4530 }]
    const moved = openingForHistory(opening, [...earlier, ...later])!
    expect(new Date(moved.date).getDate()).toBe(11)
    expect(new Date(moved.date).getHours()).toBe(0)
    // Prima: 120000 − 4530. Dopo: saldo spostato + storico − 4530. Devono coincidere.
    const net = (rows: { kind: string; amount: number }[]) => rows.reduce((s, r) => s + (r.kind === 'income' ? r.amount : -r.amount), 0)
    expect(moved.amount + net(earlier) + net(later)).toBe(opening.amount + net(later))
    expect(moved.amount).toBe(120000 + 2990 - 10000 + 10000)
  })
})

describe('import: il saldo iniziale spostato come movimento', () => {
  const USD: Currency = { code: 'USD', symbol: '$', decimals: 2 }
  const opening = (extra: Partial<Transaction>): Transaction => ({ id: 'opening-acc-usd', kind: 'opening', amount: 0, currency: 'USD', rate: 1, mainAmount: 0, date: at(20, 8), accountId: 'acc-usd', note: 'Nota', source: 'manual', ...extra })
  const shift = { amount: 250000, date: at(11, 0) }

  it('cambio e controvalore dallo stesso numero, non in proporzione al controvalore di prima', () => {
    // 0,20 $ a 92 erano 18 L (18,4 arrotondato). Portato a 2.500,00 $: 230.000 L, non 225.000.
    const moved = shiftedOpening(opening({ amount: 20, mainAmount: 18, rate: 92 }), shift, USD, ALL, 95)
    expect(moved).toMatchObject({ id: 'opening-acc-usd', kind: 'opening', note: 'Nota', amount: 250000, mainAmount: 230000, rate: 92, date: shift.date })
  })

  it('saldo delle versioni precedenti: il cambio sbagliato di scala viene corretto', () => {
    // 100,00 $ = 9.200 L salvati col cambio 0,92.
    expect(shiftedOpening(opening({ amount: 10000, mainAmount: 9200, rate: 0.92 }), shift, USD, ALL, 95)).toMatchObject({ amount: 250000, mainAmount: 230000, rate: 92 })
  })

  it('saldo che diventa negativo: il segno resta fuori dall’arrotondamento', () => {
    expect(shiftedOpening(opening({ amount: 10000, mainAmount: 9200, rate: 92 }), { amount: -150, date: shift.date }, USD, ALL, 95)).toMatchObject({ amount: -150, mainAmount: -138, rate: 92 })
  })

  it('senza un cambio che si possa usare vale quello indicato per l’importazione', () => {
    // Controvalore zero e nessun cambio salvato: prima il nuovo controvalore restava zero.
    expect(shiftedOpening(opening({ amount: 500, mainAmount: 0, rate: 0 }), shift, USD, ALL, 95)).toMatchObject({ amount: 250000, mainAmount: 237500, rate: 95 })
  })

  it('conto nella valuta principale: il controvalore è l’importo', () => {
    expect(shiftedOpening(opening({ currency: 'EUR', amount: 120000, mainAmount: 120000, rate: 1 }), { amount: 122990, date: shift.date }, EUR, EUR, 1)).toMatchObject({ amount: 122990, mainAmount: 122990, rate: 1 })
  })
})
