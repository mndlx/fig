import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../currencyGuess', () => ({ guessCurrency: () => 'EUR' }))

import { accountBalanceOf } from '../data'
import { db, type Account, type Currency, type Recurring, type Transaction } from '../db'
import { rebaseRule, rebaseTransaction, sideAmount, sideNeedsOwn, simplestRate } from '../money'
import { createSeries } from '../recurring'
import { ALL, EUR, account, tx } from './helpers'

const USD: Currency = { code: 'USD', symbol: '$', decimals: 2 }
const LIST = [EUR, ALL, USD]
const NOW = new Date(2026, 9, 20).getTime()
const day = (d: number) => new Date(2026, 9, d, 12).getTime()
const balance = (acc: Account, txs: Transaction[], main: string) => accountBalanceOf(acc, txs, main, NOW)

describe('quanto un movimento sposta su un conto', () => {
  it('serve un importo a parte solo se il conto non è né nella valuta del movimento né nella principale', () => {
    expect(sideNeedsOwn('EUR', 'EUR', 'ALL')).toBe(false)
    expect(sideNeedsOwn('EUR', 'ALL', 'ALL')).toBe(false)
    expect(sideNeedsOwn('ALL', 'ALL', 'ALL')).toBe(false)
    // Spesa in lek dal conto in euro; spesa in euro dal conto in dollari.
    expect(sideNeedsOwn('ALL', 'EUR', 'ALL')).toBe(true)
    expect(sideNeedsOwn('EUR', 'USD', 'ALL')).toBe(true)
  })

  it('l’importo, il controvalore o quello salvato a parte, secondo la valuta del conto', () => {
    // 20,00 € a 97 = 1.940 L.
    const euro = { amount: 2000, currency: 'EUR', mainAmount: 1940 }
    expect(sideAmount(euro, 'from', 'EUR', 'ALL')).toBe(2000)
    expect(sideAmount(euro, 'from', 'ALL', 'ALL')).toBe(1940)
    // Pagata dal conto in dollari: non si sa, finché non è scritto.
    expect(sideAmount(euro, 'from', 'USD', 'ALL')).toBeNull()
    expect(sideAmount({ ...euro, accountAmount: 2109 }, 'from', 'USD', 'ALL')).toBe(2109)
    // Ogni lato ha il suo.
    const moved = { amount: 5000, currency: 'ALL', mainAmount: 5000, toAccountAmount: 5128 }
    expect(sideAmount(moved, 'from', 'ALL', 'ALL')).toBe(5000)
    expect(sideAmount(moved, 'to', 'EUR', 'ALL')).toBe(5128)
    expect(sideAmount(moved, 'from', 'EUR', 'ALL')).toBeNull()
    // Quello salvato non scavalca importo e controvalore, e uno che non è un numero non conta.
    expect(sideAmount({ ...euro, accountAmount: 7 }, 'from', 'EUR', 'ALL')).toBe(2000)
    expect(sideAmount({ ...euro, accountAmount: 7 }, 'from', 'ALL', 'ALL')).toBe(1940)
    expect(sideAmount({ ...euro, accountAmount: NaN }, 'from', 'USD', 'ALL')).toBeNull()
    // Zero è una cifra: il movimento non ha spostato niente su quel conto, non "non si sa".
    expect(sideAmount({ ...euro, accountAmount: 0 }, 'from', 'USD', 'ALL')).toBe(0)
  })

  it('cambio tondo tra due cifre: il più semplice che le rifà', () => {
    // 1,50 € = 146 L (145,5 arrotondato): 97, non 97,333.
    expect(simplestRate(150, EUR, 146, ALL)).toBe(97)
    expect(simplestRate(2000, EUR, 1940, ALL)).toBe(97)
    expect(simplestRate(-150, EUR, -146, ALL)).toBe(97)
    // Nell'altro verso (la cifra del conto ricavata dal controvalore): 5.000 L = 51,28 € a 97,5; = 51,00 € a 98,04.
    expect(simplestRate(5128, EUR, 5000, ALL, 'amount')).toBe(97.5)
    expect(simplestRate(5100, EUR, 5000, ALL, 'amount')).toBe(98.04)
    // Importi minuscoli: non c'è abbastanza da cui ricavarlo, viene quello che viene (0,10 € = 10 L → 100).
    expect(simplestRate(10, EUR, 10, ALL)).toBe(100)
    expect(simplestRate(0, EUR, 0, ALL)).toBeNull()
  })
})

