#!/usr/bin/env bash
# Install the dedicated cloudflared tunnel for transfer.2dee.org.
#
# Prereqs (as your normal user, no sudo):
#   cloudflared tunnel create 2dee-transfer        # writes ~/.cloudflared/<UUID>.json
#   cloudflared --config /dev/null tunnel route dns --overwrite-dns <UUID> transfer.2dee.org
#     (--config /dev/null matters: otherwise ~/.cloudflared/config.yml's `tunnel:` wins)
#
# Then: sudo bash deploy/setup-tunnel.sh <UUID> /home/<you>/.cloudflared/<UUID>.json
set -euo pipefail

[ "$EUID" -eq 0 ] || { echo "Run as root: sudo bash $0 <UUID> <credentials.json>" >&2; exit 1; }
UUID="${1:?tunnel UUID}"
CREDS="${2:?path to the tunnel credentials JSON}"
[ -f "$CREDS" ] || { echo "No such file: $CREDS" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR=/etc/cloudflared-transfer

install -d -m 0755 "$DIR"
install -m 0600 "$CREDS" "$DIR/$UUID.json"
sed "s/<TUNNEL-UUID>/$UUID/g" "$HERE/cloudflared/config.yml.example" > "$DIR/config.yml"
chmod 0644 "$DIR/config.yml"
/usr/local/bin/cloudflared tunnel --config "$DIR/config.yml" ingress validate

install -m 0644 "$HERE/systemd/cloudflared-transfer.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cloudflared-transfer.service
systemctl restart cloudflared-transfer.service
sleep 3
systemctl --no-pager --lines=5 status cloudflared-transfer.service || true
echo
echo "Check from anywhere: curl -fsS https://transfer.2dee.org/api/health"
