import Dexie, { type Transaction } from 'dexie'
import { useSyncExternalStore } from 'react'
import { classifyAdoption, describeAdoption, planAdoption, reduceArchive, type AdoptionPlan, type AdoptionPreview, type Archive, type LocalData, type RemoteChange, type Row } from './adoption'
import { endSession, localModeAllowed, setLocalOnly, signIn, type User } from './auth'
import { db, openState, SYNCED_TABLES, type QueuedChange, type SyncedTable } from './db'
import { builtinName } from './i18n'
import { migrateInitialBalances } from './opening'
import { materializeRecurring } from './recurring'

/**
 * Sincronizzazione "local-first": l'app scrive sempre nel database del browser,
 * ogni modifica finisce in una coda e viene inviata al server appena possibile.
 * Il server risponde con quello che è cambiato sugli altri dispositivi.
 */

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'offline'
  lastSync: number | null
  pending: number
  /**
   * Primo accesso da un dispositivo che ha già dati suoi verso un account che ne ha altri:
   * finché la persona non sceglie cosa farne non si scarica e non si carica niente.
   */
  conflict: boolean
}

let status: SyncStatus = { state: 'idle', lastSync: null, pending: 0, conflict: false }
const listeners = new Set<() => void>()

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch }
  listeners.forEach((l) => l())
}

export function getSyncStatus(): SyncStatus {
  return status
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => status,
  )
}

// ——— Coda delle modifiche locali ———

/** Segna la transazione corrente come "arrivata dal server": le sue scritture non vanno in coda. */
const REMOTE = Symbol('remote')

function isQuiet(): boolean {
  if (openState.opening) return true
  // Dati iniziali e aggiornamenti di schema nascono mentre il database è "in apertura" (sopra);
  // qui restano le transazioni segnate come arrivate dal server.
  const tx = Dexie.currentTransaction as (Transaction & { [REMOTE]?: boolean }) | null
  return !!tx && tx[REMOTE] === true
}

/**
 * Senza account non c'è niente da inviare: le modifiche non vanno in coda.
 * Se poi si accede, al primo giro si decide come i dati locali incontrano quelli dell'account (adopt).
 */
let localOnly = false

export async function stopSyncQueue() {
  localOnly = true
  // Code rimaste da versioni precedenti o da un account da cui si è usciti: non servono più.
  await db.syncQueue.clear()
}

function enqueue(tbl: SyncedTable, key: unknown, deleted: boolean) {
  if (localOnly) return
  const entry: QueuedChange = { tbl, id: String(key), deleted, at: Date.now() }
  void Dexie.ignoreTransaction(() => db.syncQueue.put(entry)).then(() => {
    void refreshPending()
    scheduleSync()
  })
}

for (const tbl of SYNCED_TABLES) {
  const table = db.table(tbl)
  table.hook('creating', function (primKey) {
    if (isQuiet()) return
    this.onsuccess = (key) => enqueue(tbl, key ?? primKey, false)
  })
  table.hook('updating', function (_mods, primKey) {
    if (isQuiet()) return
    this.onsuccess = () => enqueue(tbl, primKey, false)
  })
  table.hook('deleting', function (primKey) {
    if (isQuiet()) return
    this.onsuccess = () => enqueue(tbl, primKey, true)
  })
}

/** Dentro una transazione: le sue scritture non passano dagli hook della coda (chi la apre gestisce la coda da sé). */
export function quietCurrentTransaction() {
  ;(Dexie.currentTransaction as unknown as Record<symbol, boolean>)[REMOTE] = true
}

// ——— Legame tra questa pagina, il dispositivo e l'account ———

/** Utente per cui la sincronizzazione è partita in questa pagina; null se si sta usando FIG senza account. */
let sub: string | null = null
/** Fermata: il dispositivo sta lasciando l'account (o i suoi dati sono appena stati cancellati). */
let halted = false
/** Dati dell'account scaricati e messi da parte finché la persona non sceglie come unirli a quelli di qui. */
let question: { rev: number; archive: Archive } | null = null