describe('saldo di un conto in valuta', () => {
  const lek = account('lek', 'ALL')
  const euro = account('euro', 'EUR')
  // Saldo iniziale del conto in euro: 200,00 € a 97,5.
  const opening = tx('opening', 20000, day(1), { accountId: 'euro', rate: 97.5, mainAmount: 19500 })

  it('spesa in lek pagata dal conto in euro: escono gli euro, non "5000 centesimi"', () => {
    const spesa = tx('expense', 5000, day(5), { currency: 'ALL', accountId: 'euro', accountAmount: 5128 })
    expect(balance(euro, [opening, spesa], 'ALL')).toBe(20000 - 5128)
  })

  it('giroconto in lek dal conto in lek al conto in euro: ognuno si muove nella sua valuta', () => {
    const start = tx('opening', 100000, day(1), { currency: 'ALL', accountId: 'lek' })
    const giro = tx('transfer', 5000, day(5), { currency: 'ALL', accountId: 'lek', toAccountId: 'euro', toAccountAmount: 5128 })
    expect(balance(lek, [start, opening, giro], 'ALL')).toBe(95000)
    expect(balance(euro, [start, opening, giro], 'ALL')).toBe(20000 + 5128)
    // Nell'altro verso, scritto in euro: 50,00 € a 97,5 = 4.875 L, senza importi a parte.
    const back = tx('transfer', 5000, day(6), { accountId: 'euro', toAccountId: 'lek', rate: 97.5, mainAmount: 4875 })
    expect(balance(lek, [start, opening, back], 'ALL')).toBe(104875)
    expect(balance(euro, [start, opening, back], 'ALL')).toBe(15000)
  })

  it('movimenti scritti prima che l’importo sul conto esistesse: letti come sempre, e fermi', () => {
    // 5.000 L pagati dal conto in euro senza la cifra a parte: resta l'importo scritto (sbagliato di scala, come prima).
    const old = tx('expense', 5000, day(14), { currency: 'ALL', accountId: 'euro' })
    expect(balance(euro, [opening, old], 'ALL')).toBe(20000 - 5000)
    // Non è una stima dai cambi degli altri movimenti: aggiungerne, prima o dopo, qui o altrove, non lo sposta.
    // (Su quel saldo l'allineamento scrive movimenti veri: deve atterrare sulla cifra scritta e restarci.)
    const before = tx('expense', 1000, new Date(2026, 8, 20).getTime(), { accountId: 'lek', rate: 103, mainAmount: 1030 })
    const later = tx('income', 1000, day(15), { accountId: 'euro', rate: 100, mainAmount: 1000 })
    expect(balance(euro, [before, opening, old, later], 'ALL')).toBe(20000 - 5000 + 1000)
    // Lo stesso per il lato di arrivo di un giroconto e per una terza valuta.
    const giro = tx('transfer', 5000, day(5), { currency: 'ALL', accountId: 'lek', toAccountId: 'euro' })
    expect(balance(euro, [opening, giro], 'ALL')).toBe(20000 + 5000)
    const dollars = account('usd', 'USD')
    expect(balance(dollars, [tx('expense', 2000, day(5), { accountId: 'usd', rate: 97, mainAmount: 1940 })], 'ALL')).toBe(-2000)
  })

  it('messi da parte, ripresi e scadenze future non toccano il conto', () => {
    const save = tx('save', 3000, day(5), { accountId: 'euro', goalId: 'g' })
    const due = tx('expense', 1000, new Date(2026, 9, 25).getTime(), { accountId: 'euro' })
    expect(balance(euro, [opening, save, due], 'ALL')).toBe(20000)
  })
})

