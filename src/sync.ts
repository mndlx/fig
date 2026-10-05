import Dexie, { type Transaction } from 'dexie'
import { useSyncExternalStore } from 'react'
import { signIn, type User } from './auth'
import { materializeRecurring } from './recurring'
import { db, openState, SYNCED_TABLES, type QueuedChange, type SyncedTable } from './db'

/**
 * Sincronizzazione "local-first": l'app scrive sempre nel database del browser,
 * ogni modifica finisce in una coda e viene inviata al server appena possibile.
 * Il server risponde con quello che è cambiato sugli altri dispositivi.
 */

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'offline'
  lastSync: number | null
  pending: number
}

let status: SyncStatus = { state: 'idle', lastSync: null, pending: 0 }
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
 * Se poi si accede, i dati locali vengono caricati tutti al primo giro (adopt → queueLocalOnly).
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

/** Esegue scritture che non devono tornare al server (dati arrivati dal server, ripristini). */
export async function withoutSync<T>(fn: () => Promise<T>): Promise<T> {
  return db.transaction('rw', [...SYNCED_TABLES.map((t) => db.table(t))], async () => {
    ;(Dexie.currentTransaction as unknown as Record<symbol, boolean>)[REMOTE] = true
    return fn()
  })
}

/** Mette in coda i record locali che il server non conosce (primo accesso su un dispositivo con dei dati). */
async function queueLocalOnly(remoteKeys: Set<string>) {
  const now = Date.now()
  const entries: QueuedChange[] = []
  for (const tbl of SYNCED_TABLES) {
    const keys = await db.table(tbl).toCollection().primaryKeys()
    for (const key of keys) if (!remoteKeys.has(`${tbl}|${key}`)) entries.push({ tbl, id: String(key), deleted: false, at: now })
  }
  await db.syncQueue.bulkPut(entries)
}

async function applyRemote(changes: RemoteChange[], skip: Set<string>) {
  await withoutSync(async () => {
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

/**
 * Primo giro su un dispositivo: si scarica tutto l'archivio dell'account, poi lo si applica in un
 * colpo solo. Qui il server vince anche sulle modifiche in coda per i record che conosce: sono
 * state fatte guardando i dati predefiniti (valuta stimata, conti vuoti), non quelli dell'utente,
 * e inviarle sovrascriverebbe su ogni dispositivo impostazioni e saldi iniziali veri.
 * I record che esistono solo qui vanno in coda e vengono caricati.
 *
 * Tutto in un'unica transazione, compresa la fine dell'adozione: se lo scaricamento si interrompe
 * a metà il dispositivo resta com'era (mai mezzo archivio a schermo, niente da rifare sopra a
 * modifiche fatte nel frattempo), e una modifica fatta subito dopo trova già la coda a posto.
 */
async function adopt() {
  const archive: RemoteChange[] = []
  let since = 0
  let more = true
  while (more) {
    const res = await api<{ rev: number; more: boolean; changes: RemoteChange[] }>('/api/sync', { since, changes: [] })
    archive.push(...res.changes)
    since = res.rev
    more = res.more
  }
  await db.transaction('rw', [...SYNCED_TABLES.map((t) => db.table(t)), db.syncQueue, db.syncMeta], async () => {
    quietCurrentTransaction()
    // Un'altra finestra dell'app può aver finito l'adozione mentre questa scaricava: riapplicare adesso
    // l'archivio cancellerebbe le modifiche fatte nel frattempo. Si prosegue col giro normale.
    if (!(await db.syncMeta.get('adopt'))) return
    const remoteKeys = new Set<string>()
    for (const c of archive) {
      if (!SYNCED_TABLES.includes(c.tbl)) continue
      const table = db.table(c.tbl)
      if (c.deleted) await table.delete(c.id)
      else if (c.data) await table.put(c.data)
      await db.syncQueue.delete([c.tbl, c.id])
      remoteKeys.add(`${c.tbl}|${c.id}`)
    }
    await db.syncMeta.put({ key: 'rev', value: since })
    await queueLocalOnly(remoteKeys)
    await db.syncMeta.delete('adopt')
  })
}

async function refreshPending() {
  // Arriva anche dalla scia di una transazione dell'app, che non comprende la coda: si conta fuori da quella.
  setStatus({ pending: await Dexie.ignoreTransaction(() => db.syncQueue.count()) })
}

// ——— Scambio col server ———

interface RemoteChange {
  tbl: SyncedTable
  id: string
  deleted: boolean
  data?: Record<string, unknown>
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  // Sessione scaduta: i dati restano in coda sul dispositivo, si rifà il login e si riprende.
  if (res.status === 401) {
    signIn()
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
  if (!navigator.onLine) return setStatus({ state: 'offline' })
  running = true
  setStatus({ state: 'syncing' })
  try {
    if (await db.syncMeta.get('adopt')) {
      await adopt()
      // L'adozione riempie la coda coi dati che esistono solo qui: il conteggio "in attesa" lo deve sapere subito.
      await refreshPending()
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
    await refreshPending()
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
 * Avvia la sincronizzazione per l'utente autenticato. Se sul dispositivo c'erano
 * i dati di un altro utente vengono cancellati; se c'erano dati senza proprietario
 * (app usata prima del login) vengono adottati e caricati sul server.
 */
export async function startSync(user: User): Promise<{ adopting: boolean; first: Promise<void> } | null> {
  const owner = await db.syncMeta.get('owner')
  if (owner && owner.value !== user.sub) {
    await db.delete()
    location.reload()
    return null
  }
  if (!owner) {
    // Primo accesso su questo dispositivo: al primo giro si scarica tutto e si caricano solo i dati che il server non ha.
    // Le due righe nascono insieme: un proprietario senza "adopt" farebbe passare i dati predefiniti per quelli dell'utente.
    await db.syncMeta.bulkPut([
      { key: 'owner', value: user.sub },
      { key: 'adopt', value: 1 },
    ])
  }
  // Vero finché l'archivio dell'account non è stato scaricato qui: chi avvia l'app aspetta `first` prima di mostrarla.
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
  await db.delete()
}
