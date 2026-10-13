import { describe, expect, it } from 'vitest'
import { amountForms, amountText, fold, matches, readQuery, searchTotals, sortTransactions, SORT_ORDERS, type Haystack } from '../search'
import { tx } from './helpers'

const d = (day: number, month = 0, year = 2026) => new Date(year, month, day, 12).getTime()
const hay = (text: string, ...amounts: string[]): Haystack => ({ text: fold(text), amounts })
const finds = (haystack: Haystack, typed: string, symbols: string[] = []) => matches(haystack, readQuery(typed, symbols))

describe('ricerca e ordinamento dei movimenti', () => {
  it('si cerca senza badare a maiuscole e accenti', () => {
    expect(fold('Università Telematica')).toBe('universita telematica')
    expect(fold('CAFFÈ')).toBe('caffe')
    expect(finds(hay('Universita Telematica Esempio'), 'università')).toBe(true)
    expect(finds(hay('Università Telematica'), 'UNIVERSITA')).toBe(true)
    expect(finds(hay('Affitto mese di marzo'), 'universita')).toBe(false)
  })

  it('l’apostrofo dritto e quello tipografico sono lo stesso', () => {
    expect(finds(hay('Ripresi dall’obiettivo Vacanze'), "dall'obiettivo")).toBe(true)
    expect(finds(hay("Dall'8 del mese, non ancora in estratto"), 'dall’8')).toBe(true)
  })

  it('ogni parola della ricerca deve esserci, in qualunque ordine', () => {
    const text = hay('Affitto mese di marzo · Casa · Conto')
    expect(finds(text, 'marzo affitto')).toBe(true)
    expect(finds(text, 'affitto aprile')).toBe(false)
    expect(finds(text, 'aff mar')).toBe(true)
  })

  it('i segni da soli non cercano niente', () => {
    expect(readQuery('  ')).toEqual([])
    expect(readQuery(': · , -')).toEqual([])
    expect(readQuery('bar : sole').map((w) => w.word)).toEqual(['bar', 'sole'])
  })

  it('un importo si trova scritto come lo si legge, in italiano o in inglese', () => {
    // Valuta senza decimali: 431.984 L, che in inglese si legge L431,984.
    const big = hay('Retta universitaria', amountText(-431_984, 0))
    for (const typed of ['431984', '431.984', '431,984', '431', '-431.984', '431.984 L', 'L431,984']) expect(finds(big, typed, ['l'])).toBe(true)
    expect(finds(big, '984')).toBe(false)
    // Due decimali: 1.250,00 € ovvero €1,250.00.
    const rent = hay('Affitto', amountText(125_000, 2))
    for (const typed of ['1250', '1.250', '1,250', '1.250,00', '1,250.00', '1250,00', '1250.00', '€1,250', '1.250€']) expect(finds(rent, typed, ['€', 'eur'])).toBe(true)
    const coffee = hay('Bar', amountText(1_250, 2))
    for (const typed of ['12,50', '12.50', '12,5', '12']) expect(finds(coffee, typed)).toBe(true)
    // 1,25 non è 1.250, e 12 non è 1.250.
    expect(finds(hay('Gomma', amountText(125, 2)), '1.250')).toBe(false)
    expect(finds(rent, '12,50')).toBe(false)
  })

  it('parole e importo insieme; un movimento in valuta si trova anche con la sua cifra', () => {
    const uni = hay('Retta universitaria · Altro', amountText(431_984, 0))
    expect(finds(uni, 'retta 431.984')).toBe(true)
    expect(finds(uni, 'retta 500')).toBe(false)
    const abroad = hay('Libreria · Svago', amountText(2_840, 0), amountText(3_037, 2))
    expect(finds(abroad, '30,37')).toBe(true)
    expect(finds(abroad, '2840')).toBe(true)
  })

  it('un numero dentro una parola resta una parola: non diventa un importo', () => {
    expect(amountForms('h24')).toEqual([])
    expect(amountForms('covid19')).toEqual([])
    expect(amountForms('2026')).toEqual(['2026'])
    // Ma l'anno scritto in una nota si trova lo stesso, come testo.
    expect(finds(hay('Bollo auto 2026', amountText(18_000, 0)), '2026')).toBe(true)
  })

  const list = [
    tx('expense', 300, d(5), { id: 'a' }),
    tx('income', 500, d(3), { id: 'b' }),
    tx('expense', 4_000, d(17, 3, 2025), { id: 'c' }),
    tx('transfer', 300, d(9), { id: 'd', toAccountId: 'cash' }),
  ]
  const ids = (order: (typeof SORT_ORDERS)[number], from = list) => sortTransactions(from, order).map((t) => t.id)

  it('per data: dai più recenti o dai più vecchi', () => {
    expect(ids('recent')).toEqual(['d', 'a', 'b', 'c'])
    expect(ids('oldest')).toEqual(['c', 'b', 'a', 'd'])
  })

  it('per importo conta la grandezza, entrate e uscite insieme; a parità prima i più recenti', () => {
    expect(ids('high')).toEqual(['c', 'b', 'd', 'a'])
    expect(ids('low')).toEqual(['d', 'a', 'b', 'c'])
  })

  it('un saldo iniziale in rosso vale per quanto è grande, non per il segno', () => {
    const red = [tx('opening', -200_000, d(1), { id: 'o' }), tx('expense', 50, d(2), { id: 'k' }), tx('expense', 30_000, d(3), { id: 'r' })]
    expect(ids('high', red)).toEqual(['o', 'r', 'k'])
    expect(ids('low', red)).toEqual(['k', 'r', 'o'])
  })

  it('movimenti dello stesso istante: come nel ramo, prima quello aggiunto per ultimo; dai più vecchi il contrario', () => {
    const same = [tx('expense', 100, d(4), { id: 'x' }), tx('expense', 100, d(4), { id: 'y' }), tx('expense', 100, d(4), { id: 'z' })]
    expect(ids('recent', same)).toEqual(['z', 'y', 'x'])
    expect(ids('oldest', same)).toEqual(['x', 'y', 'z'])
    expect(ids('high', same)).toEqual(['z', 'y', 'x'])
  })

  it('l’importo che conta è quello nella valuta principale', () => {
    const mixed = [tx('expense', 100, d(1), { id: 'eur', currency: 'EUR', mainAmount: 9_800 }), tx('expense', 5_000, d(2), { id: 'all', mainAmount: 5_000 })]
    expect(sortTransactions(mixed, 'high').map((t) => t.id)).toEqual(['eur', 'all'])
  })

  it('la lista di partenza resta com’è', () => {
    const before = list.map((t) => t.id)
    sortTransactions(list, 'high')
    expect(list.map((t) => t.id)).toEqual(before)
  })
})