describe('chi non ha conti in valuta non vede differenze', () => {
  it('archivio in lek con soli conti in lek e movimenti misti: ogni saldo è quello di prima', () => {
    // La lettura di prima di questa modifica, riga per riga.
    const old = (acc: Account, txs: Transaction[], main: string) => {
      const inAccount = (t: Transaction) => (t.currency === acc.currency ? t.amount : acc.currency === main ? t.mainAmount : t.amount)
      let b = acc.initialBalance
      for (const t of txs) {
        if (t.kind === 'save' || t.kind === 'release' || t.date > NOW) continue
        if (t.accountId === acc.id) b += t.kind === 'income' || t.kind === 'opening' ? inAccount(t) : -inAccount(t)
        if (t.toAccountId === acc.id) b += inAccount(t)
      }
      return b
    }
    const conto = account('conto', 'ALL')
    const contanti = account('contanti', 'ALL')
    const txs = [
      tx('opening', 255000, day(1), { currency: 'ALL', accountId: 'conto' }),
      tx('opening', -150, day(1), { currency: 'ALL', accountId: 'contanti' }),
      tx('expense', 1500, day(2), { currency: 'ALL', accountId: 'conto' }),
      tx('expense', 2000, day(3), { accountId: 'conto', rate: 97, mainAmount: 1940 }),
      tx('income', 10000, day(4), { accountId: 'contanti', rate: 97.35, mainAmount: 9735 }),
      tx('transfer', 7000, day(5), { currency: 'ALL', accountId: 'conto', toAccountId: 'contanti' }),
      tx('transfer', 5000, day(6), { accountId: 'contanti', toAccountId: 'conto', rate: 98, mainAmount: 4900 }),
      tx('expense', 1000, day(7), { currency: 'USD', accountId: 'contanti', rate: 92, mainAmount: 920 }),
      tx('save', 3000, day(8), { currency: 'ALL', accountId: 'conto', goalId: 'g' }),
      tx('expense', 900, new Date(2026, 9, 25).getTime(), { currency: 'ALL', accountId: 'conto' }),
    ]
    for (const acc of [conto, contanti]) expect(balance(acc, txs, 'ALL')).toBe(old(acc, txs, 'ALL'))
    expect(balance(conto, txs, 'ALL')).toBe(255000 - 1500 - 1940 - 7000 + 4900)
    // E nessuno di questi movimenti ha bisogno di una cifra a parte.
    for (const t of txs) expect(sideNeedsOwn(t.currency, 'ALL', 'ALL')).toBe(false)
  })
})

