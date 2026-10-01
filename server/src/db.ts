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
  `
  -- Sessioni dell'app: il browser ha solo un cookie con l'id casuale.
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id_token    TEXT,                       -- per il logout su Keycloak
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX sessions_by_user ON sessions (user_id);

  -- Login in corso: state, PKCE verifier e nonce, validi pochi minuti.
  CREATE TABLE login_states (
    state       TEXT PRIMARY KEY,
    verifier    TEXT NOT NULL,
    nonce       TEXT NOT NULL,
    return_to   TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  `,
  `
  -- Nome e cognome separati, come li fornisce il servizio di identità (given_name, family_name).
  ALTER TABLE users ADD COLUMN given_name TEXT;
  ALTER TABLE users ADD COLUMN family_name TEXT;
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
