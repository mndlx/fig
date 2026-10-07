import Dexie, { type EntityTable, type Table } from 'dexie'
import { guessCurrency } from './currencyGuess'

/**
 * - expense / income: uscite ed entrate
 * - transfer: giroconto tra conti, non cambia il disponibile
 * - save: soldi messi da parte in un gomitolo (escono dal disponibile)
 * - release: soldi ripresi da un gomitolo (tornano nel disponibile)
 * - opening: saldo di partenza di un conto (uno per conto, id "opening-<conto>"); non è un'entrata
 */
export type Kind = 'expense' | 'income' | 'transfer' | 'save' | 'release' | 'opening'

/** Id fisso del saldo iniziale di un conto: due dispositivi creano lo stesso record, non doppioni. */
export const openingId = (accountId: string) => `opening-${accountId}`

/** Un gomitolo: un obiettivo di risparmio, es. "Vacanza a Lisbona". */
export interface Goal {
  id: string
  name: string
  /** Cifra da raggiungere nella valuta principale, in unità minime; 0 se non c'è. */
  target: number
  /** Scadenza facoltativa (timestamp dell'ultimo giorno del mese scelto). */
  deadline?: number
  color: string
  order: number
  archived: boolean
}

export interface Currency {
  code: string
  symbol: string
  decimals: number
}

export interface Settings {
  id: 'main'
  mainCurrency: string
  /**
   * Riquadro del primo avvio (valuta e saldi iniziali): "later" se rimandato, "done" se chiuso
   * o completato. Assente finché non si è risposto. Sta qui, e non nel browser, così segue
   * l'utente sugli altri dispositivi e sparisce con i suoi dati.
   */
  setup?: 'later' | 'done'
}

export interface Account {
  id: string
  /** Nome scelto dall'utente; vuoto per i conti predefiniti, che usano la traduzione di `key`. */
  name: string
  key?: string
  currency: string
  /** Saldo iniziale in unità minime della valuta del conto. */
  initialBalance: number
  /** Saldo iniziale convertito nella valuta principale, in unità minime. */
  initialMain: number
  order: number
  archived: boolean
}

export interface Category {
  id: string
  /** Nome scelto dall'utente; vuoto per le categorie predefinite, che usano la traduzione di `key`. */
  name: string
  key?: string
  icon: string
  kind: 'expense' | 'income'
  color: string
  order: number
  archived: boolean
}

export interface Transaction {
  id: string
  kind: Kind
  /** Importo positivo in unità minime della valuta del movimento. */
  amount: number
  currency: string
  /** Quante unità di valuta principale vale 1 unità della valuta del movimento. */
  rate: number
  /** Controvalore positivo nella valuta principale, in unità minime. */
  mainAmount: number
  /** Timestamp in millisecondi. */
  date: number
  categoryId?: string
  accountId: string
  toAccountId?: string
  /**
   * Quanto il movimento ha spostato sul conto `accountId`, in unità minime della valuta di quel conto e col segno
   * di `amount`. C'è solo quando non si può leggere altrove: il conto non è né nella valuta del movimento (vale
   * `amount`) né in quella principale (vale `mainAmount`). Vedi sideAmount in money.ts.
   */
  accountAmount?: number
  /** Lo stesso per il conto di arrivo di un giroconto (`toAccountId`). */
  toAccountAmount?: number
  /** Gomitolo coinvolto: destinazione (save), origine (release) o fonte di pagamento (expense). */
  goalId?: string
  note: string
  /** "adjust": allineamento al saldo reale del conto (commissioni, arrotondamenti). */
  source: 'manual' | 'import' | 'adjust'
  /** Identifica l'import CSV da cui proviene il movimento. */
  importId?: string
  /** Serie ricorrente che ha generato il movimento. */
  recurringId?: string
}

export type Frequency = 'week' | 'month' | 'year'

/**
 * Uscita o entrata ricorrente (affitto, stipendio, abbonamento). I movimenti vengono
 * generati fino a fine mese corrente, con id "<serie>-<aaaa-mm-gg>" così due dispositivi
 * non creano doppioni.
 */
export interface Recurring {
  id: string
  /** "save" = accantonamento automatico in un gomitolo (goalId). */
  kind: 'expense' | 'income' | 'save'
  amount: number
  currency: string
  rate: number
  /** Controvalore nella valuta principale, fissato alla creazione della serie. */
  mainAmount: number
  categoryId: string
  accountId: string
  /** Importo sul conto della serie, quando non è né `amount` né `mainAmount` (vedi Transaction.accountAmount): ogni scadenza lo ripete. */
  accountAmount?: number
  goalId?: string
  note: string
  frequency: Frequency
  /** Giorno di partenza della serie (timestamp): fissa giorno del mese / della settimana. */
  start: number
  /** Prossima scadenza non ancora generata (timestamp). */
  next: number
  active: boolean
}

