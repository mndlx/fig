import type { AppData } from '../data'
import type { Account, Currency, Transaction } from '../db'

export const EUR: Currency = { code: 'EUR', symbol: '€', decimals: 2 }
export const ALL: Currency = { code: 'ALL', symbol: 'L', decimals: 0 }

export const account = (id: string, currency = 'EUR'): Account => ({ id, name: id, currency, initialBalance: 0, initialMain: 0, order: 0, archived: false })

let seq = 0
/** Movimento di prova in euro; `amount` in centesimi. */
export function tx(kind: Transaction['kind'], amount: number, date: Date | number, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: `t${++seq}`,
    kind,
    amount,
    currency: 'EUR',
    rate: 1,
    mainAmount: amount,
    date: typeof date === 'number' ? date : date.getTime(),
    accountId: 'main',
    note: '',
    source: 'manual',
    ...extra,
  }
}

export function appData(transactions: Transaction[], extra: Partial<AppData> = {}): AppData {
  return {
    mainCurrency: EUR,
    currencies: [EUR, ALL],
    accounts: [account('main'), account('cash')],
    categories: [],
    goals: [],
    recurring: [],
    transactions: [...transactions].sort((a, b) => a.date - b.date),
    ...extra,
  }
}
