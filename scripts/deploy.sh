#!/usr/bin/env bash
# Pubblica FIG sulla VPS: copia i file del repository in /opt/fig e ricostruisce il container.
# Il database sta nel volume Docker "fig_fig-data" e non viene toccato.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@31.14.134.70}"
DIR="${DEPLOY_DIR:-/opt/fig}"

cd "$(dirname "$0")/.."
git ls-files -z | tar --null -T - -czf - |
  ssh "$HOST" "mkdir -p '$DIR' && tar -xzf - -C '$DIR' && cd '$DIR' && docker compose up -d --build"

echo "Pubblicato su $HOST:$DIR"