describe('cambio della valuta principale: quello che è passato sui conti resta fermo', () => {
  // Archivio in lek. "Conto" in lek con 100.000 L; "Dollari" con 500,00 $ a 92.
  const conto = account('conto', 'ALL')
  const dollari = account('dollari', 'USD')
  const before: Transaction[] = [
    tx('opening', 100000, day(1), { id: 'o1', currency: 'ALL', accountId: 'conto' }),
    tx('opening', 50000, day(1), { id: 'o2', currency: 'USD', accountId: 'dollari', rate: 92, mainAmount: 46000 }),
    // Giroconto di 100,00 $ dal conto in dollari a quello in lek: arrivano 9.200 L.
    tx('transfer', 10000, day(3), { id: 'giro', currency: 'USD', accountId: 'dollari', toAccountId: 'conto', rate: 92, mainAmount: 9200 }),
    // Spesa di 20,00 € pagata dal conto in lek: escono 1.940 L.
    tx('expense', 2000, day(4), { id: 'spesa', accountId: 'conto', rate: 97, mainAmount: 1940 }),
  ]
  const currencyOf = new Map([['conto', 'ALL'], ['dollari', 'USD']])
  const cur = (code: string) => LIST.find((c) => c.code === code)!
  const rebase = (txs: Transaction[], oldMain: Currency, target: Currency, x: number) =>
    txs.map((t) => rebaseTransaction(t, cur(t.currency), oldMain, target, x, { from: currencyOf.get(t.accountId), to: t.toAccountId ? currencyOf.get(t.toAccountId) : undefined }))

  it('prima: 107.260 L sul conto, 400,00 $ sui dollari', () => {
    expect(balance(conto, before, 'ALL')).toBe(100000 + 9200 - 1940)
    expect(balance(dollari, before, 'ALL')).toBe(40000)
  })

  it('passando all’euro i saldi dei conti non cambiano (prima il conto in lek saliva di 740 L)', () => {
    const after = rebase(before, ALL, EUR, 0.0103)
    expect(balance(conto, after, 'EUR')).toBe(107260)
    expect(balance(dollari, after, 'EUR')).toBe(40000)
    // Quello che è passato sul conto in lek ora è scritto a parte; il controvalore è in euro.
    expect(after.find((t) => t.id === 'giro')).toMatchObject({ currency: 'USD', amount: 10000, mainAmount: 9476, toAccountAmount: 9200 })
    expect(after.find((t) => t.id === 'spesa')).toMatchObject({ currency: 'EUR', amount: 2000, mainAmount: 2000, rate: 1, accountAmount: 1940 })
    // Dove non serve non compare.
    expect(after.find((t) => t.id === 'giro')).not.toHaveProperty('accountAmount')
    expect(after.find((t) => t.id === 'o1')).not.toHaveProperty('accountAmount')
    expect(after.find((t) => t.id === 'o2')).not.toHaveProperty('accountAmount')
  })

  it('un gomitolo speso da un conto in un’altra valuta può restare con qualche centesimo: è una differenza di cambio vera', () => {
    // 5.000 L messi da parte, poi spesi dal gomitolo pagando dal conto in euro (usciti 51,28 €). Gomitolo a zero.
    const save = tx('save', 5000, day(2), { currency: 'ALL', accountId: 'conto', goalId: 'g' })
    const spent = tx('expense', 5000, day(3), { currency: 'ALL', accountId: 'euro', goalId: 'g', accountAmount: 5128 })
    const afterSave = rebaseTransaction(save, ALL, ALL, EUR, 0.0103)
    const afterSpent = rebaseTransaction(spent, ALL, ALL, EUR, 0.0103, { from: 'EUR' })
    // Il messo da parte passa col cambio dato (51,50 €); la spesa vale quello che è uscito dal conto (51,28 €).
    expect(afterSave.mainAmount - afterSpent.mainAmount).toBe(22)
  })

  it('tornando ai lek si ritrovano le righe di prima, anche se il cambio usato al ritorno è un altro', () => {
    const back = rebase(rebase(before, ALL, EUR, 0.0103), EUR, ALL, 98)
    // I due movimenti che hanno toccato il conto in lek tornano identici: il controvalore è quello che c'è passato.
    expect(back.find((t) => t.id === 'giro')).toEqual(before.find((t) => t.id === 'giro'))
    expect(back.find((t) => t.id === 'spesa')).toEqual(before.find((t) => t.id === 'spesa'))
    expect(back.find((t) => t.id === 'o1')).toEqual(before.find((t) => t.id === 'o1'))
    expect(balance(conto, back, 'ALL')).toBe(107260)
    expect(balance(dollari, back, 'ALL')).toBe(40000)
  })

  it('con cifre non tonde tornano importo, controvalore e saldi; il cambio è quello che li lega', () => {
    // 5,00 € a 97,35 = 487 L (486,75) pagati dal conto in lek.
    const five = tx('expense', 500, day(6), { id: 'five', accountId: 'conto', rate: 97.35, mainAmount: 487 })
    const there = rebase([five], ALL, EUR, 0.0103)[0]
    expect(there).toMatchObject({ rate: 1, mainAmount: 500, accountAmount: 487 })
    // Ritorno con un altro cambio (98): il controvalore sono i 487 L usciti, e il cambio il più semplice che li rifà.
    const back = rebase([there], EUR, ALL, 98)[0]
    expect(back).toMatchObject({ amount: 500, mainAmount: 487, rate: 97.4 })
    expect(back).not.toHaveProperty('accountAmount')
    expect(Math.round(5 * back.rate)).toBe(487)
    // Ritorno col cambio di prima: si ritrova anche quello.
    expect(rebase([there], EUR, ALL, 97.35)[0]).toEqual(five)
    // 1,50 € = 146 L: 97, non 97,333 (146 / 1,50).
    const small = tx('expense', 150, day(6), { id: 'small', accountId: 'conto', rate: 97, mainAmount: 146 })
    expect(rebase(rebase([small], ALL, EUR, 0.0103), EUR, ALL, 98)[0]).toEqual(small)
    // Un movimento in una terza valuta che non tocca conti in lek segue il cambio dato, come sempre:
    // il saldo iniziale di 500,00 $ (46.000 L) al ritorno a 98 vale 46.432 L. Il saldo del conto, in dollari, non cambia.
    const round = rebase(rebase(before, ALL, EUR, 0.0103), EUR, ALL, 98)
    expect(round.find((t) => t.id === 'o2')).toMatchObject({ amount: 50000, mainAmount: 46432 })
    expect(balance(dollari, round, 'ALL')).toBe(40000)
  })

  it('due cambi di fila (lek → euro → dollari): i saldi restano quelli', () => {
    const after = rebase(rebase(before, ALL, EUR, 0.0103), EUR, USD, 1.08)
    expect(balance(conto, after, 'USD')).toBe(107260)
    expect(balance(dollari, after, 'USD')).toBe(40000)
    // Il giroconto ora ha un lato nella principale: il controvalore sono i 100,00 $ usciti, e i lek restano a parte.
    expect(after.find((t) => t.id === 'giro')).toMatchObject({ currency: 'USD', amount: 10000, mainAmount: 10000, rate: 1, toAccountAmount: 9200 })
    expect(after.find((t) => t.id === 'spesa')).toMatchObject({ currency: 'EUR', amount: 2000, mainAmount: 2160, accountAmount: 1940 })
  })

  it('un conto nella nuova valuta principale trova nel controvalore quello che c’è passato', () => {
    // Spesa di 5.000 L pagata dal conto in euro: usciti 51,28 €.
    const spesa = tx('expense', 5000, day(5), { currency: 'ALL', accountId: 'euro', accountAmount: 5128 })
    const after = rebaseTransaction(spesa, ALL, ALL, EUR, 0.0103, { from: 'EUR' })
    // Non 5.000 × 0,0103 = 51,50 €: quello che è uscito davvero.
    expect(after).toMatchObject({ currency: 'ALL', amount: 5000, mainAmount: 5128 })
    expect(after.rate).toBeCloseTo(0.010256, 10)
    expect(after).not.toHaveProperty('accountAmount')
    // E al ritorno torna a parte.
    expect(rebaseTransaction(after, ALL, EUR, ALL, 97.5, { from: 'EUR' })).toEqual(spesa)
  })

  it('senza le valute dei conti si comporta come prima, e non tocca gli importi che ci sono', () => {
    const plain = tx('expense', 1500, day(5), { currency: 'ALL' })
    expect(rebaseTransaction(plain, ALL, ALL, EUR, 0.0103)).toEqual({ ...plain, rate: 0.0103, mainAmount: 1545 })
    // Conto che non si conosce più (cancellato su un altro dispositivo): la sua cifra resta dov'è.
    const orphan = tx('expense', 5000, day(5), { currency: 'ALL', accountId: 'sparito', accountAmount: 5128 })
    expect(rebaseTransaction(orphan, ALL, ALL, EUR, 0.0103, { from: undefined })).toMatchObject({ mainAmount: 5150, accountAmount: 5128 })
  })

  it('l’importo a parte c’è se e solo se il conto non è né nella valuta del movimento né nella principale', () => {
    const codes = ['ALL', 'EUR', 'USD']
    const x = { ALL: { EUR: 0.0103, USD: 0.0109 }, EUR: { ALL: 97, USD: 1.06 }, USD: { ALL: 92, EUR: 0.94 } } as Record<string, Record<string, number>>
    for (const txCur of codes)
      for (const fromCur of codes)
        for (const toCur of codes)
          for (const main of codes)
            for (const next of codes) {
              if (next === main) continue
              // Movimento coi suoi fatti rispetto alla principale di partenza.
              const row = tx('transfer', 10000, day(5), {
                currency: txCur,
                rate: txCur === main ? 1 : x[txCur][main],
                mainAmount: txCur === main ? 10000 : Math.round(100 * x[txCur][main] * 10 ** cur(main).decimals),
                accountId: 'a',
                toAccountId: 'b',
                ...(sideNeedsOwn(txCur, fromCur, main) ? { accountAmount: 7001 } : {}),
                // Tra due conti nella stessa valuta passa la stessa cifra.
                ...(sideNeedsOwn(txCur, toCur, main) ? { toAccountAmount: toCur === fromCur ? 7001 : 7002 } : {}),
              })
              const before = { from: sideAmount(row, 'from', fromCur, main), to: sideAmount(row, 'to', toCur, main) }
              const after = rebaseTransaction(row, cur(txCur), cur(main), cur(next), x[main][next], { from: fromCur, to: toCur })
              const label = `${txCur} da ${fromCur} a ${toCur}, ${main}→${next}`
              // Su ogni conto è passata la stessa cifra di prima…
              expect(sideAmount(after, 'from', fromCur, next), label).toBe(before.from)
              expect(sideAmount(after, 'to', toCur, next), label).toBe(before.to)
              // …e sta a parte solo dove serve.
              expect('accountAmount' in after, label).toBe(sideNeedsOwn(txCur, fromCur, next))
              expect('toAccountAmount' in after, label).toBe(sideNeedsOwn(txCur, toCur, next))
              expect(after.rate > 0 && Number.isFinite(after.rate), label).toBe(true)
            }
  })

  it('un movimento senza importo sul conto resta senza: non si inventa una cifra', () => {
    const old = tx('expense', 2000, day(5), { accountId: 'dollari', rate: 97, mainAmount: 1940 })
    const after = rebaseTransaction(old, EUR, ALL, EUR, 0.0103, { from: 'USD' })
    expect(after).not.toHaveProperty('accountAmount')
    expect(after).toMatchObject({ mainAmount: 2000, rate: 1 })
  })

  it('ricorrenze: come i movimenti; gli accantonamenti passano alla nuova valuta', () => {
    const rule = (extra: Partial<Recurring>): Recurring => ({ id: 'r', kind: 'expense', amount: 2000, currency: 'EUR', rate: 97, mainAmount: 1940, categoryId: '', accountId: 'conto', note: '', frequency: 'month', start: day(1), next: day(1), active: true, ...extra })
    // Affitto di 20,00 € pagato dal conto in lek: 1.940 L a scadenza, anche dopo.
    expect(rebaseRule(rule({}), EUR, ALL, EUR, 0.0103, 'ALL')).toMatchObject({ currency: 'EUR', amount: 2000, mainAmount: 2000, rate: 1, accountAmount: 1940 })
    // In lek dal conto in lek: niente a parte.
    const plain = rebaseRule(rule({ amount: 5000, currency: 'ALL', rate: 1, mainAmount: 5000 }), ALL, ALL, EUR, 0.0103, 'ALL')
    expect(plain).toMatchObject({ currency: 'ALL', amount: 5000, mainAmount: 5150 })
    expect(plain).not.toHaveProperty('accountAmount')
    // Accantonamento automatico di 10.000 L: 103,00 € nella nuova valuta. Non sposta soldi tra conti: mai importi a parte.
    const save = rebaseRule(rule({ kind: 'save', amount: 10000, currency: 'ALL', rate: 1, mainAmount: 10000, goalId: 'g' }), ALL, ALL, EUR, 0.0103, 'ALL')
    expect(save).toMatchObject({ currency: 'EUR', amount: 10300, mainAmount: 10300, rate: 1 })
    expect(save).not.toHaveProperty('accountAmount')
    expect(rebaseRule(rule({ kind: 'save', amount: 10300, currency: 'EUR', rate: 97, mainAmount: 999100, goalId: 'g' }), EUR, ALL, EUR, 0.0103, 'ALL')).not.toHaveProperty('accountAmount')
  })
})

