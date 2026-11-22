# 2dee transfer

A small, private file-transfer site for friends at **transfer.2dee.org**.
It works like WeTransfer: you get a card with a big "+", drop files in, and share a link.

- **One shared access code.** No accounts. Changing the code signs everyone out.
- **Workspaces.** Each one is a shared folder with its own link (`/w/<id>`). You can rename it, set it to expire after 1, 7, 30 or 90 days or never, and delete it.
- **Up to 100 MB per file.** Uploads go up in 8 MiB chunks, so they fit under Cloudflare's 100 MB request cap. A dropped connection retries and resumes where it stopped.
- **Download** files one at a time, or **all at once as a .zip**. The zip is streamed straight from disk, with no temp copy.
- Optional "uploading as" name per friend, drag-and-drop anywhere on the page, light and dark mode.

Stack: Bun, `bun:sqlite`, and vanilla JS. No runtime dependencies and no build step. This is the same shape as the kizo appliance on jj.2dee.org.

## Run locally

```bash
bun install
TRANSFER_ACCESS_CODE=letmein-dev bun run dev     # http://127.0.0.1:4180
bun test                                          # unit + API tests
bun run e2e                                       # real server, 100 MiB round-trip, SHA-256 checked
```

## Configuration (env)

| Variable | Default | |
|---|---|---|
| `TRANSFER_ACCESS_CODE` | — (required, ≥ 6 chars) | The code friends type. |
| `TRANSFER_PUBLIC_ORIGIN` | `http://host:port` | `https://…` turns on `Secure` cookies. |
| `TRANSFER_HOST` / `TRANSFER_PORT` | `127.0.0.1` / `4180` | Keep it on loopback and expose it through cloudflared. |
| `TRANSFER_DATA_DIR` | `./var` | Holds the SQLite DB, `files/`, `uploads/` (partial uploads) and `session.secret`. |
| `TRANSFER_MAX_FILE_BYTES` | 104857600 (100 MiB) | Per-file cap. The server enforces it, not only the UI. |
| `TRANSFER_MAX_TOTAL_BYTES` | 50 GiB | Total storage cap. Uploads are refused once it is reached. |
| `TRANSFER_CHUNK_BYTES` | 8 MiB | Keep this well under 100 MB because of Cloudflare's cap. |
| `TRANSFER_SESSION_SECRET` | generated into the data dir | |
| `TRANSFER_SESSION_TTL` | 30 days | |

## Deploy to transfer.2dee.org

Do this on the Ubuntu host that already runs Bun and cloudflared for jj.2dee.org.

```bash
# 1. Install the app and service. It generates an access code and prints it once.
git clone https://github.com/jdubray/2dee-transfer.git /tmp/2dee-transfer && cd /tmp/2dee-transfer
sudo bash deploy/install.sh
#   or, to have it track GitHub and auto-deploy on push:
#   sudo TRANSFER_REPO=https://github.com/jdubray/2dee-transfer.git bash deploy/install.sh

#   With a git@ URL, the first run prints a deploy key. Add it to the repo as a
#   read-only deploy key, then run the script again.

# 2. Give it its own Cloudflare tunnel. This is the same pattern as jj.2dee.org.
#    The first two commands run as your own user. Use --config /dev/null: without it,
#    a `tunnel:` line in ~/.cloudflared/config.yml silently wins.
cloudflared tunnel create 2dee-transfer                       # prints <UUID>
cloudflared --config /dev/null tunnel route dns --overwrite-dns <UUID> transfer.2dee.org
sudo bash deploy/setup-tunnel.sh <UUID> ~/.cloudflared/<UUID>.json
#    Alternative: add deploy/cloudflared/ingress-snippet.yml to an existing tunnel.

# 3. Check it.
curl -fsS https://transfer.2dee.org/api/health     # {"ok":true}
```

**Live check after the first deploy.** Local tests can't see Cloudflare, so do this once in a browser:

1. Upload a file of about 100 MB through https://transfer.2dee.org.
2. Download it again. In DevTools → Network, the response should not show `cf-cache-status: HIT`.
3. Check the console for CSP errors. If Rocket Loader or any other script-injecting Cloudflare feature is on for the zone, turn it off for this hostname, because the CSP (`script-src 'self'`) blocks it.

Files on the host:

- app: `/opt/2dee-transfer`
- data: `/var/lib/2dee-transfer`
- env: `/etc/2dee-transfer.env`
- unit: `2dee-transfer.service`
- logs: `journalctl -u 2dee-transfer -f`

To change the access code, edit `/etc/2dee-transfer.env` and run `sudo systemctl restart 2dee-transfer`.

### Why it's built this way

- **Cloudflare body cap.** The Free and Pro plans reject request bodies over 100 MB, so a single 100 MB upload would fail. Chunking avoids this. Each chunk carries an `Upload-Offset` header, and the server rejects a mismatched offset with `409`, so a retry can never duplicate or skip bytes.
- **Cloudflare cache.** Cloudflare caches responses by file extension. Download URLs therefore have no extension (`/api/files/<id>/download`), the real filename goes only in `Content-Disposition`, and every API response is `Cache-Control: private, no-store`.
- **Files on disk.** Files are stored under random IDs, never under user-supplied names. Names are cleaned only for display and zip entries.
- **Login.** Attempts are limited to 10 per 15 minutes per IP, using `CF-Connecting-IP`. The code is compared in constant time.
- **Session cookie.** It is HttpOnly and SameSite=Lax. Writes also get a same-origin check.
- **Cleanup.** A sweep every 10 minutes deletes expired workspaces and abandoned partial uploads (idle for more than 24 h).
