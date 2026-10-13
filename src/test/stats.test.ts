import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeMonth } from '../App'
import type { Account, Category, Transaction } from '../db'
import {
  availablePresets,
  axisScale,
  balanceSeries,
  dayMoves,
  dayStart,
  explainLeg,
  findSwings,
  fullMonths,
  idleStep,
  isOpaque,
  levers,
  median,
  monthEnvelope,
  monthFlows,
  monthLabels,
  monthsBetween,
  monthStart,
  nearestIndex,
  nextDay,
  opaqueWallets,
  periodMonths,
  placeMarks,
  previousMonths,
  roundDown2,
  rowTransactions,
  savingSummary,
  sliceByDate,
  snapToStop,
  spendingBreakdown,
  spendingIn,
  swingMarks,
  swingOfDay,
  swingStops,
  swingThreshold,
  totalDelta,
  touchReach,
  turningPoints,
  usualSwing,
  yAxis,
  type DayPoint,
  type Lever,
} from '../stats'
import { account, appData, tx } from './helpers'

const d = (day: number, hour = 12, month = 0, year = 2026) => new Date(year, month, day, hour).getTime()
const m = (month: number, year = 2026) => new Date(year, month, 1).getTime()
const cat = (id: string, extra: Partial<Category> = {}): Category => ({ id, name: '', key: id, icon: 'dots', kind: 'expense', color: '#000', order: 0, archived: false, ...extra })
const cash: Account = { ...account('cash'), key: 'cash' }
const categories = [cat('home'), cat('groceries'), cat('fees'), cat('other'), cat('fun'), cat('unknown', { key: undefined, name: 'Unknown' })]
const ctx = { categories, wallets: new Set(['cash']) }
const open = { categories, wallets: new Set<string>() }
const point = (day: number, value: number, delta = 0): DayPoint => ({ day, value, delta })
/** Una serie con un punto al giorno a partire dal primo gennaio 2026. */
const series = (...values: number[]): DayPoint[] => values.map((value, i) => point(new Date(2026, 0, 1 + i).getTime(), value, i ? value - values[i - 1] : 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('giorni e mesi', () => {
  it('inizio del giorno, giorno dopo, inizio del mese e distanza in mesi sono locali', () => {
    expect(dayStart(d(10, 18))).toBe(d(10, 0))
    expect(nextDay(d(31, 0))).toBe(m(1))
    expect(monthStart(d(10, 18))).toBe(m(0))
    expect(monthStart(d(10, 18), -1)).toBe(m(11, 2025))
    expect(monthsBetween(m(0), m(3))).toBe(3)
    expect(monthsBetween(d(31, 23, 0), d(1, 0, 1))).toBe(1)
    expect(monthsBetween(d(15, 12, 10, 2025), d(3, 0, 1))).toBe(3)
  })

  it('il giorno dopo regge il cambio dell’ora, e la serie non salta né raddoppia giorni', () => {
    const next = new Date(nextDay(new Date(2026, 2, 29).getTime()))
    expect([next.getDate(), next.getHours()]).toEqual([30, 0])
    // Tutto marzo e tutto ottobre: un punto per giorno di calendario, anche dove cambia l'ora.
    for (const month of [2, 9]) {
      const days = balanceSeries([], { from: m(month), now: d(31, 23, month) }).map((p) => new Date(p.day).getDate())
      expect(days).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
    }
  })

  it('mediana: valore di mezzo, media dei due centrali se sono pari, zero senza valori', () => {
    expect(median([5, 1, 9])).toBe(5)
    expect(median([1, 2, 10, 100])).toBe(6)
    expect(median([])).toBe(0)
  })

  it('arrotondare in giù a due cifre', () => {
    expect([68_324, 633, 95, 7, 0, -5].map(roundDown2)).toEqual([68_000, 630, 95, 7, 0, 0])
  })
})

describe('saldo giorno per giorno', () => {
  const list = [
    tx('opening', 100_000, d(1, 9), { id: 'opening-main' }),
    tx('expense', 20_000, d(2, 9)),
    tx('transfer', 50_000, d(2, 10), { toAccountId: 'cash' }),
    tx('income', 70_000, d(4, 9)),
    tx('save', 10_000, d(4, 10), { goalId: 'g' }),
    tx('expense', 5_000, d(4, 11), { goalId: 'g' }),
    tx('release', 2_000, d(5, 9), { goalId: 'g' }),
    tx('expense', 30_000, d(6, 9)),
  ]

  it('effetto di ogni movimento sui soldi che si hanno in tutto', () => {
    expect(list.map(totalDelta)).toEqual([100_000, -20_000, 0, 70_000, 0, -5_000, 0, -30_000])
  })

  it('un punto per giorno, coi giorni vuoti; giroconti e obiettivi non lo muovono', () => {
    const points = balanceSeries(list, { from: d(1), now: d(5, 23) })
    expect(points.map((p) => p.value)).toEqual([100_000, 80_000, 80_000, 145_000, 145_000])
    expect(points.map((p) => p.delta)).toEqual([0, -20_000, 0, 65_000, 0])
    expect(points.map((p) => p.day)).toEqual([1, 2, 3, 4, 5].map((day) => d(day, 0)))
  })

  it('il disponibile invece scende quando si mette da parte, e non scende per una spesa pagata da un obiettivo', () => {
    const points = balanceSeries(list, { from: d(1), now: d(5, 23), scope: 'available' })
    expect(points.map((p) => p.value)).toEqual([100_000, 80_000, 80_000, 140_000, 142_000])
  })

  it('l’ultimo punto del disponibile è il numero della schermata principale', () => {
    vi.useFakeTimers()
    vi.setSystemTime(d(6, 18))
    const data = appData([...list, tx('expense', 9_999, d(20, 9))], { accounts: [{ ...account('main'), initialMain: 700 }, cash] })
    const points = balanceSeries(data.transactions, { from: d(1), now: Date.now(), scope: 'available', base: 700 })
    expect(points[points.length - 1].value).toBe(computeMonth(data, 0).balanceNow)
    expect(points[points.length - 1].value).toBe(112_700)
  })

  it('i saldi iniziali valgono dal primo punto, qualunque data abbiano: la linea si muove solo per entrate e uscite', () => {
    const late = [tx('expense', 1_000, d(2, 9)), tx('opening', 50_000, d(4, 9), { id: 'opening-cash' }), tx('expense', 2_000, d(5, 9))]
    expect(balanceSeries(late, { from: d(1), now: d(5, 23), base: 500 }).map((p) => p.value)).toEqual([50_500, 49_500, 49_500, 49_500, 47_500])
  })

  it('parte dal saldo che c’era prima del periodo', () => {
    expect(balanceSeries(list, { from: d(3), now: d(4, 23) }).map((p) => p.value)).toEqual([80_000, 145_000])
  })

  it('quello che viene dopo adesso non conta, anche nello stesso giorno; l’ordine dei movimenti nemmeno', () => {
    expect(balanceSeries(list, { from: d(6, 0), now: d(6, 8) }).map((p) => p.value)).toEqual([145_000])
    expect(balanceSeries(list, { from: d(6, 0), now: d(6, 10) }).map((p) => p.value)).toEqual([115_000])
    const shuffled = [list[7], list[3], list[0], list[5], list[1], list[4], list[2], list[6]]
    expect(balanceSeries(shuffled, { from: d(1), now: d(6, 23) })).toEqual(balanceSeries(list, { from: d(1), now: d(6, 23) }))
    expect(balanceSeries(list, { from: d(5), now: d(4) })).toEqual([])
  })
})

describe('alti e bassi', () => {
  it('il punto più basso, il più alto e l’ultimo di ogni mese; a parità vale il primo giorno', () => {
    const jan = Array.from({ length: 31 }, (_, i) => (i === 9 ? 500 : i === 19 || i === 20 ? 100 : 300))
    const env = monthEnvelope(series(...jan, 200, 250))
    expect(env.map((e) => [new Date(e.month).getMonth(), e.days, e.low.value, e.high.value, e.end.value])).toEqual([
      [0, 31, 100, 500, 300],
      [1, 2, 200, 250, 250],
    ])
    expect(new Date(env[0].low.day).getDate()).toBe(20)
    expect(new Date(env[0].high.day).getDate()).toBe(10)
  })

})

describe('cosa ha portato a un alto o a un basso', () => {
  const list = [
    tx('opening', 1_000, d(1, 9), { id: 'opening-main' }),
    tx('income', 5_000, d(3, 9), { note: 'Stipendio di dicembre', categoryId: 'salary' }),
    tx('income', 300, d(3, 10), { note: 'Rimborso' }),
    tx('expense', 2_000, d(4, 9), { note: 'Affitto mese di gennaio', categoryId: 'home' }),
    tx('expense', 400, d(5, 9), { note: 'SPAR 1', categoryId: 'groceries' }),
    tx('expense', 300, d(5, 9), { note: 'SPAR 2', categoryId: 'groceries' }),
    tx('transfer', 900, d(5, 10), { toAccountId: 'cash' }),
    tx('expense', 150, d(6, 9), { note: 'Commissione prelievo', categoryId: 'fees' }),
    tx('expense', 50, d(6, 9), { note: 'Commissione', categoryId: 'fees' }),
    tx('expense', 1_000, d(6, 10), { accountId: 'cash', categoryId: 'unknown', note: 'Contanti' }),
    tx('expense', 120, d(6, 11), { source: 'adjust', categoryId: 'fees', note: 'Allineamento saldo' }),
    tx('income', 70, d(6, 11), { source: 'adjust', note: 'Allineamento saldo' }),
    tx('save', 500, d(6, 12), { goalId: 'g' }),
    tx('income', 5_000, d(7, 9), { note: 'Stipendio di gennaio', categoryId: 'salary' }),
    tx('income', 400, d(7, 10), { note: 'Rimborso spese', categoryId: 'salary' }),
  ]
  const points = balanceSeries(list, { from: d(1), now: d(7, 23) })

  it('verso un basso: tutte le uscite del tratto, coi gruppi più pesanti; i conti tornano col saldo', () => {
    const leg = explainLeg(list, points[2], points[5], 'low', ctx)
    expect([leg.in, leg.adjustIn, leg.out, leg.saved]).toEqual([0, 70, 4_020, 500])
    expect(points[2].value + leg.in + leg.adjustIn - leg.out).toBe(points[5].value)
    // Contanti e allineamento sono "senza dettaglio"; le due commissioni un gruppo solo; SPAR 1 e SPAR 2 lo stesso negozio.
    expect(leg.top.map((g) => [g.kind, g.key, g.total, g.count])).toEqual([
      ['payee', 'affitto', 2_000, 1],
      ['opaque', '', 1_120, 2],
      ['payee', 'spar', 700, 2],
    ])
    // Il nome di un gruppo è la parte comune delle sue note: "Affitto", "SPAR".
    expect(leg.top.map((g) => g.name)).toEqual(['Affitto mese di gennaio', '', 'SPAR'])
    expect(leg.movers.map((t) => t.mainAmount)).toEqual([2_000, 1_000, 400, 300, 150, 120, 50])
    expect(leg.landed).toBeNull()
    expect(leg.single).toBeNull()
  })

  it('un’uscita che da sola fa almeno metà del calo viene nominata', () => {
    const big = [tx('income', 9_000, d(1, 9)), tx('expense', 6_000, d(3, 9), { note: 'Retta universitaria' }), tx('expense', 900, d(4, 9), { note: 'Spesa' })]
    const p = balanceSeries(big, { from: d(1), now: d(4, 23) })
    expect(explainLeg(big, p[0], p[3], 'low', open).single?.note).toBe('Retta universitaria')
  })

  it('verso un alto: le entrate, e se è appena arrivato uno stipendio lo dice', () => {
    const leg = explainLeg(list, points[5], points[6], 'high', ctx)
    expect([leg.in, leg.out]).toEqual([5_400, 0])
    // Le entrate stanno insieme per categoria, anche se la nota cambia ogni volta.
    expect(leg.top.map((g) => [g.kind, g.key, g.total, g.count])).toEqual([['category', 'salary', 5_400, 2]])
    expect(leg.landed?.amount).toBe(5_400)
    expect(leg.landed?.tx.note).toBe('Stipendio di gennaio')
  })

  it('un’entrata vecchia non è "appena arrivata"', () => {
    const slow = [tx('income', 5_000, d(2, 9), { note: 'Stipendio' }), tx('income', 100, d(9, 9), { note: 'Rimborso' })]
    const p = balanceSeries(slow, { from: d(1), now: d(9, 23) })
    expect(explainLeg(slow, p[0], p[8], 'high', open).landed).toBeNull()
  })

  it('sul disponibile i conti tornano lo stesso: le spese pagate da un obiettivo non muovono la linea, gli obiettivi sì', () => {
    const goals = [
      tx('income', 3_000, d(1, 9), { note: 'Stipendio' }),
      tx('save', 1_000, d(2, 9), { goalId: 'g' }),
      tx('expense', 1_000, d(10, 9), { note: 'Volo', goalId: 'g' }),
      tx('expense', 120, d(12, 9), { note: 'Spesa' }),
      tx('expense', 100, d(13, 9), { note: 'Spesa' }),
      tx('expense', 80, d(14, 9), { note: 'Spesa' }),
      tx('release', 600, d(20, 9), { goalId: 'g' }),
    ]
    const p = balanceSeries(goals, { from: d(1), now: d(20, 23), scope: 'available' })
    expect([p[0].value, p[13].value, p[19].value]).toEqual([3_000, 1_700, 2_300])
    const down = explainLeg(goals, p[0], p[13], 'low', open, { scope: 'available' })
    expect([down.in, down.out, down.saved]).toEqual([0, 300, 1_000])
    expect(p[0].value + down.in + down.adjustIn - down.out - down.saved).toBe(p[13].value)
    // Il volo è stato pagato coi soldi già messi da parte: non è tra le cause, e non è "l'uscita che da sola…".
    expect(down.movers.map((t) => t.note)).toEqual(['Spesa', 'Spesa', 'Spesa'])
    expect(down.single).toBeNull()
    const up = explainLeg(goals, p[13], p[19], 'high', open, { scope: 'available' })
    expect([up.in, up.out, up.saved]).toEqual([0, 0, -600])
    expect(p[13].value + up.in - up.out - up.saved).toBe(p[19].value)
    // Sul totale lo stesso tratto conta il volo: lì i soldi escono davvero.
    const total = balanceSeries(goals, { from: d(1), now: d(20, 23) })
    const whole = explainLeg(goals, total[0], total[13], 'low', open)
    expect(total[0].value - whole.out).toBe(total[13].value)
    expect(whole.single?.note).toBe('Volo')
  })

  it('quello che è segnato per più tardi oggi non è ancora sulla linea, e non è tra le cause', () => {
    const today = [tx('income', 3_000, d(1, 9)), tx('expense', 1_000, d(5, 9), { note: 'Affitto' }), tx('expense', 500, d(20, 8), { note: 'Spesa' }), tx('expense', 1_200, d(20, 18), { note: 'Rata' })]
    const now = d(20, 9)
    const p = balanceSeries(today, { from: d(1), now })
    const leg = explainLeg(today, p[0], p[19], 'low', open, { now })
    expect(leg.out).toBe(1_500)
    expect(p[0].value - leg.out).toBe(p[19].value)
    expect(leg.movers.map((t) => t.note)).toEqual(['Affitto', 'Spesa'])
  })

  it('un alto fatto da un allineamento in più lo nomina, senza chiamarlo entrata', () => {
    const fixed = [tx('income', 1_000, d(1, 9)), tx('income', 30, d(9, 9), { note: 'Rimborso' }), tx('income', 2_000, d(10, 9), { source: 'adjust', note: 'Allineamento saldo' })]
    const p = balanceSeries(fixed, { from: d(1), now: d(10, 23) })
    const leg = explainLeg(fixed, p[0], p[9], 'high', open)
    expect([leg.in, leg.adjustIn]).toEqual([30, 2_000])
    expect(leg.top.map((g) => [g.kind, g.total])).toEqual([['adjust', 2_000], ['category', 30]])
    expect(leg.movers.map((t) => t.mainAmount)).toEqual([2_000, 30])
    // "Appena entrati" vale solo per le entrate vere.
    expect(leg.landed).toBeNull()
  })

  it('le spese senza dettaglio si chiamano contanti solo se almeno metà viene da un portafoglio cieco', () => {
    const hidden = (cashPart: number) => [
      tx('income', 5_000, d(1, 9)),
      tx('expense', cashPart, d(3, 9), { accountId: 'cash', categoryId: 'unknown' }),
      tx('expense', 300, d(4, 9), { source: 'adjust', categoryId: 'fees', note: 'Allineamento saldo' }),
    ]
    const cashOf = (list: Transaction[]) => {
      const p = balanceSeries(list, { from: d(1), now: d(4, 23) })
      return explainLeg(list, p[0], p[3], 'low', ctx).top.find((g) => g.kind === 'opaque')?.cash
    }
    expect(cashOf(hidden(900))).toBe(true)
    expect(cashOf(hidden(100))).toBe(false)
  })
})

describe('mesi interi e periodi', () => {
  const now = d(13, 12, 9) // 13 ottobre 2026

  it('dal mese del primo movimento se cade il primo, altrimenti dal successivo, fino al mese scorso', () => {
    const late = fullMonths([tx('opening', 1, d(1, 9, 5)), tx('expense', 1, d(2, 9, 5))], now)
    expect(late && [new Date(late.first).getMonth(), new Date(late.last).getMonth(), late.count]).toEqual([6, 8, 3])
    const early = fullMonths([tx('expense', 1, d(1, 9, 5))], now)
    expect(early && [new Date(early.first).getMonth(), early.count]).toEqual([5, 4])
  })

  it('senza un mese intero non c’è periodo: solo il mese in corso, solo movimenti futuri, o solo saldi iniziali', () => {
    expect(fullMonths([tx('expense', 1, d(2, 9, 9))], now)).toBeNull()
    expect(fullMonths([tx('expense', 1, d(20, 9, 8))], now)).toBeNull()
    expect(fullMonths([tx('expense', 1, d(20, 9, 11))], now)).toBeNull()
    expect(fullMonths([tx('opening', 1, d(1, 9, 0))], now)).toBeNull()
    expect(fullMonths([], now)).toBeNull()
  })

  it('gli ultimi N mesi interi, dal più vecchio; niente se non bastano', () => {
    const full = fullMonths([tx('expense', 1, d(1, 9, 0))], now)!
    expect(full.count).toBe(9)
    expect(periodMonths(full, 3).map((x) => new Date(x).getMonth())).toEqual([6, 7, 8])
    expect(periodMonths(full, 'all')).toHaveLength(9)
    expect(periodMonths(full, 12)).toEqual([])
    expect(periodMonths(null, 3)).toEqual([])
    expect(availablePresets(full)).toEqual([3, 6, 'all'])
    expect(availablePresets({ ...full, count: 3 })).toEqual(['all'])
    expect(availablePresets(null)).toEqual([])
  })

  it('il periodo prima, solo se è fatto tutto di mesi interi', () => {
    const full = fullMonths([tx('expense', 1, d(1, 9, 0))], now)!
    expect(previousMonths(full, periodMonths(full, 3))!.map((x) => new Date(x).getMonth())).toEqual([3, 4, 5])
    expect(previousMonths(full, periodMonths(full, 6))).toBeNull()
    expect(previousMonths(full, [])).toBeNull()
    expect(previousMonths(null, [m(6)])).toBeNull()
  })

  it('entrate, uscite e rimasto mese per mese: futuro escluso, mesi vuoti compresi, allineamenti in più a parte', () => {
    const list = [
      tx('opening', 9_999, d(1, 9, 6)),
      tx('income', 5_000, d(5, 9, 6)),
      tx('expense', 2_000, d(6, 9, 6)),
      tx('expense', 500, d(7, 9, 6), { goalId: 'g' }),
      tx('save', 1_000, d(8, 9, 6), { goalId: 'g' }),
      tx('release', 300, d(9, 9, 6), { goalId: 'g' }),
      tx('transfer', 700, d(9, 9, 6), { toAccountId: 'cash' }),
      tx('expense', 80, d(10, 9, 6), { source: 'adjust' }),
      tx('income', 30, d(11, 9, 8), { source: 'adjust' }),
      tx('expense', 400, d(20, 9, 9)),
    ]
    const flows = monthFlows(list, [m(6), m(7), m(8)], now)
    expect(flows.map((f) => [f.in, f.adjustIn, f.out, f.fromGoal, f.saved, f.net, f.count])).toEqual([
      [5_000, 0, 2_580, 500, 700, 2_420, 4],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 30, 0, 0, 0, 30, 1],
    ])
    // Il mese in corso si può chiedere, ma conta solo quello che è già successo.
    expect(monthFlows(list, [m(9)], now)[0].out).toBe(0)
  })

  it('la somma dei mesi è di quanto si muove la linea del saldo', () => {
    const list = [
      tx('opening', 9_999, d(1, 9, 5)),
      tx('income', 5_000, d(1, 9, 6)),
      tx('expense', 2_000, d(6, 9, 6)),
      tx('expense', 500, d(7, 9, 7), { goalId: 'g' }),
      tx('save', 1_000, d(8, 9, 7), { goalId: 'g' }),
      tx('income', 30, d(11, 9, 8), { source: 'adjust' }),
      tx('expense', 80, d(12, 9, 8), { source: 'adjust' }),
    ]
    const months = [m(6), m(7), m(8)]
    const line = balanceSeries(list, { from: months[0], now: d(30, 23, 8) })
    const kept = monthFlows(list, months, now).reduce((s, f) => s + f.net, 0)
    expect(line[line.length - 1].value - (line[0].value - line[0].delta)).toBe(kept)
  })
})

describe('dove vanno i soldi', () => {
  it('portafoglio cieco: ci arrivano i prelievi, ma di spese segnate ce ne sono poche', () => {
    const withdraw = (day: number) => tx('transfer', 5_000, d(day, 9), { toAccountId: 'cash' })
    const spend = (day: number) => tx('expense', 500, d(day, 10), { accountId: 'cash' })
    const accounts = [account('main'), cash, { ...account('piggy'), name: 'Salvadanaio' }]
    const wallets = (list: Transaction[]) => [...opaqueWallets(list, accounts, m(0), m(1), d(31, 23))]
    expect(wallets([withdraw(2), withdraw(9), withdraw(16), withdraw(23), spend(28), spend(29)])).toEqual(['cash'])
    // Chi segna le spese in contanti una per una non ha niente di nascosto.
    expect(wallets([withdraw(2), withdraw(9), withdraw(16), withdraw(23), spend(3), spend(4), spend(10)])).toEqual([])
    // Pochi prelievi: non basta per dirlo.
    expect(wallets([withdraw(2), withdraw(9), spend(28)])).toEqual([])
    // Un conto che non è contanti non lo diventa perché riceve giroconti.
    expect(wallets([2, 9, 16].map((day) => tx('transfer', 5_000, d(day, 9), { toAccountId: 'piggy' })))).toEqual([])
    // Conta solo il periodo.
    expect([...opaqueWallets([withdraw(2), withdraw(9), withdraw(16)], accounts, m(1), m(2), d(28, 23, 1))]).toEqual([])
  })

  it('senza dettaglio: pagata da un portafoglio cieco, allineamento in meno, o senza categoria vera né esercente', () => {
    const wallets = new Set(['cash'])
    const none = new Set<string>()
    expect(isOpaque(tx('expense', 1, d(1), { accountId: 'cash', categoryId: 'groceries', note: 'Mercato' }), cat('groceries'), wallets)).toBe(true)
    expect(isOpaque(tx('expense', 1, d(1), { accountId: 'cash', categoryId: 'groceries', note: 'Mercato' }), cat('groceries'), none)).toBe(false)
    expect(isOpaque(tx('expense', 1, d(1), { source: 'adjust', categoryId: 'fees' }), cat('fees'), none)).toBe(true)
    expect(isOpaque(tx('expense', 1, d(1)), undefined, none)).toBe(true)
    expect(isOpaque(tx('expense', 1, d(1), { note: 'SPAR' }), undefined, none)).toBe(false)
    expect(isOpaque(tx('expense', 1, d(1), { categoryId: 'other' }), cat('other'), none)).toBe(true)
    expect(isOpaque(tx('expense', 1, d(1), { categoryId: 'other', note: 'PC STORE' }), cat('other'), none)).toBe(false)
    // Una categoria vera dice già dove sono andati, anche senza nota. Il nome della categoria non conta.
    expect(isOpaque(tx('expense', 1, d(1), { categoryId: 'groceries' }), cat('groceries'), none)).toBe(false)
    expect(isOpaque(tx('expense', 1, d(1), { categoryId: 'unknown' }), cat('unknown', { key: undefined, name: 'Unknown' }), none)).toBe(false)
    expect(isOpaque(tx('income', 1, d(1)), undefined, wallets)).toBe(false)
  })

  const now = d(13, 12, 3) // 13 aprile
  const months = [m(0), m(1), m(2)]
  const list = [
    tx('expense', 4_000, d(5, 9, 0), { categoryId: 'home', note: 'Affitto mese di gennaio' }),
    tx('expense', 4_000, d(5, 9, 1), { categoryId: 'home', note: 'Affitto mese di febbraio' }),
    tx('expense', 4_000, d(5, 9, 2), { categoryId: 'home', note: 'Affitto mese di marzo' }),
    tx('expense', 600, d(7, 9, 0), { categoryId: 'groceries', note: 'FARMACIA ROSSI CENTRO 1' }),
    tx('expense', 900, d(9, 9, 0), { categoryId: 'groceries', note: 'FARMACIA ROSSI CENTRO 2' }),
    tx('expense', 500, d(9, 9, 2), { categoryId: 'groceries', goalId: 'g' }),
    tx('expense', 2_750, d(28, 9, 1), { categoryId: 'unknown', accountId: 'cash', note: 'Contanti · febbraio 2026' }),
    tx('expense', 250, d(12, 9, 1), { source: 'adjust', categoryId: 'fees', note: 'Allineamento saldo' }),
    tx('income', 9_000, d(1, 9, 0)),
    tx('transfer', 3_000, d(2, 9, 0), { toAccountId: 'cash' }),
    tx('save', 1_000, d(3, 9, 0), { goalId: 'g' }),
    tx('expense', 7_777, d(2, 9, 3), { categoryId: 'groceries' }),
    tx('expense', 2_000, d(20, 9, 11, 2025), { categoryId: 'groceries', note: 'FARMACIA ROSSI CENTRO 1' }),
    tx('expense', 4_000, d(5, 9, 11, 2025), { categoryId: 'home', note: 'Affitto mese di dicembre' }),
  ]

  it('le uscite del periodo: quelle avvenute nei mesi dati, allineamenti in meno compresi', () => {
    expect(spendingIn(list, months, now).map((t) => t.mainAmount)).toEqual([4_000, 4_000, 4_000, 600, 900, 500, 2_750, 250])
    expect(spendingIn(list, [], now)).toEqual([])
    // Una spesa con data futura non c'è ancora.
    expect(spendingIn(list, [m(3)], d(1, 12, 3))).toEqual([])
  })

  const s = spendingBreakdown(list, months, [m(9, 2025), m(10, 2025), m(11, 2025)], now, ctx)

  it('totali del periodo e mese tipico', () => {
    expect([s.total, s.count, s.perMonth, s.typicalMonth]).toEqual([17_000, 8, 5_667, 5_500])
  })

  it('le spese senza dettaglio stanno a parte quando pesano almeno un decimo, e le quote restano sul totale vero', () => {
    expect(s.opaque).toMatchObject({ total: 3_000, count: 2, cash: true, separate: true, byMonth: [0, 3_000, 0] })
    expect(s.opaque.share).toBeCloseTo(3 / 17)
    expect(s.categories.map((r) => [r.id, r.total, r.count, r.median])).toEqual([
      ['home', 12_000, 3, 4_000],
      ['groceries', 2_000, 3, 600],
    ])
    expect(s.categories[0].share).toBeCloseTo(12 / 17)
    expect(s.categories.reduce((sum, r) => sum + r.share, 0) + s.opaque.share).toBeCloseTo(1)
  })

  it('andamento mensile e mese che pesa da solo', () => {
    expect(s.categories[1].byMonth).toEqual([1_500, 0, 500])
    expect(s.categories[1].lumpy).toEqual({ month: m(0), share: 0.75 })
    expect(s.categories[0].lumpy).toBeNull()
  })

  it('confronto col periodo prima: solo se c’è, e solo se la differenza conta', () => {
    expect(s.categories[0].deltaPct).toBe(200)
    // Stesso totale di prima: niente da dire.
    expect(s.categories[1].deltaPct).toBeNull()
    expect(s.categories.map((r) => r.isNew)).toEqual([false, false])
    const alone = spendingBreakdown(list, months, null, now, ctx)
    expect(alone.categories.map((r) => [r.deltaPct, r.isNew])).toEqual([[null, false], [null, false]])
    const fresh = spendingBreakdown(list, months, [m(6, 2025), m(7, 2025), m(8, 2025)], now, ctx)
    expect(fresh.categories.map((r) => [r.deltaPct, r.isNew])).toEqual([[null, true], [null, true]])
  })

  it('per esercente: le scritture dello stesso negozio stanno insieme, col nome e la categoria giusti', () => {
    expect(s.payees.map((r) => [r.id, r.name, r.total, r.count, r.categoryId])).toEqual([
      ['affitto', 'Affitto', 12_000, 3, 'home'],
      ['farmacia rossi centro', 'FARMACIA ROSSI CENTRO', 1_500, 2, 'groceries'],
    ])
    // Tra le spese dettagliate, quelle con un esercente: 13.500 su 14.000.
    expect(s.payeeCoverage).toBeCloseTo(13_500 / 14_000)
  })

  it('i movimenti di una riga: categoria, esercente, spese senza dettaglio', () => {
    const spend = spendingIn(list, months, now)
    expect(rowTransactions(spend, true, 'category', 'groceries', ctx).map((t) => t.mainAmount)).toEqual([600, 900, 500])
    expect(rowTransactions(spend, true, 'payee', 'farmacia rossi centro', ctx).map((t) => t.mainAmount)).toEqual([600, 900])
    expect(rowTransactions(spend, true, 'opaque', '', ctx).map((t) => t.mainAmount)).toEqual([2_750, 250])
    // Se le spese senza dettaglio non stanno a parte, restano nella loro categoria.
    expect(rowTransactions(spend, false, 'category', 'unknown', ctx).map((t) => t.mainAmount)).toEqual([2_750])
  })

  it('sotto un decimo le spese senza dettaglio restano nelle loro categorie', () => {
    const few = spendingBreakdown([...list.filter((t) => t.categoryId !== 'unknown' && t.source !== 'adjust'), tx('expense', 300, d(28, 9, 1), { categoryId: 'unknown', accountId: 'cash' })], months, null, now, ctx)
    expect(few.opaque).toMatchObject({ total: 300, separate: false })
    expect(few.categories.map((r) => r.id)).toEqual(['home', 'groceries', 'unknown'])
  })

  it('periodo senza uscite: tutto a zero, senza dividere per zero', () => {
    const empty = spendingBreakdown([], months, null, now, ctx)
    expect([empty.total, empty.perMonth, empty.typicalMonth, empty.payeeCoverage, empty.opaque.share]).toEqual([0, 0, 0, 0, 0])
    expect(empty.categories).toEqual([])
  })
})

describe('mettere da parte', () => {
  const flow = (month: number, inc: number, out: number, adjustIn = 0) => ({ month: m(month), in: inc, adjustIn, out, fromGoal: 0, saved: 0, net: inc + adjustIn - out, count: 1 })

  it('rimasto, quota delle entrate, mese tipico e mesi in positivo', () => {
    const s = savingSummary([flow(0, 1_000, 900), flow(1, 1_000, 1_300), flow(2, 1_000, 750, 50), flow(3, 1_000, 950)], [200, 150, 320, 300])
    expect([s.n, s.kept, s.typical, s.positive]).toEqual([4, 150, 75, 3])
    // Gli allineamenti in più stanno nel conto di quello che è rimasto, e quindi anche in quello di ciò che è arrivato.
    expect(s.rate).toBeCloseTo(150 / 4_050)
    // Il cuscinetto: il minimo tipico degli ultimi tre mesi, e quanti mesi di spese copre.
    expect([s.cushion, s.cushionBefore, s.runway]).toEqual([300, null, 0.3])
  })

  it('la quota non supera mai il cento per cento, nemmeno con un allineamento grosso', () => {
    // Entrate segnate 300, un allineamento in più di 3.000 (uno stipendio mai segnato), uscite 2.000.
    const s = savingSummary([flow(0, 100, 700, 3_000), flow(1, 100, 700), flow(2, 100, 600)], [])
    expect(s.kept).toBe(1_300)
    expect(s.rate).toBeCloseTo(1_300 / 3_300)
  })

  it('il cuscinetto si confronta coi tre mesi prima quando ci sono', () => {
    const s = savingSummary([0, 1, 2, 3, 4, 5].map((i) => flow(i, 1_000, 1_000)), [100, 120, 110, 300, 280, 310])
    expect([s.cushion, s.cushionBefore]).toEqual([300, 110])
  })

  it('con meno di tre mesi, o senza entrate, niente quota; senza minimi niente cuscinetto', () => {
    expect(savingSummary([flow(0, 1_000, 900), flow(1, 1_000, 800)], [1, 2]).rate).toBeNull()
    expect(savingSummary([flow(0, 0, 900), flow(1, 0, 800), flow(2, 0, 100)], []).rate).toBeNull()
    expect(savingSummary([], [])).toMatchObject({ n: 0, kept: 0, typical: 0, cushion: null, runway: null })
  })

  describe('soldi mai toccati', () => {
    const now = d(13, 12, 9) // 13 ottobre 2026
    /** Otto mesi: stipendio il primo, spese fino a lasciare `left` sopra il saldo di partenza ogni mese. */
    const steady = (opening: number): Transaction[] => {
      const list = [tx('opening', opening, d(1, 8, 1), { id: 'opening-main' })]
      for (let month = 1; month <= 9; month++) {
        list.push(tx('income', 100_000, d(1, 9, month), { note: 'Stipendio' }))
        if (month < 9) for (const day of [5, 12, 19, 26]) list.push(tx('expense', 25_000, d(day, 9, month), { categoryId: 'groceries' }))
      }
      return list
    }
    const none = new Set<string>()

    it('il punto più basso di sei mesi, meno mezzo mese di spese, arrotondato in giù; mai più di metà', () => {
      // Il fondo è il saldo di partenza (ogni mese torna lì). Mezzo mese di spese: 50.000.
      expect(idleStep(steady(183_500), { now, typicalMonth: 100_000, wallets: none })).toEqual({ amount: 91_000, floor: 183_500, left: 92_500 })
      expect(idleStep(steady(123_456), { now, typicalMonth: 100_000, wallets: none })).toEqual({ amount: 61_000, floor: 123_456, left: 62_456 })
      // Con un fondo alto vale il tetto della metà: la cifra proposta non è mai più di metà di quello che c'era.
      expect(idleStep(steady(600_000), { now, typicalMonth: 100_000, wallets: none })?.amount).toBe(300_000)
    })

    it('niente se resterebbe meno di mezzo mese di spese, se la cifra è piccola, o se la storia è corta', () => {
      expect(idleStep(steady(50_000), { now, typicalMonth: 100_000, wallets: none })).toBeNull()
      expect(idleStep(steady(58_000), { now, typicalMonth: 100_000, wallets: none })).toBeNull()
      expect(idleStep(steady(183_500), { now, typicalMonth: 0, wallets: none })).toBeNull()
      const short = steady(183_500).filter((t) => t.kind === 'opening' || t.date >= m(6))
      expect(idleStep(short, { now, typicalMonth: 100_000, wallets: none })).toBeNull()
    })

    it('i contanti fermi in un portafoglio cieco non contano: un prelievo vale come un’uscita il giorno in cui è fatto', () => {
      const list = steady(183_500)
      // Due prelievi da 30.000 ad agosto e settembre, non ancora segnati come spesi: sulla carta sono ancora "disponibili".
      for (const month of [7, 8]) list.push(tx('transfer', 30_000, d(2, 9, month), { toAccountId: 'cash' }))
      list.sort((a, b) => a.date - b.date)
      // Chi non sa che il portafoglio è cieco conta anche quei contanti, e propone troppo.
      expect(idleStep(list, { now, typicalMonth: 100_000, wallets: none })).toEqual({ amount: 91_000, floor: 183_500, left: 92_500 })
      expect(idleStep(list, { now, typicalMonth: 100_000, wallets: new Set(['cash']) })).toEqual({ amount: 61_000, floor: 123_500, left: 62_500 })
      // Segnarli dopo come spesa non li toglie due volte.
      list.push(tx('expense', 60_000, d(5, 9, 9), { accountId: 'cash', categoryId: 'unknown' }))
      expect(idleStep(list, { now, typicalMonth: 100_000, wallets: new Set(['cash']) })?.floor).toBe(123_500)
    })

    it('dopo aver messo da parte la cifra proposta non la propone di nuovo', () => {
      const list = steady(183_500)
      const first = idleStep(list, { now, typicalMonth: 100_000, wallets: none })!
      list.push(tx('save', first.amount, d(13, 10, 9), { goalId: 'g' }))
      // Restano 750 da poter spostare: troppo poco per dirlo.
      expect(idleStep(list, { now, typicalMonth: 100_000, wallets: none })).toBeNull()
      // Con un fondo alto la metà è il tetto: messa via quella, basta.
      const rich = steady(600_000)
      rich.push(tx('save', 300_000, d(13, 10, 9), { goalId: 'g' }))
      expect(idleStep(rich, { now, typicalMonth: 100_000, wallets: none })).toBeNull()
      // Messa via solo una parte, propone il resto, e dice quanto resterebbe davvero nel punto più basso.
      const part = steady(600_000)
      part.push(tx('save', 100_000, d(10, 10, 8), { goalId: 'g' }))
      expect(idleStep(part, { now, typicalMonth: 100_000, wallets: none })).toEqual({ amount: 200_000, floor: 500_000, left: 300_000 })
      // Soldi ripresi da un obiettivo tornano tra quelli fermi.
      part.push(tx('release', 100_000, d(12, 10, 8), { goalId: 'g' }))
      expect(idleStep(part, { now, typicalMonth: 100_000, wallets: none })?.amount).toBe(300_000)
    })

    it('soldi messi da parte prima della finestra e ripresi dentro tornano disponibili quel giorno, non spariscono', () => {
      const list = steady(183_500)
      // Messi via a febbraio (fuori dalla finestra), ripresi e spesi il 10 settembre: il disponibile non è mai sceso sotto 133.500.
      list.push(tx('save', 50_000, d(10, 10, 1), { goalId: 'g' }), tx('release', 50_000, d(10, 10, 8), { goalId: 'g' }), tx('expense', 50_000, d(10, 11, 8), { categoryId: 'home' }))
      expect(idleStep(list, { now, typicalMonth: 100_000, wallets: none })).toEqual({ amount: 66_000, floor: 133_500, left: 67_500 })
    })

    it('un obiettivo non sta in nessun conto: conta anche se sul movimento è scritto il portafoglio dei contanti', () => {
      const list = steady(183_500)
      list.push(tx('save', 91_000, d(13, 10, 9), { goalId: 'g', accountId: 'cash' }))
      expect(idleStep(list, { now, typicalMonth: 100_000, wallets: new Set(['cash']) })).toBeNull()
    })
  })
})

describe('da dove cominciare', () => {
  const now = d(13, 12, 9) // 13 ottobre 2026
  const kinds = (list: Lever[]) => list.map((l) => l.kind)
  /** Dodici mesi interi (ottobre 2025 – settembre 2026) con stipendio, affitto e spesa: niente da segnalare. */
  const base = (): Transaction[] => {
    const list: Transaction[] = [tx('opening', 20_000, d(1, 8, 8, 2025), { id: 'opening-main' })]
    for (let i = 0; i < 12; i++) {
      const month = 9 + i
      list.push(tx('income', 100_000, d(1, 9, month, 2025), { note: 'Stipendio' }))
      list.push(tx('expense', 40_000, d(2, 9, month, 2025), { categoryId: 'home', note: 'Affitto' }))
      for (const day of [4, 9, 14, 19, 24]) list.push(tx('expense', 9_000 + ((i * 7 + day) % 5) * 800, d(day, 9, month, 2025), { categoryId: 'groceries', note: 'Mercato rionale' }))
      list.push(tx('expense', 9_000, d(27, 9, month, 2025), { categoryId: 'fun', note: `Uscita ${i}` }))
    }
    return list
  }
  const run = (transactions: Transaction[], context = ctx, months?: number[]) => levers(transactions, months ?? periodMonths(fullMonths(transactions, now), 12), now, context, 1)
  const find = <K extends Lever['kind']>(list: Lever[], kind: K) => list.find((l) => l.kind === kind) as Extract<Lever, { kind: K }> | undefined

  it('con meno di tre mesi interi non si suggerisce niente', () => {
    expect(run(base(), ctx, [m(7), m(8)])).toEqual([])
    expect(run([], ctx, [])).toEqual([])
  })

  it('un bilancio tranquillo non fa scattare niente', () => {
    expect(kinds(run(base()))).toEqual([])
  })

  it('spese senza dettaglio: da un quinto delle uscite in su, e sempre per prime', () => {
    const list = base()
    for (let i = 0; i < 12; i++) list.push(tx('expense', 40_000, d(28, 9, 9 + i, 2025), { categoryId: 'unknown', accountId: 'cash', note: 'Contanti' }))
    const out = run(list)
    expect(out[0]).toMatchObject({ kind: 'cash', perMonth: 40_000, cash: true })
    expect(find(out, 'cash')!.share).toBeGreaterThan(0.2)
    // Sotto la soglia non scatta.
    const few = base()
    for (let i = 0; i < 12; i++) few.push(tx('expense', 5_000, d(28, 9, 9 + i, 2025), { categoryId: 'unknown', accountId: 'cash' }))
    expect(kinds(run(few))).not.toContain('cash')
    // Senza categoria né nota, sul conto: sono senza dettaglio ma non contanti.
    const bare = base()
    for (let i = 0; i < 12; i++) bare.push(tx('expense', 40_000, d(28, 9, 9 + i, 2025)))
    expect(find(run(bare, open), 'cash')).toMatchObject({ cash: false })
  })

  it('una categoria sopra il suo solito: gli ultimi tre mesi contro quelli prima, a mediane', () => {
    const list = base()
    // Luglio, agosto e settembre 2026: gli ultimi tre mesi interi.
    for (const month of [18, 19, 20]) for (const day of [5, 12, 20]) list.push(tx('expense', 12_000, d(day, 15, month, 2025), { categoryId: 'fun', note: `Serata ${month}-${day}` }))
    expect(find(run(list), 'rise')).toEqual({ kind: 'rise', categoryId: 'fun', recent: 45_000, base: 9_000, excess: 36_000, before: 81_000, beforeMonths: 9 })
  })

  it('un acquisto solo, anche enorme, non è una tendenza', () => {
    const once = base()
    once.push(tx('expense', 200_000, d(10, 15, 19, 2025), { categoryId: 'fun', note: 'Viaggio' }))
    expect(kinds(run(once))).not.toContain('rise')
  })

  it('una categoria comparsa da poco conta come sopra il solito, ma con meno di sei mesi non si giudica', () => {
    const list = base()
    for (const month of [19, 20]) list.push(tx('expense', 15_000, d(11, 15, month, 2025), { categoryId: 'other', note: 'Corso di nuoto' }))
    expect(find(run(list), 'rise')).toMatchObject({ categoryId: 'other', recent: 15_000, base: 0, before: 0 })
    expect(kinds(run(list, ctx, [m(4), m(5), m(6), m(7), m(8)]))).not.toContain('rise')
  })

  it('una voce saltuaria non è "nuova": si sa quanto era prima, e se in media era già così non è una salita', () => {
    // Regali: una volta sola a novembre, poi ogni mese da luglio. La mediana di prima è zero, ma la voce c'era.
    const gifts = base()
    gifts.push(tx('expense', 30_000, d(10, 15, 10, 2025), { categoryId: 'other', note: 'Regalo di nozze' }))
    for (const month of [18, 19, 20]) gifts.push(tx('expense', 15_000, d(11, 15, month, 2025), { categoryId: 'other', note: 'Regalo' }))
    expect(find(run(gifts), 'rise')).toMatchObject({ categoryId: 'other', recent: 15_000, base: 0, before: 30_000, beforeMonths: 9 })
    // Salute: quattro mesi su nove prima, per una media già pari a quella di adesso.
    const health = base()
    for (const month of [10, 12, 14, 16]) health.push(tx('expense', 36_000, d(10, 15, month, 2025), { categoryId: 'other', note: 'Visita' }))
    for (const month of [18, 19, 20]) health.push(tx('expense', 16_000, d(11, 15, month, 2025), { categoryId: 'other', note: 'Visita' }))
    expect(kinds(run(health))).not.toContain('rise')
  })

  it('commissioni che tornano: almeno due al mese, e "la metà" solo se costano sempre uguale', () => {
    const list = base()
    for (let i = 0; i < 12; i++) for (const day of [3, 8, 13, 18, 23, 26]) list.push(tx('expense', 200, d(day, 9, 9 + i, 2025), { categoryId: 'fees', note: 'Commissione prelievo' }))
    expect(find(run(list), 'fees')).toEqual({ kind: 'fees', key: 'commissione prelievo', name: 'Commissione prelievo', categoryId: 'fees', count: 72, months: 12, total: 14_400, half: 7_200 })
    // La metà è di quello che è costato nei mesi misurati: su tre mesi non diventa una cifra "all'anno".
    expect(find(run(list, ctx, [m(6), m(7), m(8)]), 'fees')).toMatchObject({ count: 18, months: 3, total: 3_600, half: 1_800 })
    // Importi che cambiano ogni volta: si dice quanto e quante volte, non "la metà".
    const varied = base()
    for (let i = 0; i < 12; i++) for (const day of [3, 8, 13]) varied.push(tx('expense', 100 + day * 40 + i, d(day, 9, 9 + i, 2025), { categoryId: 'fees', note: 'Commissione carta' }))
    expect(find(run(varied), 'fees')).toMatchObject({ count: 36, half: null })
  })

  it('commissioni rare o minuscole non si segnalano, e gli allineamenti non sono commissioni', () => {
    const rare = base()
    for (let i = 0; i < 12; i++) rare.push(tx('expense', 500, d(1, 9, 9 + i, 2025), { categoryId: 'fees', note: 'Tenuta conto' }))
    expect(kinds(run(rare))).not.toContain('fees')
    const tiny = base()
    for (let i = 0; i < 12; i++) for (const day of [3, 8]) tiny.push(tx('expense', 5, d(day, 9, 9 + i, 2025), { categoryId: 'fees', note: 'Bollo' }))
    expect(kinds(run(tiny))).not.toContain('fees')
    const adjusted = base()
    for (let i = 0; i < 12; i++) for (const day of [3, 8, 13]) adjusted.push(tx('expense', 300, d(day, 9, 9 + i, 2025), { categoryId: 'fees', source: 'adjust', note: 'Allineamento saldo' }))
    expect(kinds(run(adjusted))).not.toContain('fees')
  })

  it('l’ordine è fisso: senza dettaglio, sopra il solito, commissioni', () => {
    const list = base()
    for (let i = 0; i < 12; i++) {
      list.push(tx('expense', 40_000, d(28, 9, 9 + i, 2025), { categoryId: 'unknown', accountId: 'cash' }))
      for (const day of [3, 8, 13, 18, 23, 26]) list.push(tx('expense', 200, d(day, 9, 9 + i, 2025), { categoryId: 'fees', note: 'Commissione prelievo' }))
    }
    for (const month of [18, 19, 20]) for (const day of [5, 12, 20]) list.push(tx('expense', 12_000, d(day, 15, month, 2025), { categoryId: 'fun', note: `Serata ${month}-${day}` }))
    expect(kinds(run(list))).toEqual(['cash', 'rise', 'fees'])
  })
})

describe('per disegnare', () => {
  it('asse del saldo: da zero se il minimo è basso rispetto al massimo, altrimenti da poco sotto il minimo', () => {
    expect(yAxis(9_000, 770_000).ticks).toEqual([0, 200_000, 400_000, 600_000, 800_000])
    expect(yAxis(410_000, 480_000).ticks).toEqual([400_000, 420_000, 440_000, 460_000, 480_000])
    expect(yAxis(-30_000, 90_000).ticks).toEqual([-50_000, 0, 50_000, 100_000])
    // Una linea piatta sta tra lo zero e il suo valore.
    expect(yAxis(500, 500).ticks).toEqual([0, 200, 400, 600])
    expect(yAxis(-500, -500).ticks).toEqual([-600, -400, -200, 0])
    expect(yAxis(0, 0).ticks).toEqual([0, 1])
  })

  it('estremi e tacche hanno lo stesso passo: la linea sta sempre tra due righe, qualunque intervallo', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647
    const ranges: [number, number][] = [[0, 7], [0, 123_456], [-999, 31], [1_000, 1_001], [3, 4], [4_150, 4_530], [-50, 330], [188_963, 260_090], [632_225, 1_016_573]]
    for (let i = 0; i < 400; i++) {
      const a = Math.round((rnd() - 0.3) * 10 ** (1 + Math.floor(rnd() * 7)))
      ranges.push([a, a + 1 + Math.round(rnd() * 10 ** (1 + Math.floor(rnd() * 7)))])
    }
    for (const [min, max] of ranges) {
      const axis = yAxis(min, max)
      expect(axis.lo).toBeLessThanOrEqual(min)
      expect(axis.hi).toBeGreaterThanOrEqual(max)
      expect([axis.ticks[0], axis.ticks[axis.ticks.length - 1]]).toEqual([axis.lo, axis.hi])
      expect(axis.ticks.length).toBeGreaterThanOrEqual(2)
      expect(axis.ticks.length).toBeLessThanOrEqual(6)
      // Tacche intere, tutte diverse, alla stessa distanza; lo zero è una tacca quando l'asse lo attraversa.
      for (let k = 1; k < axis.ticks.length; k++) expect(axis.ticks[k] - axis.ticks[k - 1]).toBe(axis.step)
      expect(Number.isInteger(axis.step) && axis.step >= 1).toBe(true)
      if (axis.lo < 0 && axis.hi > 0) expect(axis.ticks).toContain(0)
    }
  })

  it('le scritte corte dell’asse: una sola unità, e i decimali che servono perché due tacche non si leggano uguali', () => {
    const scale = (min: number, max: number, unit = 1) => {
      const axis = yAxis(min, max)
      return axisScale(axis.ticks, axis.step, unit)
    }
    // 0, 200 mila … 800 mila.
    expect(scale(9_000, 770_000)).toEqual({ div: 1_000, decimals: 0 })
    // 10 mila, 10,5 mila, 11 mila…
    expect(scale(10_200, 11_900)).toEqual({ div: 1_000, decimals: 1 })
    // 1,2 mln, 1,25 mln, 1,3 mln…
    expect(scale(1_200_000, 1_380_000)).toEqual({ div: 1_000_000, decimals: 2 })
    // Sotto diecimila la cifra si scrive intera.
    expect(scale(0, 4_000)).toEqual({ div: 1, decimals: 0 })
    // In euro (unità minima il centesimo): 10.200 € – 11.900 € si leggono come migliaia di euro.
    expect(scale(1_020_000, 1_190_000, 100)).toEqual({ div: 1_000, decimals: 1 })
    // Tre euro e cinquanta: passo di mezzo euro, un decimale.
    expect(scale(300, 450, 100)).toEqual({ div: 1, decimals: 1 })
  })

  it('le etichette dei mesi: a passo regolare da gennaio, con l’anno sulla prima e quando cambia', () => {
    const run = (first: number, count: number, pitch: number) =>
      monthLabels(Array.from({ length: count }, (_, i) => m(first + i, 2025)), pitch, 24, 42).map((l) => {
        const date = new Date(l.month)
        return `${date.getMonth() + 1}${l.withYear ? '/' + (date.getFullYear() % 100) : ''}`
      })
    // Tredici colonne larghe: dentro un anno solo basterebbe ogni mese, ma qui gli anni sono due e serve posto per scriverli.
    expect(run(9, 13, 24)).toEqual(['11/25', '1/26', '3', '5', '7', '9'])
    // Stesso anno, colonne larghe: ogni mese, l'anno solo sul primo.
    expect(run(0, 6, 30)).toEqual(['1/25', '2', '3', '4', '5', '6'])
    // Schermo stretto: ogni tre mesi, da gennaio.
    expect(run(9, 13, 19.7)).toEqual(['10/25', '1/26', '4', '7', '10'])
    // Cinque anni in poco spazio: solo i gennai, ognuno col suo anno.
    expect(run(7, 62, 4)).toEqual(['1/26', '1/27', '1/28', '1/29', '1/30'])
    // Ancora più stretto: un gennaio ogni due anni.
    expect(run(7, 62, 2)).toEqual(['1/26', '1/28', '1/30'])
    // Pochi mesi e nessuno sul passo: si scrive il primo.
    expect(run(1, 2, 5)).toEqual(['2/25'])
    expect(monthLabels([], 20, 24, 42)).toEqual([])
  })

  it('il giorno più vicino al dito, senza uscire dalla serie', () => {
    expect(nearestIndex(11, 100, 0)).toBe(0)
    expect(nearestIndex(11, 100, 49)).toBe(5)
    expect(nearestIndex(11, 100, 100)).toBe(10)
    expect(nearestIndex(11, 100, -40)).toBe(0)
    expect(nearestIndex(11, 100, 900)).toBe(10)
    expect(nearestIndex(1, 100, 50)).toBe(0)
    expect(nearestIndex(11, 0, 50)).toBe(0)
  })
})