const everything = () => [...SYNCED_TABLES.map((t) => db.table(t)), db.syncQueue, db.syncMeta]

/** Il dispositivo appartiene all'utente di questa pagina? Ha già scaricato i suoi dati ("adopt" assente)? */
async function link(): Promise<{ mine: boolean; adopt: boolean }> {
  const [owner, adopt] = await db.syncMeta.bulkGet(['owner', 'adopt'])
  return { mine: !halted && sub !== null && owner?.value === sub, adopt: !!adopt }
}

/** Vero solo quando è lecito scambiare modifiche col server: dispositivo dell'utente e primo scaricamento concluso. */
async function linked(): Promise<boolean> {
  const l = await link()
  return l.mine && !l.adopt
}

async function applyRemote(changes: RemoteChange[], skip: Set<string>) {
  await db.transaction('rw', [...SYNCED_TABLES.map((t) => db.table(t)), db.syncMeta], async () => {
    quietCurrentTransaction()
    // Mentre la risposta era in viaggio il dispositivo può aver lasciato l'account (da qui o da un'altra finestra):
    // i dati dell'account non devono finirci sopra.
    if (!(await linked())) throw new Error('unlinked')
    for (const c of changes) {
      if (!SYNCED_TABLES.includes(c.tbl)) continue
      // Una modifica locale non ancora inviata vince: partirà al prossimo giro.
      if (skip.has(`${c.tbl}|${c.id}`)) continue
      const table = db.table(c.tbl)
      if (c.deleted) await table.delete(c.id)
      else if (c.data) await table.put(c.data)
    }
  })
}

// ——— Primo accesso su un dispositivo ———

/** Scarica dall'account tutto quello che è cambiato dopo `since` e lo aggiunge ai dati già scaricati. */
async function download(since: number, into: Archive): Promise<number> {
  let more = true
  while (more) {
    const res = await api<{ rev: number; more: boolean; changes: RemoteChange[] }>('/api/sync', { since, changes: [] })
    reduceArchive(res.changes, into)
    since = res.rev
    more = res.more
  }
  return since
}

async function readLocal(): Promise<LocalData> {
  const local = {} as LocalData
  for (const tbl of SYNCED_TABLES) local[tbl] = (await db.table(tbl).toArray()) as Row[]
  return local
}

const accountName = (account: Row) => builtinName(account as { name: string; key?: string }, 'acc')

/** Scrive un piano e chiude l'adozione. Va chiamata dentro la transazione che ha letto i dati su cui il piano è stato fatto. */
async function applyPlan(plan: AdoptionPlan, rev: number) {
  for (const tbl of SYNCED_TABLES) {
    const gone = plan.remove.filter((r) => r.tbl === tbl).map((r) => r.id)
    if (gone.length) await db.table(tbl).bulkDelete(gone)
  }
  for (const tbl of SYNCED_TABLES) {
    const rows = plan.put.filter((p) => p.tbl === tbl).map((p) => p.row)
    if (rows.length) await db.table(tbl).bulkPut(rows)
  }
  // Finché l'adozione era aperta niente può essere partito: la coda si rifà da capo coi record da caricare.
  // Restano le cancellazioni fatte qui di record che dopo il piano non ci sono più (per esempio una categoria
  // predefinita tolta prima dell'accesso): senza, un altro dispositivo nuovo la farebbe ricomparire.
  const now = Date.now()
  const deletions: QueuedChange[] = []
  for (const q of await db.syncQueue.toArray()) if (q.deleted && !(await db.table(q.tbl).get(q.id))) deletions.push(q)
  await db.syncQueue.clear()
  await db.syncQueue.bulkPut([...deletions, ...plan.queue.map(({ tbl, id }) => ({ tbl, id, deleted: false, at: now }))])
  await db.syncMeta.put({ key: 'rev', value: rev })
  await db.syncMeta.delete('adopt')
}

