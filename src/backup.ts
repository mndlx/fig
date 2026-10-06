import { db, type SyncedTable } from './db'
import { quietCurrentTransaction } from './sync'
import { download, toCsv } from './csv'
import { builtinName, decimalSep, getLang, locale, t, type Key } from './i18n'
import { fromMinor } from './money'

const TABLES = ['settings', 'currencies', 'accounts', 'categories', 'goals', 'transactions', 'rules', 'importProfiles', 'recurring'] as const

function stamp(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Backup completo in JSON, ripristinabile. Restituisce il nome del file scaricato. */
export async function exportJson(): Promise<string> {
  const dump: Record<string, unknown[]> = {}
  for (const table of TABLES) dump[table] = await db.table(table).toArray()
  const name = `fig-backup-${stamp()}.json`
  download(name, JSON.stringify({ app: 'fig', version: 4, data: dump }, null, 2), 'application/json')
  return name
}

/** Sostituisce tutti i dati con quelli del backup. */
export async function importJson(text: string) {
  const parsed = JSON.parse(text)
  if (parsed?.app !== 'fig' || !parsed.data || typeof parsed.data !== 'object') throw new Error(t('backup.notFig'))

  // Controllo tutto prima di toccare i dati: un backup rovinato non deve cancellare niente.
  const incoming = new Map<SyncedTable, Record<string, unknown>[]>()
  for (const table of TABLES) {
    const rows: unknown = parsed.data[table] ?? []
    const pk = table === 'currencies' ? 'code' : 'id'
    if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === 'object' && typeof (r as Record<string, unknown>)[pk] === 'string'))
      throw new Error(t('backup.notFig'))
    incoming.set(table, rows as Record<string, unknown>[])
  }

  // Un'unica transazione: sostituzione dei dati e coda di sincronizzazione riescono o falliscono insieme.
  // Al server vanno le eliminazioni dei record che il backup non ha e tutti i record del backup.
  const now = Date.now()
  await db.transaction('rw', [...TABLES.map((table) => db.table(table)), db.syncQueue], async () => {
    quietCurrentTransaction()
    for (const table of TABLES) {
      const pk = table === 'currencies' ? 'code' : 'id'
      const rows = incoming.get(table)!
      const keep = new Set(rows.map((r) => String(r[pk])))
      const existing = (await db.table(table).toCollection().primaryKeys()).map(String)
      const gone = existing.filter((k) => !keep.has(k))
      await db.table(table).bulkDelete(gone)
      await db.table(table).bulkPut(rows)
      await db.syncQueue.bulkPut([
        ...gone.map((id) => ({ tbl: table, id, deleted: true, at: now })),
        ...[...keep].map((id) => ({ tbl: table, id, deleted: false, at: now })),
      ])
    }
  })
}

/** Tutti i movimenti in un CSV leggibile con Excel, nella lingua dell'app. */
export async function exportCsv() {
  const [transactions, categories, accounts, currencies, settings, goals] = await Promise.all([
    db.transactions.orderBy('date').toArray(),
    db.categories.toArray(),
    db.accounts.toArray(),
    db.currencies.toArray(),
    db.settings.get('main'),
    db.goals.toArray(),
  ])
  const goal = new Map(goals.map((g) => [g.id, g.name]))
  const main = settings?.mainCurrency ?? 'EUR'
  const cat = new Map(categories.map((c) => [c.id, builtinName(c, 'cat')]))
  const acc = new Map(accounts.map((a) => [a.id, builtinName(a, 'acc')]))
  const dec = new Map(currencies.map((c) => [c.code, c.decimals]))
  const sep = decimalSep()
  const num = (minor: number, code: string) => fromMinor(minor, dec.get(code) ?? 2).toFixed(dec.get(code) ?? 2).replace('.', sep)
  // Excel in italiano si aspetta il punto e virgola, in inglese la virgola.
  const delimiter = getLang() === 'it' ? ';' : ','

  const rows: (string | number)[][] = [
    [
      t('csv.date'),
      t('csv.time'),
      t('csv.type'),
      t('csv.category'),
      t('csv.goal'),
      t('csv.account'),
      t('csv.toAccount'),
      t('csv.amount'),
      t('csv.currency'),
      t('csv.rate'),
      t('csv.amountMain', { code: main }),
      t('csv.note'),
    ],
  ]
  for (const tx of transactions) {
    const d = new Date(tx.date)
    const sign = tx.kind === 'expense' || tx.kind === 'save' ? -1 : 1
    rows.push([
      d.toLocaleDateString(locale()),
      d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }),
      t(`kind.${tx.kind}` as Key),
      tx.categoryId ? (cat.get(tx.categoryId) ?? '') : '',
      tx.goalId ? (goal.get(tx.goalId) ?? '') : '',
      acc.get(tx.accountId) ?? '',
      tx.toAccountId ? (acc.get(tx.toAccountId) ?? '') : '',
      num(sign * tx.amount, tx.currency),
      tx.currency,
      String(tx.rate).replace('.', sep),
      num(sign * tx.mainAmount, main),
      tx.note,
    ])
  }
  download(`fig-${stamp()}.csv`, toCsv(rows, delimiter), 'text/csv;charset=utf-8')
}
