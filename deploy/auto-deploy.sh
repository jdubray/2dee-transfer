#!/usr/bin/env bash
# Poll GitHub and fast-forward /opt/2dee-transfer to origin/main.
# Invoked by 2dee-transfer-autodeploy.timer every ~60s (optional).
set -euo pipefail

REPO=/opt/2dee-transfer
BRANCH=main
LOCK=/run/2dee-transfer-autodeploy.lock

log() { echo "[transfer-deploy] $(date -Is) $*"; }

exec 9>"$LOCK"
flock -n 9 || { log "already running, skipping"; exit 0; }

cd "$REPO"
AS_APP="sudo -u transfer -H"

before=$($AS_APP git rev-parse HEAD 2>/dev/null || echo none)
$AS_APP git fetch --quiet origin "$BRANCH"
after=$($AS_APP git rev-parse "origin/$BRANCH")
[ "$before" = "$after" ] && exit 0

log "updating $before -> $after"
$AS_APP git reset --hard "origin/$BRANCH"
systemctl restart 2dee-transfer.service
log "restarted at $after"
