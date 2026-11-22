#!/usr/bin/env bash
# Create (or rotate) personal access keys, one per person:
#
#   sudo bash deploy/add-keys.sh jean-jacques edouard jean-pierre
#
# - Generates a fresh key for each name given (rotating it if the name exists;
#   that person's open sessions end, nobody else's).
# - Keeps keys for people not named.
# - Removes the old shared TRANSFER_ACCESS_CODE, so only personal keys work.
# - Restarts the service and prints the new keys once. They are stored only
#   in /etc/2dee-transfer.env.
#
# Revoke someone: delete their name:key entry from TRANSFER_ACCESS_KEYS in
# /etc/2dee-transfer.env, then `sudo systemctl restart 2dee-transfer`.
set -euo pipefail

[ "$EUID" -eq 0 ] || { echo "Run as root: sudo bash $0 name [name...]" >&2; exit 1; }
[ $# -ge 1 ] || { echo "Usage: sudo bash $0 name [name...]" >&2; exit 1; }
ENV=/etc/2dee-transfer.env
[ -f "$ENV" ] || { echo "$ENV not found; run deploy/install.sh first" >&2; exit 1; }

# 12 unambiguous characters, shown as xxxx-xxxx-xxxx.
gen() {
  (set +o pipefail; LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c 12) |
    sed 's/.\{4\}/&-/g; s/-$//'
}

declare -A keys=()
order=()
existing="$(grep -E '^TRANSFER_ACCESS_KEYS=' "$ENV" | tail -n 1 | cut -d= -f2- || true)"
IFS=',' read -ra entries <<< "$existing"
for e in "${entries[@]}"; do
  n="${e%%:*}"
  [ -n "$n" ] || continue
  keys[$n]="${e#*:}"
  order+=("$n")
done

created=()
for raw in "$@"; do
  n="$(echo "$raw" | tr 'A-Z' 'a-z')"
  [[ "$n" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "Bad name: $raw (use letters, digits, dashes)" >&2; exit 1; }
  [ -n "${keys[$n]+x}" ] || order+=("$n")
  keys[$n]="$(gen)"
  created+=("$n")
done

line=""
for n in "${order[@]}"; do line+="${line:+,}$n:${keys[$n]}"; done

tmp="$(mktemp)"
grep -vE '^(TRANSFER_ACCESS_KEYS|TRANSFER_ACCESS_CODE)=' "$ENV" > "$tmp" || true
echo "TRANSFER_ACCESS_KEYS=$line" >> "$tmp"
install -o root -g transfer -m 0640 "$tmp" "$ENV"
rm -f "$tmp"

systemctl restart 2dee-transfer.service
for _ in $(seq 1 20); do
  curl -fsS http://127.0.0.1:4180/api/health >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS http://127.0.0.1:4180/api/health >/dev/null || { echo "Service did not come back; journalctl -u 2dee-transfer -n 50" >&2; exit 1; }

echo
echo "Access keys (shown once; also stored in $ENV):"
for n in "${created[@]}"; do printf '  %-16s %s\n' "$n" "${keys[$n]}"; done
echo
echo "Active keys: ${order[*]}"