describe('ricorrenze su un conto in un’altra valuta', () => {
  beforeEach(async () => {
    await db.delete()
    await db.open()
  })

  it('ogni scadenza ripete quanto passa sul conto, come la prima', async () => {
    // Abbonamento di 5.000 L ogni settimana, pagato dal conto in euro: 51,28 € a scadenza.
    const first = tx('expense', 5000, Date.now() - 15 * 86_400_000, { id: 'first', currency: 'ALL', accountId: 'euro', accountAmount: 5128 })
    const saved = await createSeries(first, 'week')
    expect(saved).toMatchObject({ accountAmount: 5128, recurringId: expect.any(String) })
    const [rule] = await db.recurring.toArray()
    expect(rule).toMatchObject({ amount: 5000, currency: 'ALL', accountId: 'euro', accountAmount: 5128 })
    const due = await db.transactions.where('recurringId').equals(rule.id).toArray()
    expect(due.length).toBeGreaterThanOrEqual(3)
    for (const t of due) expect(t.accountAmount).toBe(5128)
    // Una serie senza importo a parte non se lo inventa.
    const plain = await createSeries(tx('expense', 700, Date.now() - 8 * 86_400_000, { id: 'plain' }), 'week')
    expect(plain).not.toHaveProperty('accountAmount')
    for (const t of await db.transactions.where('recurringId').equals(plain.recurringId!).toArray()) expect(t).not.toHaveProperty('accountAmount')
  })
})