/** "Se la descrizione contiene X, usa la categoria Y" per l'import CSV. */
export interface Rule {
  id: string
  match: string
  categoryId: string
}

/** Come leggere il CSV di una banca, salvato dopo il primo import. */
export interface ImportProfile {
  id: string
  name: string
  /** Intestazioni del file, per riconoscere lo stesso formato la volta dopo. */
  signature: string
  dateCol: number
  descCol: number
  amountCol: number
  /** Colonna "Avere" quando la banca separa uscite ed entrate; -1 se l'importo ha il segno. */
  creditCol: number
  /** Colonna unica in cui le uscite sono numeri positivi. */
  invert?: boolean
  accountId: string
}

/** Modifica locale in attesa di essere inviata al server. */
export interface QueuedChange {
  tbl: SyncedTable
  id: string
  deleted: boolean
  /** Momento della modifica: se cambia durante l'invio, la voce resta in coda. */
  at: number
}

export interface SyncMeta {
  key: string
  value: number | string
}

/**
 * Vero finché il database non è pronto: le scritture fatte all'apertura
 * (dati iniziali, aggiornamenti di schema) non vanno sincronizzate.
 */
export const openState = { opening: true }

/** Tabelle dell'app che si sincronizzano col server. */
export const SYNCED_TABLES = ['settings', 'currencies', 'accounts', 'categories', 'goals', 'transactions', 'rules', 'importProfiles', 'recurring'] as const
export type SyncedTable = (typeof SYNCED_TABLES)[number]

export const db = new Dexie('fig') as Dexie & {
  settings: EntityTable<Settings, 'id'>
  currencies: EntityTable<Currency, 'code'>
  accounts: EntityTable<Account, 'id'>
  categories: EntityTable<Category, 'id'>
  transactions: EntityTable<Transaction, 'id'>
  rules: EntityTable<Rule, 'id'>
  importProfiles: EntityTable<ImportProfile, 'id'>
  goals: EntityTable<Goal, 'id'>
  syncQueue: Table<QueuedChange, [string, string]>
  recurring: EntityTable<Recurring, 'id'>
  syncMeta: EntityTable<SyncMeta, 'key'>
}

db.version(1).stores({
  settings: 'id',
  currencies: 'code',
  accounts: 'id',
  categories: 'id, kind, order',
  transactions: 'id, date, categoryId, accountId',
})

db.version(2).stores({
  rules: 'id',
  importProfiles: 'id, signature',
})

db.version(3).stores({
  goals: 'id, order',
  transactions: 'id, date, categoryId, accountId, goalId',
})

/** Colori delle categorie, come matasse di lana. */
export const WOOL = [
  '#C8553D', // terracotta
  '#D9A441', // ocra
  '#7B4B6A', // prugna
  '#4F6D8F', // blu polvere
  '#D28A8A', // rosa antico
  '#2F6F73', // petrolio
  '#8A8F3C', // oliva
  '#8C7FB8', // lavanda
  '#B89B72', // sabbia
  '#6B8FB3', // cielo
  '#A0522D', // ruggine
  '#8A8580', // grigio
  '#3E8E5A', // verde
  '#5FA38A', // salvia
]

/** Categorie iniziali: chiave di traduzione, tipo, colore, icona. */
const SEED_CATEGORIES: [string, Category['kind'], string, string][] = [
  ['groceries', 'expense', '#7B4B6A', 'cart'],
  ['home', 'expense', '#C8553D', 'home'],
  ['bills', 'expense', '#A0522D', 'bolt'],
  ['transport', 'expense', '#4F6D8F', 'bus'],
  ['lunch', 'expense', '#D28A8A', 'kitchen'],
  ['coffee', 'expense', '#D9A441', 'coffee'],
  ['goingOut', 'expense', '#8C7FB8', 'glass'],
  ['health', 'expense', '#2F6F73', 'health'],
  ['clothes', 'expense', '#B89B72', 'shirt'],
  ['subscriptions', 'expense', '#6B8FB3', 'repeat'],
  ['gifts', 'expense', '#8A8F3C', 'gift'],
  ['other', 'expense', '#8A8580', 'dots'],
  ['salary', 'income', '#3E8E5A', 'briefcase'],
  ['extra', 'income', '#5FA38A', 'sparkles'],
  ['refunds', 'income', '#2F6F73', 'refund'],
  ['otherIncome', 'income', '#8A8580', 'dots'],
]

