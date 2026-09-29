#!/usr/bin/env bash
# Backup del database di FIG. Gira sulla VPS (cron giornaliero, vedi README).
# Copia coerente con l'API di backup di SQLite dentro il container, controllo di integrità,
# poi compressione in $FIG_BACKUP_DIR tenendo le ultime $FIG_BACKUP_KEEP copie.
# Tocca solo il container "fig" e la cartella dei backup.
set -euo pipefail

DEST="${FIG_BACKUP_DIR:-/opt/fig-backups}"
KEEP="${FIG_BACKUP_KEEP:-14}"
CONTAINER="${FIG_CONTAINER:-fig}"
TMP=/tmp/fig-backup.db
STAMP="$(date +%F-%H%M)"
OUT="$DEST/fig-$STAMP.db"

umask 077
mkdir -p "$DEST"

docker exec -w /app/server "$CONTAINER" node -e "
const Database = require('better-sqlite3')
const fs = require('node:fs')
fs.rmSync('$TMP', { force: true })
const db = new Database(process.env.DB_PATH || '/data/fig.db')
db.backup('$TMP').then(() => {
  db.close()
  const copy = new Database('$TMP', { readonly: true })
  const check = copy.pragma('integrity_check', { simple: true })
  copy.close()
  if (check !== 'ok') { console.error('integrity_check: ' + check); process.exit(1) }
}).catch((e) => { console.error(e); process.exit(1) })
"

docker cp "$CONTAINER:$TMP" "$OUT"
docker exec "$CONTAINER" rm -f "$TMP"
gzip -f "$OUT"

# Rotazione: restano le ultime $KEEP copie.
ls -1t "$DEST"/fig-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --

echo "$(date -Is) backup ok: $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"
