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
  const tx = Dexie.currentTransaction as (Transaction & { [REMOTE]?: boolean }) | null
  // La creazione e gli aggiornamenti di schema (dati iniziali) non si sincronizzano.
  return !!tx && (tx[REMOTE] === true || tx.mode === 'versionchange')
}

function enqueue(tbl: SyncedTable, key: unknown, deleted: boolean) {
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
 * Primo giro su un dispositivo: si scarica tutto l'archivio del server (che vince sui dati
 * predefiniti locali), poi si mettono in coda solo i record che esistono solo qui.
 */
async function adopt() {
  const remoteKeys = new Set<string>()
  let since = 0
  let more = true
  while (more) {
    const res = await api<{ rev: number; more: boolean; changes: RemoteChange[] }>('/api/sync', { since, changes: [] })
    const pending = new Set((await db.syncQueue.toArray()).map((q) => `${q.tbl}|${q.id}`))
    await applyRemote(res.changes, pending)
    for (const c of res.changes) remoteKeys.add(`${c.tbl}|${c.id}`)
    since = res.rev
    more = res.more
  }
  await db.syncMeta.put({ key: 'rev', value: since })
  await queueLocalOnly(remoteKeys)
  await db.syncMeta.delete('adopt')
}

async function refreshPending() {
  setStatus({ pending: await db.syncQueue.count() })
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
    if (await db.syncMeta.get('adopt')) await adopt()
    let more = true
    while (more) {
      const queue = await db.syncQueue.limit(BATCH).toArray()
      const changes = await Promise.all(
        queue.map(async (q) => {
          const data = q.deleted ? undefined : await db.table(q.tbl).get(q.id)
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
export async function startSync(user: User) {
  const owner = await db.syncMeta.get('owner')
  if (owner && owner.value !== user.sub) {
    await db.delete()
    location.reload()
    return
  }
  if (!owner) {
    await db.syncMeta.put({ key: 'owner', value: user.sub })
    // Primo accesso su questo dispositivo: al primo giro si scarica tutto e si caricano solo i dati che il server non ha.
    await db.syncMeta.put({ key: 'adopt', value: 1 })
  }
  started = true
  await refreshPending()
  void syncNow()
  window.setInterval(() => void syncNow(), 60_000)
  window.addEventListener('online', () => void syncNow())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow()
  })
}

/** All'uscita i dati locali vengono cancellati: restano sul server e tornano al prossimo accesso. */
export async function clearLocalData() {
  started = false
  await db.delete()
}