describe('i totali di una ricerca', () => {
  const now = new Date(2026, 9, 13, 12).getTime()
  const at = (day: number, month: number, year = 2026) => new Date(year, month, day, 10).getTime()

  it('quanto è uscito e quanto è entrato, quante volte e di solito quanto', () => {
    const t = searchTotals(
      [
        tx('expense', 42_000, at(27, 7), { note: 'Affitto' }),
        tx('expense', 42_000, at(29, 8), { note: 'Affitto' }),
        tx('expense', 48_000, at(1, 9), { note: 'Affitto' }),
        tx('income', 5_000, at(3, 9), { note: 'Rimborso affitto' }),
      ],
      now,
    )
    expect([t.count, t.out, t.outCount, t.outTypical]).toEqual([4, 132_000, 3, 42_000])
    expect([t.in, t.inCount, t.inTypical]).toEqual([5_000, 1, 5_000])
    expect([t.first, t.last, t.months]).toEqual([at(27, 7), at(3, 9), 3])
  })

  it('giroconti, obiettivi e saldi iniziali non sono né entrate né uscite; le scadenze future non sono ancora successe', () => {
    const t = searchTotals(
      [
        tx('expense', 1_000, at(5, 8)),
        tx('transfer', 9_000, at(6, 8), { toAccountId: 'cash' }),
        tx('save', 7_000, at(7, 8), { goalId: 'g' }),
        tx('release', 2_000, at(8, 8), { goalId: 'g' }),
        tx('opening', 50_000, at(1, 0)),
        tx('expense', 1_000, at(20, 9)),
        tx('income', 3_000, at(25, 9)),
      ],
      now,
    )
    expect([t.count, t.out, t.in, t.moved, t.upcoming]).toEqual([1, 1_000, 0, 4, 2])
    // Un mese solo: niente divisione.
    expect([t.months, t.by, t.periods]).toEqual([1, null, []])
  })

  it('si dividono per mese dentro un anno, per anno quando ne toccano più di uno, dal più recente', () => {
    const year = searchTotals([tx('expense', 100, at(3, 1)), tx('expense', 200, at(9, 1)), tx('income', 50, at(4, 3)), tx('expense', 300, at(1, 8))], now)
    expect(year.by).toBe('month')
    expect(year.periods).toEqual([
      { start: new Date(2026, 8, 1).getTime(), out: 300, in: 0, count: 1 },
      { start: new Date(2026, 3, 1).getTime(), out: 0, in: 50, count: 1 },
      { start: new Date(2026, 1, 1).getTime(), out: 300, in: 0, count: 2 },
    ])
    expect(year.months).toBe(8)
    const years = searchTotals([tx('expense', 4_000, at(17, 3, 2025)), tx('expense', 900, at(2, 0)), tx('expense', 100, at(5, 5))], now)
    expect(years.by).toBe('year')
    expect(years.periods.map((p) => [new Date(p.start).getFullYear(), p.out, p.count])).toEqual([[2026, 1_000, 2], [2025, 4_000, 1]])
    expect(years.months).toBe(15)
  })

  it('senza niente da contare è tutto a zero', () => {
    expect(searchTotals([], now)).toMatchObject({ count: 0, out: 0, in: 0, first: null, last: null, months: 0, by: null, periods: [] })
  })
})