/**
 * Primo giro su un dispositivo: si scaricano tutti i dati dell'account, poi si decide come incontrano
 * quelli che ci sono già qui (vedi adoption.ts) e li si applica in un colpo solo.
 * - Dispositivo senza dati propri: vince l'account, anche sulle modifiche fatte guardando i dati predefiniti.
 * - Account senza dati: vince il dispositivo, e i suoi dati vengono caricati.
 * - Dati da tutte e due le parti: non si tocca niente e si chiede alla persona ("conflict").
 *
 * Decisione e scritture stanno in un'unica transazione, compresa la fine dell'adozione: se lo scaricamento
 * si interrompe il dispositivo resta com'era, e una modifica fatta subito dopo trova già la coda a posto.
 */
async function adopt(): Promise<'applied' | 'gone' | 'conflict'> {
  // I saldi iniziali tenuti nel vecchio campo del conto diventano movimenti prima di guardare cosa c'è qui.
  await migrateInitialBalances()
  const archive: Archive = new Map()
  const rev = await download(0, archive)
  const outcome = await db.transaction('rw', everything(), async () => {
    quietCurrentTransaction()
    // Un'altra finestra può aver finito l'adozione, o il dispositivo aver lasciato l'account, mentre questa scaricava.
    const l = await link()
    if (!l.mine || !l.adopt) return 'gone' as const
    const local = await readLocal()
    const kind = classifyAdoption(local, archive)
    if (kind === 'conflict') return 'conflict' as const
    await applyPlan(planAdoption(kind, local, archive), rev)
    return 'applied' as const
  })
  if (outcome === 'conflict') {
    question = { rev, archive }
    setStatus({ conflict: true })
  }
  return outcome
}

/** La domanda non c'è più (risposta data da un'altra finestra, o dispositivo non più legato): si riprende normalmente. */
function questionGone() {
  question = null
  setStatus({ conflict: false })
  void syncNow()
}

/** Quello che c'è sul dispositivo e nell'account, per la schermata della scelta; null se non c'è niente da scegliere. */
export async function previewAdoption(): Promise<AdoptionPreview | null> {
  if (!question) return null
  return describeAdoption(await readLocal(), question.archive, { accountName })
}

/**
 * Risposta alla domanda del primo accesso.
 * - "merge": i dati del dispositivo si aggiungono a quelli dell'account. Con valute principali diverse serve
 *   `rate` (1 unità della valuta del dispositivo = rate unità di quella dell'account).
 * - "account": si tengono solo i dati dell'account. Il dispositivo viene svuotato: chi chiama ricarica la pagina
 *   e il dispositivo riparte come uno nuovo.
 * Serve la rete: prima di tutto si riscarica quello che nell'account è cambiato mentre la persona decideva.
 */
export async function resolveAdoption(choice: 'merge' | 'account', rate?: number): Promise<'merged' | 'dropped' | 'gone'> {
  const q = question
  if (!q) return 'gone'
  q.rev = await download(q.rev, q.archive)
  if (choice === 'account') {
    const l = await link()
    if (!l.mine || !l.adopt) {
      questionGone()
      return 'gone'
    }
    await clearLocalData()
    return 'dropped'
  }
  const outcome = await db.transaction('rw', everything(), async () => {
    quietCurrentTransaction()
    const l = await link()
    if (!l.mine || !l.adopt) return 'gone' as const
    // Tutto dal database di adesso: comprende le modifiche fatte mentre la domanda era aperta.
    const local = await readLocal()
    await applyPlan(planAdoption('merge', local, q.archive, { rate, newId: () => crypto.randomUUID(), accountName }), q.rev)
    return 'merged' as const
  })
  question = null
  setStatus({ conflict: false })
  await refreshPending()
  await syncNow()
  return outcome
}

