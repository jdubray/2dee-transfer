#!/usr/bin/env bash
# One-shot installer for an Ubuntu host that already runs Bun + cloudflared
# (same layout as jj.2dee.org). Idempotent — safe to re-run to upgrade.
#
#   sudo bash deploy/install.sh                 # install from this checkout
#   sudo TRANSFER_REPO=git@github.com:you/transfer.git bash deploy/install.sh
#
# It does NOT touch cloudflared; see deploy/cloudflared/ingress-snippet.yml.
set -euo pipefail

[ "$EUID" -eq 0 ] || { echo "Run as root: sudo bash $0" >&2; exit 1; }
command -v /usr/local/bin/bun >/dev/null || { echo "Bun not found at /usr/local/bin/bun" >&2; exit 1; }

APP=/opt/2dee-transfer
DATA=/var/lib/2dee-transfer
ENV=/etc/2dee-transfer.env
SRC="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> user + directories"
id transfer >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin transfer
install -d -o transfer -g transfer -m 0750 "$DATA"

echo "==> code in $APP"
if [ -n "${TRANSFER_REPO:-}" ]; then
  if [ -d "$APP/.git" ]; then
    sudo -u transfer -H git -C "$APP" pull --ff-only
  else
    install -d -o transfer -g transfer "$APP"
    sudo -u transfer -H git clone "$TRANSFER_REPO" "$APP"
  fi
elif [ "$SRC" != "$APP" ]; then
  install -d -o transfer -g transfer "$APP"
  cp -a "$SRC/." "$APP/"
  rm -rf "$APP/var" "$APP/node_modules"
  chown -R transfer:transfer "$APP"
fi

echo "==> environment ($ENV)"
if [ ! -f "$ENV" ]; then
  CODE="${TRANSFER_ACCESS_CODE:-$(head -c 15 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 10)}"
  sed "s|^TRANSFER_ACCESS_CODE=.*|TRANSFER_ACCESS_CODE=$CODE|" "$APP/deploy/2dee-transfer.env.example" > "$ENV"
  echo "    Generated access code: $CODE   (change it any time in $ENV, then restart)"
else
  echo "    Keeping existing $ENV"
fi
chown root:transfer "$ENV"
chmod 640 "$ENV"

echo "==> systemd"
install -m 0644 "$APP/deploy/systemd/2dee-transfer.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now 2dee-transfer.service
systemctl restart 2dee-transfer.service

if [ -n "${TRANSFER_REPO:-}" ]; then
  chmod +x "$APP/deploy/auto-deploy.sh"
  install -m 0644 "$APP/deploy/systemd/2dee-transfer-autodeploy.service" /etc/systemd/system/
  install -m 0644 "$APP/deploy/systemd/2dee-transfer-autodeploy.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now 2dee-transfer-autodeploy.timer
  echo "    Auto-deploy enabled: pushes to main land within ~60s."
fi

echo "==> health check"
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4180/api/health >/dev/null 2>&1; then
    echo "    OK — listening on 127.0.0.1:4180"
    echo
    echo "Next: add deploy/cloudflared/ingress-snippet.yml to your tunnel config,"
    echo "      run 'cloudflared tunnel route dns <tunnel> transfer.2dee.org',"
    echo "      restart that cloudflared service, then open https://transfer.2dee.org"
    exit 0
  fi
  sleep 0.5
done
echo "Service did not answer; check: journalctl -u 2dee-transfer -n 50" >&2
exit 1
