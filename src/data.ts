import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Account, type Category, type Currency, type Goal, type Recurring, type Transaction } from './db'

export interface AppData {
  mainCurrency: Currency
  currencies: Currency[]
  accounts: Account[]
  categories: Category[]
  goals: Goal[]
  recurring: Recurring[]
  transactions: Transaction[]
  /** Risposta al riquadro del primo avvio (vedi Settings.setup). */
  setup?: 'later' | 'done'
  /**
   * Vero finché questo dispositivo non ha scaricato l'archivio dell'account: quello che si vede
   * sono solo i dati predefiniti, quindi niente riquadro iniziale e niente scritture di primo avvio.
   */
  archivePending?: boolean
}

/**
 * Vero quando sul dispositivo ci sono solo i dati predefiniti e l'archivio dell'account deve ancora
 * arrivare: un movimento scritto adesso nascerebbe nella valuta stimata e su conti vuoti, e finirebbe
 * così com'è nell'archivio vero. Chi ha già dati suoi sul dispositivo (usato senza account) non è in
 * questo stato: i suoi dati sono veri, devono solo essere caricati.
 */
export function placeholderOnly(data: AppData): boolean {
  return !!data.archivePending && data.transactions.length === 0 && data.goals.length === 0 && data.recurring.length === 0
}

/** Tutti i dati dell'app, aggiornati in tempo reale a ogni modifica del database. */
export function useAppData(): AppData | undefined {
  return useLiveQuery(async () => {
    const [settings, currencies, accounts, categories, goals, recurring, transactions, adopt] = await Promise.all([
      db.settings.get('main'),
      db.currencies.toArray(),
      db.accounts.toArray().then((list) => list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))),
      db.categories.orderBy('order').toArray(),
      db.goals.orderBy('order').toArray(),
      db.recurring.toArray(),
      db.transactions.orderBy('date').toArray(),
      db.syncMeta.get('adopt'),
    ])
    const mainCode = settings?.mainCurrency ?? 'EUR'
    const mainCurrency = currencies.find((c) => c.code === mainCode) ?? { code: mainCode, symbol: mainCode, decimals: 2 }
    return { mainCurrency, currencies, accounts, categories, goals, recurring, transactions, setup: settings?.setup, archivePending: !!adopt }
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
    case 'opening':
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

/** Saldo di un conto nella sua valuta: saldo iniziale, entrate, uscite e giroconti (i gomitoli non spostano soldi). */
export function accountBalance(acc: Account, data: AppData): number {
  return accountBalanceOf(acc, data.transactions, data.mainCurrency.code)
}

/** Come accountBalance, ma dai soli movimenti: serve anche dentro le transazioni del database. */
export function accountBalanceOf(acc: Account, transactions: Transaction[], mainCode: string, now = Date.now()): number {
  // Importo nella valuta del conto: uguale se la valuta coincide, il controvalore se il conto è nella valuta principale.
  const inAccount = (tx: Transaction) => (tx.currency === acc.currency ? tx.amount : acc.currency === mainCode ? tx.mainAmount : tx.amount)
  let b = acc.initialBalance
  for (const tx of transactions) {
    // Solo movimenti già avvenuti: le scadenze in arrivo non sono ancora uscite dal conto.
    if (tx.kind === 'save' || tx.kind === 'release' || tx.date > now) continue
    if (tx.accountId === acc.id) b += tx.kind === 'income' || tx.kind === 'opening' ? inAccount(tx) : -inAccount(tx)
    if (tx.toAccountId === acc.id) b += inAccount(tx)
  }
  return b
}
