import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Schema: ogni utente ha i propri record, uno per ogni oggetto dell'app
 * (movimento, categoria, conto, ...), salvato come JSON. `rev` cresce a ogni
 * modifica ed è il cursore con cui i dispositivi chiedono "cosa è cambiato da X".
 */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id          TEXT PRIMARY KEY,           -- claim "sub" del token
    email       TEXT,
    name        TEXT,
    rev         INTEGER NOT NULL DEFAULT 0, -- ultima revisione assegnata ai record dell'utente
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );

  CREATE TABLE records (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tbl         TEXT NOT NULL,
    id          TEXT NOT NULL,
    data        TEXT,                       -- JSON dell'oggetto; NULL se eliminato
    deleted     INTEGER NOT NULL DEFAULT 0,
    rev         INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, tbl, id)
  );

  CREATE INDEX records_by_rev ON records (user_id, rev);
  `,
]

export function openDb(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const version = db.pragma('user_version', { simple: true }) as number
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return db
}

export type Db = ReturnType<typeof openDb>