/** Nomi italiani delle versioni precedenti, per convertirli in categorie tradotte. */
const LEGACY_NAMES: Record<string, string> = {
  'expense:Spesa': 'groceries',
  'expense:Casa': 'home',
  'expense:Bollette': 'bills',
  'expense:Trasporti': 'transport',
  'expense:Pranzo': 'lunch',
  'expense:Caffè': 'coffee',
  'expense:Uscite': 'goingOut',
  'expense:Salute': 'health',
  'expense:Abbigliamento': 'clothes',
  'expense:Abbonamenti': 'subscriptions',
  'expense:Regali': 'gifts',
  'expense:Altro': 'other',
  'income:Stipendio': 'salary',
  'income:Extra': 'extra',
  'income:Rimborsi': 'refunds',
  'income:Altro': 'otherIncome',
}

db.version(4)
  .stores({ categories: 'id, kind, order' })
  .upgrade(async (tx) => {
    const icons = new Map(SEED_CATEGORIES.map(([key, , , icon]) => [key, icon]))
    await tx
      .table('categories')
      .toCollection()
      .modify((c: Category) => {
        const key = LEGACY_NAMES[`${c.kind}:${c.name}`]
        if (key) {
          c.key = key
          c.name = ''
        }
        c.icon = c.icon ?? (key ? icons.get(key) : undefined) ?? 'dots'
      })
    await tx
      .table('accounts')
      .toCollection()
      .modify((a: Account) => {
        if (a.name === 'Conto') (a.key = 'main'), (a.name = '')
        if (a.name === 'Contanti') (a.key = 'cash'), (a.name = '')
      })
  })

export const DEFAULT_CURRENCIES: Currency[] = [
  { code: 'EUR', symbol: '€', decimals: 2 },
  { code: 'USD', symbol: '$', decimals: 2 },
  { code: 'GBP', symbol: '£', decimals: 2 },
  { code: 'CHF', symbol: 'CHF', decimals: 2 },
  { code: 'ALL', symbol: 'L', decimals: 0 },
]

db.version(5).stores({
  syncQueue: '[tbl+id]',
  syncMeta: 'key',
})

db.version(6).stores({
  recurring: 'id',
  transactions: 'id, date, categoryId, accountId, goalId, recurringId',
})

// Terzo argomento: l'aggancio resta attivo a ogni apertura. Senza, vale solo per la prima della pagina
// e dopo una ricreazione del database (vedi "populate") lo stato resterebbe fermo su "in apertura".
db.on(
  'ready',
  () => {
    openState.opening = false
  },
  true,
)

// Un'altra finestra dell'app ha cancellato il database (uscita, cancellazione dei dati): questa ricarica la
// pagina e riparte dall'avvio. Altrimenti lo ricreerebbe coi dati predefiniti restando "già sincronizzata",
// e una risposta al riquadro iniziale finirebbe sopra i dati veri dell'account.
db.on('versionchange', (event) => {
  if (event.newVersion !== null) return
  db.close()
  location.reload()
  return false
})

/**
 * Dati iniziali. Gli ID sono fissi (es. "cat-groceries") così due dispositivi dello
 * stesso utente hanno le stesse categorie predefinite invece di doppioni.
 * La sincronizzazione li ignora perché nascono mentre il database è "in apertura" (openState).
 */
db.on('populate', (tx) => {
  // Anche quando il database viene ricreato senza ricaricare la pagina (dati locali cancellati e poi
  // riaperti): i dati predefiniti non sono modifiche dell'utente. Torna falso a database pronto.
  openState.opening = true
  // Valuta di partenza stimata dal dispositivo (fuso orario e lingua): la si conferma nel riquadro iniziale.
  // Queste scritture non vanno in coda: su un secondo dispositivo vince comunque la copia del server.
  const main = guessCurrency()
  tx.table('settings').add({ id: 'main', mainCurrency: main })
  tx.table('currencies').bulkAdd(DEFAULT_CURRENCIES)
  tx.table('accounts').bulkAdd([
    { id: 'acc-main', name: '', key: 'main', currency: main, initialBalance: 0, initialMain: 0, order: 0, archived: false },
    { id: 'acc-cash', name: '', key: 'cash', currency: main, initialBalance: 0, initialMain: 0, order: 1, archived: false },
  ])
  tx.table('categories').bulkAdd(
    SEED_CATEGORIES.map(([key, kind, color, icon], order) => ({
      id: `cat-${key}`,
      name: '',
      key,
      icon,
      kind,
      color,
      order,
      archived: false,
    })),
  )
})

