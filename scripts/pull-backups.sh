#!/usr/bin/env bash
# Scarica sul PC le copie del database di FIG che la VPS fa ogni notte (scripts/backup.sh),
# così esiste una copia fuori dal server. Scarica solo i file nuovi, li verifica e tiene
# le ultime $FIG_LOCAL_KEEP copie. Si lancia a mano o da un'attività pianificata di Windows.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@31.14.134.70}"
SRC="${FIG_BACKUP_DIR:-/opt/fig-backups}"
DEST="${FIG_LOCAL_BACKUPS:-$HOME/FIG-backups}"
KEEP="${FIG_LOCAL_KEEP:-90}"

mkdir -p "$DEST"
new=0
for remote in $(ssh -o BatchMode=yes "$HOST" "ls -1 $SRC/fig-*.db.gz 2>/dev/null"); do
  name="$(basename "$remote")"
  [ -f "$DEST/$name" ] && continue
  scp -q -o BatchMode=yes "$HOST:$remote" "$DEST/$name.part"
  # Un file rovinato non prende il posto di uno buono.
  gzip -t "$DEST/$name.part"
  mv "$DEST/$name.part" "$DEST/$name"
  new=$((new + 1))
done

# Rotazione: restano le ultime $KEEP copie.
ls -1t "$DEST"/fig-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --

latest="$(ls -1t "$DEST"/fig-*.db.gz 2>/dev/null | head -1)"
echo "$(date -Iseconds) $new new, latest: ${latest:-none} ($DEST)"