/** Il dispositivo ha dati della persona che l'account non ha ancora ricevuto (adozione non conclusa)? */
export async function adoptionPending(): Promise<boolean> {
  if (!(await db.syncMeta.get('adopt'))) return false
  return (await db.transactions.count()) + (await db.goals.count()) + (await db.recurring.count()) > 0
}

/** Ferma ogni scambio col server (per esempio mentre si cancella l'account); `resumeSync` lo riprende se l'operazione fallisce. */
export function haltSync() {
  halted = true
}
export function resumeSync() {
  halted = false
}

/**
 * Scioglie il legame tra dispositivo e account senza toccare i dati: tornano dati "senza account".
 * La coda si svuota: niente di quello che c'è qui deve più partire.
 * Niente rete qui dentro: chi chiama ha già chiuso la sessione, e tra quello e questo non deve esserci attesa
 * (un dispositivo ancora legato con la sessione chiusa, al prossimo avvio, rientrerebbe da solo nell'account).
 */
export async function unlinkDevice(allowed: boolean) {
  halted = true
  started = false
  localOnly = true
  await db.transaction('rw', [db.syncMeta, db.syncQueue], async () => {
    await db.syncMeta.bulkDelete(['owner', 'adopt', 'rev'])
    await db.syncQueue.clear()
  })
  question = null
  setStatus({ conflict: false, pending: 0 })
  // Si continua senza account solo dove il server lo permette (`allowed`); altrimenti al prossimo avvio si chiede l'accesso.
  if (allowed) setLocalOnly(true)
}

let leaving = false

/**
 * Uscita dall'account dalle Impostazioni: decide cosa succede ai dati del dispositivo, in un punto solo.
 * - "kept": i dati non erano mai arrivati nell'account (primo accesso non concluso). Il dispositivo si scollega
 *   e restano dove sono; `url` è l'indirizzo a cui andare.
 * - "confirm": ci sono modifiche non ancora inviate, che uscendo si perderebbero: serve una conferma.
 * - "cleared": il dispositivo era una copia sincronizzata dell'account: i dati locali sono stati cancellati
 *   (restano sul server); chi chiama chiude la sessione.
 * - "unlinked": il dispositivo non è più legato a un account (già scollegato da qui o da un'altra finestra):
 *   quello che c'è è solo suo e non si cancella.
 * - "busy": un'uscita è già in corso (secondo tocco).
 * Lancia un errore se doveva scollegarsi e non ha potuto (senza rete, sessione non chiusa): niente è cambiato.
 */
export async function leaveAccount(force = false): Promise<{ outcome: 'kept'; url: string } | { outcome: 'confirm'; waiting: number } | { outcome: 'cleared' | 'unlinked' | 'busy' }> {
  if (leaving) return { outcome: 'busy' }
  leaving = true
  try {
    if (!(await db.syncMeta.get('owner'))) return { outcome: 'unlinked' }
    // Prima di ogni sincronizzazione: con dati mai caricati, un ultimo giro riuscito li caricherebbe proprio
    // adesso (e poi verrebbero cancellati da qui), cioè il contrario di quello che si è appena promesso.
    if (await adoptionPending()) {
      const url = await cancelAdoption()
      if (url) return { outcome: 'kept', url }
      // Adozione conclusa proprio adesso: si prosegue come su un dispositivo sincronizzato. Altrimenti questa pagina
      // non può scollegarlo (è partita senza rete, o il dispositivo è di un altro utente): non si tocca niente.
      if (await adoptionPending()) throw new Error('cannot_leave')
    }
    if (!force) {
      await syncNow()
      if (!(await db.syncMeta.get('owner'))) return { outcome: 'unlinked' }
      // Contato dal database, non dallo stato a schermo: durante il primo caricamento quello può essere indietro.
      const waiting = await db.syncQueue.count()
      if (waiting > 0) return { outcome: 'confirm', waiting }
    }
    await clearLocalData()
    return { outcome: 'cleared' }
  } finally {
    leaving = false
  }
}

