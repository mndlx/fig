import { describe, expect, it } from 'vitest'
import { accountBalance, goalBalances, goalDelta, signedMain } from '../data'
import { account, appData, tx } from './helpers'

const past = new Date(2026, 0, 10)
const future = Date.now() + 30 * 86_400_000

describe('disponibile e saldi', () => {
  it('effetto sul disponibile di ogni tipo di movimento', () => {
    expect(signedMain(tx('income', 1000, past))).toBe(1000)
    expect(signedMain(tx('expense', 300, past))).toBe(-300)
    // Pagata da un gomitolo: i soldi erano già fuori dal disponibile.
    expect(signedMain(tx('expense', 300, past, { goalId: 'g' }))).toBe(0)
    expect(signedMain(tx('save', 500, past, { goalId: 'g' }))).toBe(-500)
    expect(signedMain(tx('release', 200, past, { goalId: 'g' }))).toBe(200)
    expect(signedMain(tx('transfer', 700, past, { toAccountId: 'cash' }))).toBe(0)
  })

  it('saldo dei gomitoli: messo da parte, ripreso, speso', () => {
    const list = [
      tx('save', 500, past, { goalId: 'g' }),
      tx('release', 100, past, { goalId: 'g' }),
      tx('expense', 150, past, { goalId: 'g' }),
      tx('save', 80, past, { goalId: 'h' }),
    ]
    const b = goalBalances(list)
    expect(b.get('g')).toBe(250)
    expect(b.get('h')).toBe(80)
    expect(goalDelta(list[2], 'g')).toBe(-150)
  })

  it('saldo di un conto: saldo iniziale, entrate, uscite, giroconti; esclude il futuro e i gomitoli', () => {
    const data = appData([
      tx('opening', 100000, past, { id: 'opening-main' }),
      tx('expense', 2500, past),
      tx('income', 5000, past),
      tx('transfer', 10000, past, { toAccountId: 'cash' }),
      tx('save', 7000, past, { goalId: 'g' }),
      tx('expense', 9999, future),
    ])
    expect(accountBalance(account('main'), data)).toBe(100000 - 2500 + 5000 - 10000)
    expect(accountBalance(account('cash'), data)).toBe(10000)
  })

  it('conto in valuta estera: conta gli importi nella sua valuta', () => {
    const lek = account('lek', 'ALL')
    const data = appData(
      [
        tx('opening', 5000, past, { accountId: 'lek', currency: 'ALL', mainAmount: 4750, rate: 0.0095 }),
        tx('expense', 1200, past, { accountId: 'lek', currency: 'ALL', mainAmount: 1140, rate: 0.0095 }),
      ],
      { accounts: [lek] },
    )
    expect(accountBalance(lek, data)).toBe(3800)
  })
})
