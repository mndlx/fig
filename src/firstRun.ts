import { accountBalanceOf } from './data'
import { db, openingId, type Currency, type Settings, type Transaction } from './db'
import { openingDateBefore } from './opening'

/**
 * Scritture del primo avvio: valuta, saldi iniziali, risposta al riquadro.
 *
 * Regola comune: finché il dispositivo non ha scaricato l'archivio dell'account (syncMeta "adopt"),
 * qui ci sono solo i dati predefiniti. Una risposta data adesso riguarderebbe dati che non sono
 * quelli dell'utente, quindi in quello stato non si scrive niente.
 */

async function archiveNotLoaded(): Promise<boolean> {
  return !!(await db.syncMeta.get('adopt'))
}

/** Regola del codice di una valuta aggiunta a mano: la stessa del modulo nelle Impostazioni. */
export function validCurrencyCode(code: string): boolean {
  return /^[A-Z]{3}$/.test(code)
}

/** Simbolo e decimali che il browser conosce per un codice ISO: un punto di partenza da correggere. */
export function knownCurrency(code: string): { symbol: string; decimals: number } | null {
  if (!validCurrencyCode(code)) return null
  try {
    const fmt = new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
    const symbol = fmt.formatToParts(1).find((p) => p.type === 'currency')?.value ?? code
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2
    // FIG gestisce 0, 2 o 3 decimali, come il modulo delle valute.
    return { symbol: symbol.slice(0, 4), decimals: digits === 0 ? 0 : digits >= 3 ? 3 : 2 }
  } catch {
    return null
  }
}

/**
 * Cambia la valuta principale quando non c'è ancora niente da convertire: impostazioni, conti che
 * erano nella vecchia valuta principale e, per un codice nuovo, la riga della valuta. Tutto insieme.
 * Restituisce false senza toccare nulla se esistono movimenti, obiettivi o ricorrenti (lì serve il
 * cambio con tasso, dalle Impostazioni) o se l'archivio non è ancora stato scaricato.
 * `keep` elenca i conti tenuti apposta in un'altra valuta: provando più valute di fila uno di loro può
 * trovarsi per un momento nella principale, e non deve essere trascinato al cambio successivo.
 */
export async function setFirstRunCurrency(cur: Currency, keep?: ReadonlySet<string>): Promise<boolean> {
  return db.transaction('rw', [db.settings, db.currencies, db.accounts, db.transactions, db.goals, db.recurring, db.syncMeta], async () => {
    if (await archiveNotLoaded()) return false
    if ((await db.transactions.count()) + (await db.goals.count()) + (await db.recurring.count()) > 0) return false
    const settings = await db.settings.get('main')
    const old = settings?.mainCurrency ?? 'EUR'
    if (!(await db.currencies.get(cur.code))) await db.currencies.add(cur)
    if (old === cur.code) return true
    // Solo i conti nella vecchia valuta principale: un conto messo apposta in un'altra valuta resta com'è.
    const accounts = await db.accounts.filter((a) => a.currency === old && !keep?.has(a.id)).toArray()
    for (const a of accounts) await db.accounts.update(a.id, { currency: cur.code })
    if (settings) await db.settings.update('main', { mainCurrency: cur.code })
    else await db.settings.put({ id: 'main', mainCurrency: cur.code })
    return true
  })
}

/**
 * Saldi del primo avvio, tutti insieme. `balances` dice quanto c'è adesso su ogni conto (unità minime).
 * Se il conto ha già dei movimenti, il saldo iniziale è quella cifra meno il loro effetto ed è datato
 * prima del più vecchio: il saldo di oggi torna con quello scritto e niente viene contato due volte.
 * Non sostituisce un saldo iniziale che esiste già e vale solo per i conti nella valuta principale.
 * Segna il riquadro come completato. Restituisce gli id creati (per evidenziarli e per "Annulla").
 */
export async function saveStartingBalances(balances: Record<string, number>, now = Date.now()): Promise<string[]> {
  return db.transaction('rw', [db.settings, db.accounts, db.transactions, db.syncMeta], async () => {
    if (await archiveNotLoaded()) return []
    const settings = await db.settings.get('main')
    const main = settings?.mainCurrency ?? 'EUR'
    const transactions = await db.transactions.toArray()
    const created: string[] = []
    let answered = 0
    for (const [accountId, balance] of Object.entries(balances)) {
      if (!Number.isFinite(balance)) continue
      const acc = await db.accounts.get(accountId)
      if (!acc || acc.currency !== main) continue
      const id = openingId(acc.id)
      if (transactions.some((tx) => tx.id === id)) continue
      answered++
      const amount = balance - accountBalanceOf(acc, transactions, main, now)
      if (amount === 0) continue
      const tx: Transaction = {
        id,
        kind: 'opening',
        amount,
        currency: acc.currency,
        rate: 1,
        mainAmount: amount,
        date: openingDateBefore(acc.id, transactions, now),
        accountId: acc.id,
        note: '',
        source: 'manual',
      }
      await db.transactions.put(tx)
      created.push(id)
    }
    if (answered > 0 && settings) await db.settings.put({ ...settings, setup: 'done' })
    return created
  })
}

/** Scrive la risposta al riquadro sul record intero: senza valore il campo sparisce anche dal server. */
async function writeSetup(state: Settings['setup']) {
  const settings = await db.settings.get('main')
  if (!settings) return
  const next: Settings = { ...settings }
  if (state) next.setup = state
  else delete next.setup
  await db.settings.put(next)
}

/** Risposta al riquadro: rimandato ("later") oppure chiuso ("done"). */
export async function setSetup(state: 'later' | 'done'): Promise<void> {
  await db.transaction('rw', [db.settings, db.syncMeta], async () => {
    if (await archiveNotLoaded()) return
    await writeSetup(state)
  })
}

/** Annulla i saldi iniziali appena salvati e rimette la risposta al riquadro com'era prima. */
export async function undoStartingBalances(ids: string[], previous: Settings['setup']): Promise<void> {
  await db.transaction('rw', [db.settings, db.transactions], async () => {
    await db.transactions.bulkDelete(ids)
    await writeSetup(previous)
  })
}