/**
 * Esce dall'account lasciando i dati sul dispositivo, senza caricarli: per chi ha fatto l'accesso con l'account
 * sbagliato o non vuole unire. Restituisce l'indirizzo a cui andare, oppure null se non c'era più niente da annullare.
 * Prima si chiude la sessione sul server: se non riesce non cambia niente, altrimenti al prossimo avvio
 * il dispositivo si ricollegherebbe da solo.
 */
export async function cancelAdoption(): Promise<string | null> {
  // Chiesto prima di chiudere la sessione: dopo, fino allo scollegamento, non si aspetta più la rete.
  const allowed = await localModeAllowed()
  const l = await link()
  if (!l.mine || !l.adopt) {
    questionGone()
    return null
  }
  halted = true
  let url: string
  try {
    url = await endSession()
  } catch (e) {
    halted = false
    throw e
  }
  await unlinkDevice(allowed)
  return url
}

async function refreshPending() {
  // Arriva anche dalla scia di una transazione dell'app, che non comprende la coda: si conta fuori da quella.
  setStatus({ pending: await Dexie.ignoreTransaction(() => db.syncQueue.count()) })
}

// ——— Scambio col server ———

async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  // Sessione scaduta: i dati restano in coda sul dispositivo, si rifà il login e si riprende.
  // Non mentre il dispositivo sta lasciando l'account: lì la sessione è stata chiusa apposta.
  if (res.status === 401) {
    if (!halted) signIn()
    throw new Error('not_signed_in')
  }
  if (!res.ok) throw new Error(`sync_${res.status}`)
  return res.json() as Promise<T>
}

async function getRev(): Promise<number> {
  return Number((await db.syncMeta.get('rev'))?.value ?? 0)
}

const BATCH = 1000
let running = false
let again = false

export async function syncNow(): Promise<void> {
  if (running) {
    again = true
    return
  }
  // Senza un accesso fatto da questa pagina (uso senza account), o mentre il dispositivo lascia l'account, non si sincronizza.
  if (halted || sub === null) return
  running = true
  try {
    const [owner, adoptRow] = await db.syncMeta.bulkGet(['owner', 'adopt'])
    // Il dispositivo non è più di questo utente (un'altra finestra è uscita o ha cambiato account): si riparte dall'avvio.
    if (!owner || owner.value !== sub) {
      halted = true
      location.reload()
      return
    }
    if (question) {
      // Domanda aperta: niente rete e niente scritture finché non c'è una risposta. Le ricorrenti si generano come senza account.
      if (adoptRow && (await adoptionPending())) {
        void materializeRecurring()
        return
      }
      // Risposta data in un'altra finestra, oppure sul dispositivo non c'è più niente di suo (cancellato nel
      // frattempo): la domanda non vale più e si rifà il primo giro, che deciderà da capo.
      question = null
      setStatus({ conflict: false })
    }
    if (!navigator.onLine) {
      setStatus({ state: 'offline' })
      return
    }
    setStatus({ state: 'syncing' })
    if (adoptRow) {
      const outcome = await adopt()
      // L'adozione riempie la coda coi dati da caricare: il conteggio "in attesa" lo deve sapere subito.
      await refreshPending()
      if (outcome === 'conflict') {
        setStatus({ state: 'idle' })
        void materializeRecurring()
        return
      }
    }
    // Adozione non conclusa o dispositivo non più legato: il giro normale non parte.
    if (!(await linked())) {
      setStatus({ state: 'idle' })
      return
    }
    let more = true
    while (more) {
      const queue = await db.syncQueue.limit(BATCH).toArray()
      const changes = await Promise.all(
        queue.map(async (q) => {
          // Si invia il record com'è adesso, non com'era quando è finito in coda: una cancellazione superata
          // (record tornato, per esempio dall'archivio appena scaricato) non deve cancellarlo sul server.
          const data = await db.table(q.tbl).get(q.id)
          return data ? { tbl: q.tbl, id: q.id, data } : { tbl: q.tbl, id: q.id, deleted: true }
        }),
      )
      const res = await api<{ rev: number; more: boolean; changes: RemoteChange[] }>('/api/sync', { since: await getRev(), changes })

      // Tolgo dalla coda solo ciò che non è cambiato di nuovo durante l'invio.
      await db.transaction('rw', db.syncQueue, async () => {
        for (const q of queue) {
          const current = await db.syncQueue.get([q.tbl, q.id])
          if (current && current.at === q.at) await db.syncQueue.delete([q.tbl, q.id])
        }
      })

      const stillPending = new Set((await db.syncQueue.toArray()).map((q) => `${q.tbl}|${q.id}`))
      await applyRemote(res.changes, stillPending)
      await db.syncMeta.put({ key: 'rev', value: res.rev })
      more = res.more || (await db.syncQueue.count()) > 0 && queue.length === BATCH
    }
    setStatus({ state: 'idle', lastSync: Date.now() })
    // Una serie creata su un altro dispositivo genera qui le sue scadenze.
    void materializeRecurring()
  } catch {
    setStatus({ state: navigator.onLine ? 'error' : 'offline' })
  } finally {
    running = false
    // Il database può essere stato chiuso nel frattempo (dati cancellati): il conteggio non serve più.
    await refreshPending().catch(() => {})
    if (again) {
      again = false
      scheduleSync(500)
    }
  }
}