/** Dente di sega: paga di `pay` ogni `every` giorni (la prima il giorno `first`), `spend` al giorno, più qualche giorno pesante. */
const saw = (days: number, start: number, pay: number, every: number, first: number, spend: number, heavy: Record<number, number> = {}) => {
  const values: number[] = [start]
  for (let i = 1; i < days; i++) values.push(values[i - 1] + (i >= first && (i - first) % every === 0 ? pay : -spend) - (heavy[i] ?? 0))
  return series(...values)
}

describe('salite e discese', () => {
  it('la soglia è il 6% dell’altezza dell’asse; zero con una linea piatta o con un punto solo', () => {
    const points = series(100, 500)
    const { lo, hi } = yAxis(100, 500)
    expect(swingThreshold(points)).toBeCloseTo(0.06 * (hi - lo))
    expect(swingThreshold(series(5, 5, 5))).toBe(0)
    expect(swingThreshold(series(5))).toBe(0)
  })

  it('una svolta c’è quando la linea torna indietro di almeno la soglia', () => {
    expect(turningPoints(series(100, 200, 190, 300, 100, 150), 50)).toEqual([
      { index: 0, kind: 'low' },
      { index: 3, kind: 'high' },
      { index: 4, kind: 'low' },
    ])
  })

  it('il giorno della svolta è il primo in cui la linea tocca quel valore', () => {
    expect(turningPoints(series(100, 300, 300, 300, 100, 100, 100, 300), 50)).toEqual([
      { index: 0, kind: 'low' },
      { index: 1, kind: 'high' },
      { index: 4, kind: 'low' },
    ])
  })

  it('un ritorno più piccolo della soglia resta dentro il tratto', () => {
    expect(turningPoints(series(500, 400, 420, 300, 310, 100), 50)).toEqual([{ index: 0, kind: 'high' }])
  })

  it('l’estremo in sospeso entra in coda solo se non è l’ultimo giorno', () => {
    expect(turningPoints(series(100, 300, 280), 50)).toEqual([
      { index: 0, kind: 'low' },
      { index: 1, kind: 'high' },
    ])
    expect(turningPoints(series(100, 300, 320), 50)).toEqual([{ index: 0, kind: 'low' }])
  })

  it('niente svolte con una linea piatta, con meno di due punti o con una soglia nulla', () => {
    expect(turningPoints(series(7, 7, 7, 7), 1)).toEqual([])
    expect(turningPoints(series(7), 1)).toEqual([])
    expect(turningPoints(series(1, 9, 1), 0)).toEqual([])
    expect(turningPoints(series(100, 120, 110, 125), 50)).toEqual([])
  })

  it('i tratti si toccano: dal primo giorno all’ultimo, ognuno comincia dove finisce quello prima, e i conti tornano', () => {
    const points = saw(100, 1000, 3000, 30, 5, 100)
    const { list } = findSwings(points)
    expect(list[0].fromIndex).toBe(0)
    expect(list[list.length - 1].toIndex).toBe(points.length - 1)
    list.forEach((s, k) => k > 0 && expect(s.fromIndex).toBe(list[k - 1].toIndex))
    expect(list.reduce((sum, s) => sum + (s.dir === 'up' ? s.amount : -s.amount), 0)).toBe(points[points.length - 1].value - points[0].value)
    expect(list.every((s) => s.amount === Math.abs(s.to.value - s.from.value) && s.days === s.toIndex - s.fromIndex && s.id === s.to.day)).toBe(true)
  })

  it('una salita di un giorno e una discesa di quattro settimane sono due tratti', () => {
    const { list } = findSwings(saw(100, 1000, 3000, 30, 5, 100))
    expect(list.map((s) => [s.dir, s.fromIndex, s.toIndex, s.amount])).toEqual([
      ['down', 0, 4, 400],
      ['up', 4, 5, 3000],
      ['down', 5, 34, 2900],
      ['up', 34, 35, 3000],
      ['down', 35, 64, 2900],
      ['up', 64, 65, 3000],
      ['down', 65, 94, 2900],
      ['up', 94, 95, 3000],
      ['down', 95, 99, 400],
    ])
  })

  it('il primo tratto non si sa da dove viene, l’ultimo arriva a oggi ed è in corso: nessuno dei due si confronta col solito', () => {
    const { list } = findSwings(saw(190, 1000, 3000, 30, 5, 100))
    expect(list[0].open).toBe('start')
    expect(list[list.length - 1].open).toBe('running')
    expect(list.slice(1, -1).every((s) => s.open === null)).toBe(true)
    expect([list[0].versus, list[list.length - 1].versus]).toEqual([null, null])
    expect([list[0].notable, list[list.length - 1].notable]).toEqual([false, false])
  })

  it('se dopo l’ultimo alto non succede più niente, non c’è un tratto in corso', () => {
    const { list } = findSwings(series(500, 400, 300, 200, 100, 600, 600, 600), { theta: 50 })
    expect(list.map((s) => [s.dir, s.fromIndex, s.toIndex, s.open])).toEqual([
      ['down', 0, 4, 'start'],
      ['up', 4, 5, null],
    ])
    expect([...swingOfDay(list, 8)]).toEqual([0, 0, 0, 0, 0, 1, 1, 1])
  })

  it('il solito è la mediana, se i tratti sono almeno quattro e almeno metà le somiglia', () => {
    expect(usualSwing([100, 110, 120])).toBeNull()
    expect(usualSwing([100, 110, 120, 400])).toBe(115)
    expect(usualSwing([10, 100, 300, 900])).toBeNull()
    expect(usualSwing([200, 200, 200, 200, 10, 900])).toBe(200)
  })

  it('più del solito da un quarto in su, meno del solito da un quarto in giù; da guardare sono i più grandi', () => {
    // Sei mesi: discese solite da 2.900, una da 3.900 (un giorno pesante) e una paga da 4.000 al posto di 3.000.
    const values: number[] = [1000]
    for (let i = 1; i < 200; i++) values.push(values[i - 1] + (i >= 5 && (i - 5) % 30 === 0 ? (i === 95 ? 4000 : 3000) : -100) - (i === 50 ? 1000 : 0))
    const sw = findSwings(series(...values))
    expect([sw.usualUp, sw.usualDown]).toEqual([3000, 2900])
    const whole = sw.list.filter((s) => s.open === null)
    expect(whole.filter((s) => s.versus === 'more').map((s) => [s.dir, s.amount])).toEqual([
      ['down', 3900],
      ['up', 4000],
    ])
    expect(whole.filter((s) => s.notable).length).toBe(2)
    expect(whole.filter((s) => s.versus === 'same').length).toBe(whole.length - 2)
    expect(findSwings(series(...values), { usual: { up: 6000, down: 2900 } }).list.filter((s) => s.versus === 'less').map((s) => s.dir)).toEqual(Array(7).fill('up'))
  })

  it('il solito può venire da fuori (gli ultimi dodici mesi) e allora vale anche per un periodo corto', () => {
    const short = saw(70, 1000, 3000, 30, 5, 100)
    expect(findSwings(short).usualDown).toBeNull()
    const sw = findSwings(short, { usual: { up: 2000, down: 2900 } })
    expect(sw.list.filter((s) => s.open === null).map((s) => s.versus)).toEqual(['more', 'same', 'more', 'same', 'more'])
  })

  it('senza un ritmo non c’è un solito: da guardare restano i due più grandi per verso', () => {
    const sw = findSwings(series(0, 100, 0, 1000, 0, 300, 0, 3000, 0, 50, 0, 600, 0, 20), { theta: 10 })
    expect([sw.usualUp, sw.usualDown]).toEqual([null, null])
    expect(sw.list.every((s) => s.versus === null)).toBe(true)
    expect(sw.list.filter((s) => s.notable).map((s) => [s.dir, s.amount])).toEqual([
      ['up', 1000],
      ['down', 1000],
      ['up', 3000],
      ['down', 3000],
    ])
  })

  it('i gradini sono i giorni che pesano di più nel verso del tratto: al più tre, in ordine di data', () => {
    // Una discesa di 39 giorni da 100 al giorno, con quattro giorni pesanti: restano i tre più grossi.
    const points = saw(70, 1000, 9000, 40, 5, 100, { 10: 2500, 14: 3000, 20: 2200, 30: 2800 })
    const sw = findSwings(points)
    const fall = sw.list.find((s) => s.dir === 'down' && s.open === null)!
    expect(fall.steps).toEqual([10, 14, 30])
    // Un giorno conta se fa almeno il 15% del tratto e almeno mezza soglia.
    const small = findSwings(saw(70, 1000, 9000, 40, 5, 100, { 14: 300 }))
    expect(small.list.find((s) => s.dir === 'down' && s.open === null)!.steps).toEqual([])
  })

  it('un tratto di un giorno non ha gradini; in una salita di più giorni il gradino è il giorno in cui sono entrati i soldi', () => {
    expect(findSwings(saw(100, 1000, 3000, 30, 5, 100)).list.filter((s) => s.dir === 'up').every((s) => s.steps.length === 0)).toBe(true)
    const { list } = findSwings(series(500, 400, 300, 200, 100, 100, 100, 900, 800, 700), { theta: 50 })
    expect(list.map((s) => [s.dir, s.fromIndex, s.toIndex, s.steps])).toEqual([
      ['down', 0, 4, [1, 2, 3]],
      ['up', 4, 7, [7]],
      ['down', 7, 9, [8, 9]],
    ])
  })

  it('il massimo e il minimo del periodo sono sempre un capo di un tratto', () => {
    for (const points of [saw(200, 1000, 3000, 30, 5, 100, { 50: 1000 }), series(5, 9, 2, 8, 1, 7, 3), series(900, 800, 700, 600)]) {
      const sw = findSwings(points, { theta: 2 })
      const ends = new Set(sw.list.flatMap((s) => [s.fromIndex, s.toIndex]))
      expect(ends.has(sw.highIndex) && ends.has(sw.lowIndex)).toBe(true)
    }
  })

  it('altre vite: sotto zero, senza entrate, piatta, corta', () => {
    // Un saldo sotto zero si legge allo stesso modo.
    const red = findSwings(saw(100, -5000, 3000, 30, 5, 100))
    expect(red.list.map((s) => s.dir)).toEqual(['down', 'up', 'down', 'up', 'down', 'up', 'down', 'up', 'down'])
    // Tanti giorni piccoli e nessuno grande: una discesa sola, in corso, senza gradini.
    const slow = findSwings(saw(200, 100_000, 0, 1000, 999, 300))
    expect(slow.list.map((s) => [s.dir, s.fromIndex, s.toIndex, s.open, s.steps.length])).toEqual([['down', 0, 199, 'running', 0]])
    // Una linea che non si muove non ha tratti.
    expect(findSwings(series(500, 500, 500, 500)).list).toEqual([])
    // Venti giorni: i tratti ci sono, il solito no.
    const short = findSwings(saw(20, 1000, 3000, 30, 5, 100))
    expect(short.list.map((s) => s.dir)).toEqual(['down', 'up', 'down'])
    expect([short.usualUp, short.usualDown]).toEqual([null, null])
    // Una paga a settimana: un tratto in su e uno in giù ogni settimana.
    const weekly = findSwings(saw(71, 1000, 700, 7, 3, 100))
    expect(weekly.list.filter((s) => s.dir === 'up').length).toBe(10)
  })

  it('ogni giorno ha il suo tratto: il giorno della svolta appartiene al tratto che ci arriva', () => {
    const { list } = findSwings(saw(40, 1000, 3000, 30, 5, 100))
    const map = swingOfDay(list, 40)
    expect([map[0], map[4], map[5], map[6], map[34], map[35], map[39]]).toEqual([0, 0, 1, 2, 2, 3, 4])
    expect([...swingOfDay([], 3)]).toEqual([-1, -1, -1])
  })

  it('il dito si ferma sull’arrivo o sul gradino più vicino entro la portata, altrimenti resta dov’è', () => {
    const points = saw(70, 1000, 9000, 40, 5, 100, { 14: 2000 })
    const stops = swingStops(findSwings(points).list)
    expect(stops).toEqual([4, 5, 14, 44, 45, 69])
    expect(snapToStop(stops, 12, 3)).toBe(14)
    expect(snapToStop(stops, 17, 3)).toBe(14)
    expect(snapToStop(stops, 25, 3)).toBe(25)
    expect(snapToStop(stops, 9, 4)).toBe(5)
    expect(snapToStop(stops, 44, 5)).toBe(44)
    expect(snapToStop(stops, 30, 0)).toBe(30)
    expect(snapToStop([], 30, 9)).toBe(30)
    // A pari distanza vale la fermata prima.
    expect(snapToStop([10, 20], 15, 5)).toBe(10)
  })

  it('la portata del dito: due pixel e mezzo in giorni, mai più di un terzo di un tratto medio, almeno un giorno', () => {
    expect(touchReach(378, 241, 27)).toBe(4)
    expect(touchReach(105, 241, 9)).toBe(1)
    expect(touchReach(761, 186, 51)).toBe(4)
    expect(touchReach(3000, 186, 199)).toBe(5)
    expect(touchReach(378, 241, 27, 1)).toBe(2)
    expect(touchReach(365, 241, 103)).toBe(1)
    expect(touchReach(378, 241, 0)).toBe(0)
    expect(touchReach(1, 241, 3)).toBe(0)
  })

  it('per ogni giorno: il movimento che ha spostato di più il saldo nel verso della giornata, e quanti sono', () => {
    const list = [
      tx('opening', 5000, d(1, 8)),
      tx('income', 1000, d(2, 9), { note: 'Stipendio' }),
      tx('expense', 300, d(2, 10), { note: 'Mercato' }),
      tx('expense', 200, d(2, 11), { note: 'Bar' }),
      tx('transfer', 400, d(3, 9), { toAccountId: 'cash' }),
      tx('expense', 50, d(4, 9), { note: 'Bar' }),
      tx('expense', 700, d(4, 10), { note: 'Affitto' }),
      tx('income', 20, d(4, 11), { note: 'Rimborso' }),
      tx('save', 250, d(5, 9), { goalId: 'g' }),
      tx('expense', 80, d(6, 9), { note: 'Dopo' }),
    ]
    const now = d(5, 23)
    const points = balanceSeries(list, { from: d(1), now })
    const moves = dayMoves(list, points, { now })
    expect(moves.map((m) => [m.top?.note ?? null, m.count])).toEqual([
      [null, 0],
      ['Stipendio', 3],
      [null, 0],
      ['Affitto', 3],
      [null, 0],
    ])
    // Sul disponibile, mettere da parte muove la linea.
    const avail = dayMoves(list, balanceSeries(list, { from: d(1), now, scope: 'available' }), { now, scope: 'available' })
    expect([avail[4].top?.kind, avail[4].count]).toEqual(['save', 1])
  })

  it('la fetta dei movimenti di un tratto si prende senza scorrerli tutti, e la spiegazione è la stessa', () => {
    const list = [tx('income', 1000, d(2, 9)), tx('expense', 300, d(3, 10), { note: 'Mercato' }), tx('expense', 200, d(4, 0), { note: 'Bar' }), tx('expense', 90, d(5, 0), { note: 'Dopo' })]
    expect(sliceByDate(list, d(3, 0), d(5, 0)).map((t) => t.note)).toEqual(['Mercato', 'Bar'])
    expect(sliceByDate(list, d(9, 0), d(10, 0))).toEqual([])
    const points = balanceSeries(list, { from: d(1), now: d(6) })
    const ctx = { categories: [], wallets: new Set<string>() }
    const whole = explainLeg(list, points[1], points[3], 'low', ctx, { now: d(6) })
    const part = explainLeg(sliceByDate(list, nextDay(points[1].day), nextDay(points[3].day)), points[1], points[3], 'low', ctx, { now: d(6) })
    expect(part).toEqual(whole)
    expect(part.out).toBe(500)
  })
})

