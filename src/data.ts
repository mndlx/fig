import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Account, type Category, type Currency, type Goal, type Transaction } from './db'

export interface AppData {
  mainCurrency: Currency
  currencies: Currency[]
  accounts: Account[]
  categories: Category[]
  goals: Goal[]
  transactions: Transaction[]
}

/** Tutti i dati dell'app, aggiornati in tempo reale a ogni modifica del database. */
export function useAppData(): AppData | undefined {
  return useLiveQuery(async () => {
    const [settings, currencies, accounts, categories, goals, transactions] = await Promise.all([
      db.settings.get('main'),
      db.currencies.toArray(),
      db.accounts.toArray().then((list) => list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))),
      db.categories.orderBy('order').toArray(),
      db.goals.orderBy('order').toArray(),
      db.transactions.orderBy('date').toArray(),
    ])
    const mainCode = settings?.mainCurrency ?? 'EUR'
    const mainCurrency = currencies.find((c) => c.code === mainCode) ?? { code: mainCode, symbol: mainCode, decimals: 2 }
    return { mainCurrency, currencies, accounts, categories, goals, transactions }
  })
}

/**
 * Effetto del movimento sul disponibile, nella valuta principale.
 * Le spese pagate da un gomitolo non lo toccano: quei soldi erano già stati messi da parte.
 */
export function signedMain(tx: Transaction): number {
  switch (tx.kind) {
    case 'income':
    case 'release':
      return tx.mainAmount
    case 'expense':
      return tx.goalId ? 0 : -tx.mainAmount
    case 'save':
      return -tx.mainAmount
    default:
      return 0
  }
}

/** Effetto del movimento sul saldo di un gomitolo. */
export function goalDelta(tx: Transaction, goalId: string): number {
  if (tx.goalId !== goalId) return 0
  if (tx.kind === 'save') return tx.mainAmount
  if (tx.kind === 'release' || tx.kind === 'expense') return -tx.mainAmount
  return 0
}

export function goalBalances(transactions: Transaction[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const tx of transactions) {
    if (!tx.goalId) continue
    out.set(tx.goalId, (out.get(tx.goalId) ?? 0) + goalDelta(tx, tx.goalId))
  }
  return out
}