let timer: number | undefined
function scheduleSync(delay = 1500) {
  if (!started) return
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void syncNow(), delay)
}

let started = false

/**
 * Avvia la sincronizzazione per l'utente autenticato.
 * - Dispositivo senza proprietario (mai collegato, o usato senza account): diventa suo e resta "da adottare":
 *   al primo giro si decide come i dati che ci sono qui incontrano quelli dell'account.
 * - Dispositivo di un altro utente che aveva già scaricato i suoi dati: è una copia di quell'account, si cancella.
 * - Dispositivo passato a un altro utente prima che l'adozione finisse: dell'account di prima qui non è arrivato
 *   né partito niente, i dati sono ancora solo del dispositivo. Passano al nuovo utente senza cancellare nulla.
 */
export async function startSync(user: User): Promise<{ adopting: boolean; first: Promise<void> } | null> {
  const wipe = await db.transaction('rw', db.syncMeta, async () => {
    const [owner, adopt] = await db.syncMeta.bulkGet(['owner', 'adopt'])
    if (owner?.value === user.sub) return false
    if (owner && !adopt) return true
    // Proprietario e "adopt" nascono insieme: un proprietario senza "adopt" farebbe passare i dati di qui per già sincronizzati.
    await db.syncMeta.bulkPut([
      { key: 'owner', value: user.sub },
      { key: 'adopt', value: 1 },
    ])
    await db.syncMeta.delete('rev')
    return false
  })
  if (wipe) {
    await db.delete()
    location.reload()
    return null
  }
  sub = user.sub
  halted = false
  localOnly = false
  question = null
  setStatus({ conflict: false })
  // Vero finché i dati dell'account non sono stati scaricati qui: chi avvia l'app aspetta `first` prima di mostrarla.
  const adopting = !!(await db.syncMeta.get('adopt'))
  // Una sessione partita senza rete avvia la sincronizzazione più tardi: timer e ascoltatori si registrano una volta sola.
  if (started) return { adopting, first: syncNow() }
  started = true
  await refreshPending()
  const first = syncNow()
  window.setInterval(() => void syncNow(), 60_000)
  window.addEventListener('online', () => void syncNow())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow()
  })
  return { adopting, first }
}

/** All'uscita i dati locali vengono cancellati: restano sul server e tornano al prossimo accesso. */
export async function clearLocalData() {
  started = false
  halted = true
  sub = null
  question = null
  setStatus({ conflict: false })
  await db.delete()
}
