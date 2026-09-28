import { db, openingId, type Account, type Transaction } from './db'

/**
 * Saldo iniziale di un conto come movimento "opening" sul filo: si vede, si apre e si modifica
 * come gli altri. Importi in unità minime; possono essere negativi (conto in rosso).
 * Con importo zero il movimento viene tolto.
 */
export async function saveOpening(acc: Account, amount: number, mainAmount: number, date?: number) {
  const id = openingId(acc.id)
  const existing = await db.transactions.get(id)
  if (amount === 0) {
    if (existing) await db.transactions.delete(id)
    return
  }
  const tx: Transaction = {
    id,
    kind: 'opening',
    amount,
    currency: acc.currency,
    rate: amount !== 0 ? mainAmount / amount : 1,
    mainAmount,
    date: existing?.date ?? date ?? Date.now(),
    accountId: acc.id,
    note: existing?.note ?? '',
    source: 'manual',
  }
  await db.transactions.put(tx)
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
