import { db, type Frequency, type Recurring, type Transaction } from './db'

function daysIn(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/**
 * Scadenza successiva a `from`. Per mese e anno si tiene il giorno della partenza,
 * adattato ai mesi più corti (il 31 diventa 30, 29 o 28) senza perderlo nei mesi dopo.
 */
export function nextAfter(from: number, frequency: Frequency, start: number): number {
  const d = new Date(from)
  const s = new Date(start)
  // Settimanale: stesso giorno della settimana e stessa ora anche quando cambia l'ora legale.
  if (frequency === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7, s.getHours(), s.getMinutes()).getTime()
  const year = frequency === 'year' ? d.getFullYear() + 1 : d.getFullYear() + (d.getMonth() === 11 ? 1 : 0)
  const month = frequency === 'year' ? s.getMonth() : (d.getMonth() + 1) % 12
  const day = Math.min(s.getDate(), daysIn(year, month))
  return new Date(year, month, day, s.getHours(), s.getMinutes()).getTime()
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Id del movimento di una scadenza: uguale su tutti i dispositivi. */
export const occurrenceId = (rule: Recurring, ts: number) => `${rule.id}-${dayKey(ts)}`

function occurrence(rule: Recurring, ts: number): Transaction {
  return {
    id: occurrenceId(rule, ts),
    kind: rule.kind,
    amount: rule.amount,
    currency: rule.currency,
    rate: rule.rate,
    mainAmount: rule.mainAmount,
    date: ts,
    categoryId: rule.categoryId || undefined,
    accountId: rule.accountId,
    // Importo sul conto, se la serie ne ha uno a parte: senza, il saldo del conto lo dovrebbe stimare.
    ...(rule.accountAmount !== undefined ? { accountAmount: rule.accountAmount } : {}),
    goalId: rule.goalId,
    note: rule.note,
    source: 'manual',
    recurringId: rule.id,
  }
}

/** Fine del mese corrente: le scadenze fin lì compaiono già sul filo come "in arrivo". */
function horizon(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1
}

let running = false

/** Crea i movimenti delle serie attive fino a fine mese e sposta avanti la prossima scadenza. */
export async function materializeRecurring() {
  if (running) return
  running = true
  try {
    const limit = horizon()
    const rules = await db.recurring.filter((r) => r.active && r.next <= limit).toArray()
    for (const rule of rules) {
      let next = rule.next
      for (let guard = 0; next <= limit && guard < 400; guard++) {
        const id = occurrenceId(rule, next)
        if (!(await db.transactions.get(id))) await db.transactions.put(occurrence(rule, next))
        next = nextAfter(next, rule.frequency, rule.start)
      }
      if (next !== rule.next) await db.recurring.update(rule.id, { next })
    }
  } finally {
    running = false
  }
}

/** Nuova serie a partire da un movimento appena salvato (che diventa la prima scadenza). */
export async function createSeries(first: Transaction, frequency: Frequency): Promise<Transaction> {
  if (first.kind !== 'expense' && first.kind !== 'income' && first.kind !== 'save') return first
  const rule: Recurring = {
    id: crypto.randomUUID(),
    kind: first.kind,
    amount: first.amount,
    currency: first.currency,
    rate: first.rate,
    mainAmount: first.mainAmount,
    categoryId: first.categoryId ?? '',
    accountId: first.accountId,
    ...(first.accountAmount !== undefined ? { accountAmount: first.accountAmount } : {}),
    goalId: first.goalId,
    note: first.note,
    frequency,
    start: first.date,
    next: nextAfter(first.date, frequency, first.date),
    active: true,
  }
  const tx: Transaction = { ...first, id: occurrenceId(rule, first.date), recurringId: rule.id }
  await db.transaction('rw', db.recurring, db.transactions, async () => {
    await db.recurring.put(rule)
    await db.transactions.delete(first.id)
    await db.transactions.put(tx)
  })
  await materializeRecurring()
  return tx
}

/** Accantonamento automatico in un gomitolo, a partire da oggi (la prima quota viene messa da parte subito). */
export async function createAutoSave(goalId: string, amount: number, currency: string, accountId: string, frequency: Frequency) {
  const now = Date.now()
  const rule: Recurring = {
    id: crypto.randomUUID(),
    kind: 'save',
    amount,
    currency,
    rate: 1,
    mainAmount: amount,
    categoryId: '',
    accountId,
    goalId,
    note: '',
    frequency,
    start: now,
    next: now,
    active: true,
  }
  await db.recurring.put(rule)
  await materializeRecurring()
}

/** Archivia o ripristina un gomitolo; archiviandolo si fermano i suoi accantonamenti automatici. */
export async function setGoalArchived(goalId: string, archived: boolean) {
  await db.goals.update(goalId, { archived })
  if (!archived) return
  // Accantonamenti automatici fermati; le spese ricorrenti pagate da qui passano al disponibile.
  const rules = await db.recurring.filter((r) => r.goalId === goalId && r.active).toArray()
  for (const rule of rules) {
    if (rule.kind === 'save') await updateSeries({ ...rule, active: false })
    else await updateSeries({ ...rule, goalId: undefined })
  }
  // Quello che resta nel gomitolo torna nel disponibile: un gomitolo archiviato non trattiene soldi.
  const txs = await db.transactions.where('goalId').equals(goalId).toArray()
  const now = Date.now()
  const left = txs
    .filter((tx) => tx.date <= now)
    .reduce((s, tx) => s + (tx.kind === 'save' ? tx.mainAmount : tx.kind === 'release' || tx.kind === 'expense' ? -tx.mainAmount : 0), 0)
  if (left > 0) {
    const main = (await db.settings.get('main'))?.mainCurrency ?? 'EUR'
    const account = (await db.accounts.filter((a) => !a.archived && a.currency === main).first()) ?? (await db.accounts.toCollection().first())
    await db.transactions.put({
      id: crypto.randomUUID(),
      kind: 'release',
      amount: left,
      currency: main,
      rate: 1,
      mainAmount: left,
      date: now,
      accountId: account?.id ?? '',
      goalId,
      note: '',
      source: 'manual',
    })
  }
}

/** Elimina la serie: i movimenti passati restano, quelli futuri generati vengono tolti. */
export async function deleteSeries(rule: Recurring) {
  const now = Date.now()
  await db.transaction('rw', db.recurring, db.transactions, async () => {
    await db.transactions.where('recurringId').equals(rule.id).and((tx) => tx.date > now).delete()
    await db.recurring.delete(rule.id)
  })
}

/** Aggiorna la serie: vale dalla prossima scadenza; i movimenti futuri già generati vengono rigenerati. */
export async function updateSeries(rule: Recurring) {
  const now = Date.now()
  await db.transaction('rw', db.recurring, db.transactions, async () => {
    const future = await db.transactions.where('recurringId').equals(rule.id).and((tx) => tx.date > now).toArray()
    await db.transactions.bulkDelete(future.map((tx) => tx.id))
    // Si riparte dalla prima scadenza futura della serie.
    let next = rule.start
    while (next <= now) next = nextAfter(next, rule.frequency, rule.start)
    await db.recurring.put({ ...rule, next })
  })
  await materializeRecurring()
}
