import { accountBalanceOf } from './data'
import { db, openingId, type Account, type Currency, type Transaction } from './db'
import { convertMinor } from './money'

/**
 * Saldo iniziale di un conto come movimento "opening" sul filo: si vede, si apre e si modifica
 * come gli altri. Importi in unità minime; possono essere negativi (conto in rosso).
 * Con importo zero il movimento viene tolto. `rate` è il cambio verso la valuta principale
 * (1 unità del conto = rate unità principali): senza, lo si ricava dai due importi.
 */
export async function saveOpening(acc: Account, amount: number, mainAmount: number, date?: number, rate?: number): Promise<Transaction | undefined> {
  const id = openingId(acc.id)
  const existing = await db.transactions.get(id)
  if (amount === 0) {
    if (existing) await db.transactions.delete(id)
    return undefined
  }
  const tx: Transaction = {
    id,
    kind: 'opening',
    amount,
    currency: acc.currency,
    rate: rate ?? (amount !== 0 ? mainAmount / amount : 1),
    mainAmount,
    date: existing?.date ?? date ?? Date.now(),
    accountId: acc.id,
    note: existing?.note ?? '',
    source: 'manual',
  }
  await db.transactions.put(tx)
  return tx
}

/** Il conto ha già un saldo iniziale? */
export function hasOpening(accountId: string, transactions: Transaction[]): boolean {
  const id = openingId(accountId)
  return transactions.some((tx) => tx.id === id)
}

/**
 * Data da dare a un saldo iniziale impostato quando il conto ha già dei movimenti:
 * un minuto prima del più vecchio, così sul ramo sta alla base. Senza movimenti, adesso.
 */
export function openingDateBefore(accountId: string, transactions: Transaction[], now = Date.now()): number {
  let first = Infinity
  for (const tx of transactions) {
    if (tx.kind === 'opening') continue
    if (tx.accountId === accountId || tx.toAccountId === accountId) first = Math.min(first, tx.date)
  }
  return Number.isFinite(first) ? Math.min(first - 60_000, now) : now
}

/**
 * Saldo iniziale che fa tornare il conto con quello che c'è davvero oggi: il saldo reale meno l'effetto
 * dei movimenti già registrati, datato prima del più vecchio. `rate` è il cambio verso la valuta
 * principale (1 per i conti in quella valuta). Può essere negativo; zero vuol dire che non serve.
 */
export function openingFromBalance(
  acc: Account,
  realBalance: number,
  transactions: Transaction[],
  currency: Currency,
  mainCurrency: Currency,
  rate: number,
  now = Date.now(),
): { amount: number; mainAmount: number; date: number } {
  const amount = realBalance - accountBalanceOf(acc, transactions, mainCurrency.code, now)
  const mainAmount = currency.code === mainCurrency.code ? amount : convertMinor(amount, currency, mainCurrency, rate)
  return { amount, mainAmount, date: openingDateBefore(acc.id, transactions, now) }
}

/**
 * Le versioni precedenti tenevano il saldo iniziale in un campo nascosto del conto.
 * Lo trasformo in un movimento "opening", datato poco prima del primo movimento esistente.
 */
export async function migrateInitialBalances() {
  const accounts = await db.accounts.filter((a) => a.initialBalance !== 0 || a.initialMain !== 0).toArray()
  if (accounts.length === 0) return
  const first = await db.transactions.orderBy('date').first()
  const date = first ? Math.min(first.date - 60_000, Date.now()) : Date.now()
  for (const acc of accounts) {
    if (!(await db.transactions.get(openingId(acc.id)))) await saveOpening(acc, acc.initialBalance, acc.initialMain, date)
    await db.accounts.update(acc.id, { initialBalance: 0, initialMain: 0 })
  }
}