describe('i segni della linea', () => {
  it('pieni il massimo, il minimo e i tratti da guardare (al più tre per tipo); poi tutti gli altri arrivi, vuoti; oggi non ha un segno suo', () => {
    const values: number[] = [1000]
    for (let i = 1; i < 200; i++) values.push(values[i - 1] + (i >= 5 && (i - 5) % 30 === 0 ? (i === 95 ? 4000 : 3000) : -100) - (i === 50 ? 1000 : 0))
    const points = series(...values)
    const sw = findSwings(points)
    const marks = swingMarks(points, sw)
    expect(marks.slice(0, 2)).toEqual([
      { index: sw.highIndex, kind: 'high', filled: true, label: true },
      { index: sw.lowIndex, kind: 'low', filled: true, label: true },
    ])
    expect(marks.filter((m) => m.filled).length).toBeLessThanOrEqual(6)
    expect(marks.some((m) => m.index === points.length - 1)).toBe(false)
    expect(new Set(marks.map((m) => m.index)).size).toBe(marks.length)
    // Ogni arrivo ha il suo segno: un tondo dove finisce una salita, un rombo dove finisce una discesa.
    for (const s of sw.list.filter((x) => x.open !== 'running')) expect(marks.find((m) => m.index === s.toIndex)?.kind).toBe(s.dir === 'up' ? 'high' : 'low')
    expect(swingMarks(series(5, 5, 5), findSwings(series(5, 5, 5)))).toEqual([])
    // Con meno di due settimane il massimo e il minimo non hanno la cifra scritta.
    const few = series(100, 900, 800, 700)
    expect(swingMarks(few, findSwings(few)).every((m) => !m.label)).toBe(true)
  })

  it('un segno che finirebbe addosso a uno già messo si salta: l’ordine dà la precedenza', () => {
    const a = { x: 10, y: 10 }
    const b = { x: 15, y: 14 }
    const c = { x: 15, y: 40 }
    const e = { x: 30, y: 12 }
    expect(placeMarks([a, b, c, e], 12)).toEqual([a, c, e])
    expect(placeMarks([b, a, c, e], 12)).toEqual([b, c, e])
  })
})
