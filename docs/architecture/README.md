# 2dee transfer architecture

Lets a small group of key holders keep files in shared workspaces and hand single files to anyone through a guest link.

Analysed at [`85b3974`](https://github.com/jdubray/2dee-transfer/tree/85b3974072f986ec7436d12d8a41e797f74ab349).

**Read from.** src/, public/, deploy/, tests/app.test.ts (code); glm (192.168.12.125) systemd units and journal (external); this Claude Code session (conversation).

> Generated from the analysis by archlens. Edit the analysis, never this file.

## What this architecture answers

### What the parts are and where they run

**What are the parts of 2dee transfer, and which side of which boundary is each on?**

This is the map to keep in your head before changing anything. The system is small (about 1,000 lines of server code) but it straddles three places with very different trust: visitors' browsers, Cloudflare's edge, and a home server that must never be reachable directly. Knowing which box a piece of logic belongs in is most of the design work for any new feature.

Two browser pages talk HTTPS to Cloudflare, which relays through an outbound tunnel to a single Bun process on the Ubuntu host. Inside that process one router sends every request through the access-key gate (or the narrow guest-link door) to the upload engine, guest links or the zip streamer, which share SQLite for metadata and a folder of randomly-named files for bytes.

[Open the diagram](overview.architecture.html). 9 components.

| Component | Responsibility |
|---|---|
| **Workspace app** | Lets a key holder sign in, manage workspaces, upload in resumable chunks and create guest links. |
| **Guest download page** | Offers one shared file for download to a visitor who has no key. |
| **Cloudflare edge** | Terminates TLS for transfer.2dee.org and relays requests into the tunnel, rejecting any request body over 100 MB. |
| **cloudflared tunnel** | Holds an outbound connection to Cloudflare and forwards transfer.2dee.org traffic to 127.0.0.1:4180. |
| **HTTP server + router** | Routes every request to its handler behind one common set of security checks. |
| **Access keys** | Decides who a request comes from, using a typed key or a signed session cookie. |
| **Chunked uploads** | Turns a stream of offset-checked chunks into one stored file, reserving quota up front. |
| **Guest links** | Resolves a guest token to exactly one live file and streams it, counting downloads. |
| **SQLite** | Holds workspaces, file metadata, upload progress and guest links as the system of record. |

**Deliberately not shown.** The Zip streamer and the file store (shown in the 'Download all' and upload questions), the expiry sweeper, and deployment (auto-deploy, admin scripts, env file), which have their own questions; proposed features.

#### The long read

Start on the left with the two browser pages. The Workspace app is what key holders use: sign in, create workspaces, upload, share. The Guest download page is what anyone with a guest link sees: one file and a Download button. Both are plain HTML and JavaScript served by the same server; there is no build step, so what is in public/ is exactly what ships. Because they run on visitors' devices, nothing they send is trusted.

Everything they send goes to Cloudflare's edge first. Cloudflare holds the certificate for transfer.2dee.org and, importantly, refuses any request body over 100 MB. That single limit shapes the upload design you will see in the next question.

Cloudflare relays requests down an outbound tunnel run by cloudflared on the Ubuntu host. The host has no open ports for this app; the tunnel dials out to Cloudflare, so the app is reachable from the internet without the box being exposed.

The tunnel forwards to the HTTP server + router on 127.0.0.1:4180. This is one Bun process and one function, route() in src/app.ts. It first serves the public pieces (pages, static files, health, and the three guest-link routes), then asks Access keys who the caller is. Anything else under /api without a valid session gets a 401. That gate is the single most important line in the codebase.

Behind the gate sit the handlers. Chunked uploads turns many small requests into one stored file. Guest links turns a token into exactly one file. A third handler, the Zip streamer, packs a whole workspace into one download straight from disk (it has its own question). The handlers, and the router itself for workspace CRUD, keep metadata in SQLite; the bytes themselves live in a folder of files beside it (left off this picture to keep it readable). Files on disk are named by random IDs, never by what the user typed.

Two things to notice before adding code. First, the process keeps some state in memory, so you can never run two copies side by side. Second, nothing outside the process touches the database; if a new feature needs data, it gets it through a route.

#### Terms used here

- **access key**: A secret like abcd-efgh-jkmn given to one named person. Typing it signs you in; everyone with a key can open every workspace and upload.
- **workspace**: A named shared folder of files with its own link (/w/<id>) and an expiry date. Only key holders can open one.
- **guest link**: A public URL (/d/<token>) that lets anyone download one specific file without a key. It can be disabled at any time and dies with the file or its workspace.
- **chunk**: An 8 MiB slice of a file sent in its own request, with an Upload-Offset header saying which byte it starts at, so uploads stay under Cloudflare's limit and can resume after a dropped connection.
- **session cookie**: An HttpOnly cookie the server sets after a correct key, signed so it cannot be forged. It names the key holder and expires after 30 days.
- **Cloudflare tunnel**: A program on the host that dials out to Cloudflare and receives the site's traffic through that connection, so the home server needs no open inbound port.
- **quota reservation**: Recording an upload's full size in the database the moment it starts, so the storage limit counts it before any bytes arrive and two uploads cannot both claim the last free space.
- **CRC-32**: A checksum of a file's bytes, computed chunk by chunk during upload and stored, so 'Download all' can write a valid zip without reading every file twice.
- **sweeper**: A routine that runs every 10 minutes (and at startup) to delete expired workspaces and abandoned partial uploads, removing both database rows and bytes.
- **auto-deploy**: A systemd timer on the host that checks GitHub every minute and, if main changed, updates the code and restarts the service. Merging a pull request is how you deploy.

### What happens when someone uploads a 100 MB file

**How does a 100 MB file get from a browser to disk without hitting Cloudflare's limit or corrupting on a flaky connection?**

Uploading is the feature most likely to break in production in ways local testing cannot see. Cloudflare rejects bodies over 100 MB, and home internet connections drop. The upload protocol exists to make both of those harmless; anyone touching upload code needs to know which part guarantees what.

The browser never sends the file in one request. It asks the server for an upload id, then sends 8 MiB chunks, each stamped with the byte offset it starts at; the server writes each chunk at that offset and records progress, and on the last byte renames the temp file into place and records the file in one transaction.

[Open the diagram](upload.sequence.html). 4 participants.

| Component | Responsibility |
|---|---|
| **HTTP server + router** | Routes every request to its handler behind one common set of security checks. |
| **Chunked uploads** | Turns a stream of offset-checked chunks into one stored file, reserving quota up front. |
| **SQLite** | Holds workspaces, file metadata, upload progress and guest links as the system of record. |
| **File bytes on disk** | Keeps each file's bytes under a random ID, with partial uploads in a separate folder. |

**Deliberately not shown.** The browser, Cloudflare and the tunnel, which carry every step's request the same way (see the overview); browser-side retries with backoff; the cancel path.

In order:

*Start*

1. **HTTP server + router → Chunked uploads**: createUpload(name, size, who). Arrives as POST /api/workspaces/:id/uploads from the browser, via Cloudflare and the tunnel; 'who' is the signed-in key holder, never a name the browser claims.
2. **Chunked uploads → SQLite**: check quota, insert upload row. Inserted synchronously, before any await, so two simultaneous uploads cannot both pass the quota check.
3. **Chunked uploads → File bytes on disk**: create empty uploads/<id>. Chunk bytes written at their offset into uploads/<id>; on the last byte, a rename into files/<id>.
4. **Chunked uploads ⇢ HTTP server + router**: 201 {uploadId, chunkBytes}

*Each 8 MiB chunk*

5. **HTTP server + router → Chunked uploads**: appendChunk(offset n, ≤8 MiB). A PATCH with an Upload-Offset header. 409 with the server's offset if n is not what it expects; the browser resumes from there.
6. **Chunked uploads → File bytes on disk**: write bytes at offset n. Chunk bytes written at their offset into uploads/<id>; on the last byte, a rename into files/<id>.
7. **Chunked uploads → SQLite**: received += len, update CRC. An upload row inserted before any await (the quota reservation), then received bytes and running CRC per chunk, then the file row in one transaction.
8. **Chunked uploads ⇢ HTTP server + router**: 200 {offset}

*Finish*

9. **HTTP server + router → Chunked uploads**: appendChunk(last chunk). File name, size and the signed-in person's display name; then chunk bytes with their offset.
10. **Chunked uploads → File bytes on disk**: rename to files/<fileId>. Chunk bytes written at their offset into uploads/<id>; on the last byte, a rename into files/<id>.
11. **Chunked uploads → SQLite**: insert file, mark upload done. One transaction, which first re-checks that the upload still exists, so a workspace deleted mid-rename cannot leave an orphan row.
12. **Chunked uploads ⇢ HTTP server + router**: 200 {complete, file}

#### The long read

Read the diagram top to bottom; the three brackets are the three phases of every upload. Every arrow that starts at the HTTP server is a request that came from the Workspace app through Cloudflare and the tunnel, exactly as in the overview; the diagram leaves those hops out so the protocol itself stays readable.

Start. The Workspace app posts the file's name and size. The request passes Cloudflare and the tunnel and reaches the router, which hands it to Chunked uploads along with who is signed in (that is where 'from Edouard' comes from; the browser cannot claim to be someone else). Chunked uploads checks the size limit and the total storage quota, and inserts the upload row immediately. That row is the quota reservation: it is written before the code waits on anything, so two uploads started at the same instant cannot both squeeze into the last free gigabyte. It then creates an empty temp file and returns an upload id and the chunk size.

Each chunk. The browser slices the next 8 MiB and sends it with an Upload-Offset header saying where those bytes belong. 8 MiB is far below Cloudflare's 100 MB cap, which is the whole reason for chunking. Chunked uploads compares the offset with how many bytes it has already received. If they differ (say the browser retried a chunk whose reply was lost), it answers 409 with the right offset and the browser simply continues from there. If they match, it writes the bytes at exactly that position in the temp file and records the new total and a running CRC-32, which the zip streamer uses later.

Finish. When the last chunk lands, Chunked uploads renames the temp file into the files folder under a fresh random id and, in one database transaction, creates the file row and marks the upload complete. The upload row is kept (marked complete) so that if the browser never saw this final reply, asking again returns the stored file instead of failing or uploading a duplicate.

To extend uploads, for example to trigger a preview or a notification, hook in after that final transaction commits, never before.

#### Terms used here

- **access key**: A secret like abcd-efgh-jkmn given to one named person. Typing it signs you in; everyone with a key can open every workspace and upload.
- **workspace**: A named shared folder of files with its own link (/w/<id>) and an expiry date. Only key holders can open one.
- **guest link**: A public URL (/d/<token>) that lets anyone download one specific file without a key. It can be disabled at any time and dies with the file or its workspace.
- **chunk**: An 8 MiB slice of a file sent in its own request, with an Upload-Offset header saying which byte it starts at, so uploads stay under Cloudflare's limit and can resume after a dropped connection.
- **quota reservation**: Recording an upload's full size in the database the moment it starts, so the storage limit counts it before any bytes arrive and two uploads cannot both claim the last free space.
- **CRC-32**: A checksum of a file's bytes, computed chunk by chunk during upload and stored, so 'Download all' can write a valid zip without reading every file twice.
- **after commit**: Doing a side effect (an email, a preview) only once the database transaction that made something true has finished, so the side effect can never undo or slow the main action.

### How a guest link opens one file and nothing else

**When someone without a key opens a guest link, what can they reach, and what stops them reaching more?**

Guest links are the one deliberate hole in the access-key wall, so they deserve the closest reading. The design question is how to let anyone download a file without letting them list, browse or upload, and how to make that hole easy to close again.

A key holder's click creates a random 26-character token tied to one file id. The guest page and its download go through three public routes that only accept such a token; the router answers them before the access-key gate, and every other API route still demands a session, so the token can name one file and nothing else.

[Open the diagram](guest.architecture.html). 5 components.

| Component | Responsibility |
|---|---|
| **HTTP server + router** | Routes every request to its handler behind one common set of security checks. |
| **Access keys** | Decides who a request comes from, using a typed key or a signed session cookie. |
| **Guest links** | Resolves a guest token to exactly one live file and streams it, counting downloads. |
| **SQLite** | Holds workspaces, file metadata, upload progress and guest links as the system of record. |
| **File bytes on disk** | Keeps each file's bytes under a random ID, with partial uploads in a separate folder. |

**Deliberately not shown.** The browsers, Cloudflare and the tunnel, which carry a guest's request exactly as in the overview; the Workspace app, where a key holder creates the link with a normal signed-in request.

#### The long read

The diagram shows the server side; every request in it arrived from a browser through Cloudflare and the tunnel, as in the overview. Begin with the Workspace app, off the left edge of the picture. A key holder clicks the link icon next to a file. That request carries their session cookie, so it passes the access-key gate like any other, and Guest links creates (or returns the existing) token for that file id and records who shared it.

Now follow the Guest download page. The visitor has no cookie. Their browser loads /d/<token>, a static page, which asks /api/guest/<token> for the file's name, size, sender and expiry date, and offers /d/<token>/download. The router answers these three paths before it ever asks Access keys who the caller is, which is why no key is needed. Nothing else is answered before the gate; that ordering inside route() is the whole security boundary, and the tests check it.

Guest links looks the token up in SQLite, loads that one file row, and checks its workspace has not expired. Any failure (unknown token, deleted file, expired workspace) gives the same 'no longer available' answer, so a visitor cannot probe which part failed. The download streams the bytes from the file store as opaque application/octet-stream and bumps a counter that the sharer sees.

Two more properties fall out. Tokens are about 130 bits of randomness, so guessing one is not practical. And because the URLs have no file extension and every response is marked no-store, Cloudflare never caches a shared file at its edge, so disabling a link really stops it.

If you add a feature to guest links (an expiry date, a password, a download limit), it belongs in guestFile(), the single function every guest route goes through.

#### Terms used here

- **access key**: A secret like abcd-efgh-jkmn given to one named person. Typing it signs you in; everyone with a key can open every workspace and upload.
- **workspace**: A named shared folder of files with its own link (/w/<id>) and an expiry date. Only key holders can open one.
- **guest link**: A public URL (/d/<token>) that lets anyone download one specific file without a key. It can be disabled at any time and dies with the file or its workspace.
- **session cookie**: An HttpOnly cookie the server sets after a correct key, signed so it cannot be forged. It names the key holder and expires after 30 days.

### How 'Download all' streams a workspace

**How can 'Download all' zip a whole workspace without a temp file or reading every file twice?**

A zip archive needs every file's checksum and size in its headers. Computing those at download time would mean reading each file twice or buffering the archive on disk; this design moves the work to upload time instead.

The router reads the workspace's file list from SQLite, including each file's size and the CRC-32 computed during upload, and hands it to the Zip streamer, which writes zip headers and streams each file's bytes straight from the file store. Nothing is written to disk and no file is read twice.

[Open the diagram](download-all.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **HTTP server + router** | Routes every request to its handler behind one common set of security checks. |
| **Zip streamer** | Streams a whole workspace as an uncompressed zip straight from disk using CRCs recorded at upload time. |
| **SQLite** | Holds workspaces, file metadata, upload progress and guest links as the system of record. |
| **File bytes on disk** | Keeps each file's bytes under a random ID, with partial uploads in a separate folder. |

**Deliberately not shown.** Compression: the zip is store-only, since most shared files (photos, video, PDFs) are already compressed.

#### The long read

When a key holder clicks Download all, the HTTP server + router loads the workspace's files from SQLite. Each row already carries the file's size and its CRC-32, which Chunked uploads computed chunk by chunk as the bytes arrived.

The router passes that list to the Zip streamer (src/zip.ts). Because every size and checksum is known up front, the streamer can write each local file header, then pipe that file's bytes straight from the file store, then move to the next, and finish with the central directory. It never writes a temporary archive and never reads a file twice, so a 2 GB workspace costs no extra disk and starts downloading immediately.

Two limits follow from keeping it simple: entries are stored uncompressed, and the format is plain zip, not ZIP64, so one archive must stay under 4 GB and 65,535 files. The router refuses larger ones and suggests downloading files individually. Duplicate names inside a workspace are renamed 'name (2).ext' in the archive.

#### Terms used here

- **access key**: A secret like abcd-efgh-jkmn given to one named person. Typing it signs you in; everyone with a key can open every workspace and upload.
- **workspace**: A named shared folder of files with its own link (/w/<id>) and an expiry date. Only key holders can open one.
- **guest link**: A public URL (/d/<token>) that lets anyone download one specific file without a key. It can be disabled at any time and dies with the file or its workspace.
- **chunk**: An 8 MiB slice of a file sent in its own request, with an Upload-Offset header saying which byte it starts at, so uploads stay under Cloudflare's limit and can resume after a dropped connection.
- **CRC-32**: A checksum of a file's bytes, computed chunk by chunk during upload and stored, so 'Download all' can write a valid zip without reading every file twice.

### How a code change reaches production

**What happens between merging a pull request and the change being live?**

The server is a box at home and the repository is public, so the deploy path has to work without opening the box to inbound connections or putting secrets in git. Anyone shipping a feature needs to know that a merge goes live by itself.

Merging to main is deploying. Within a minute the host's timer fetches origin/main, resets the checkout to it and restarts the service; on startup the server re-reads the env file and applies any additive schema changes. Nothing pushes into the host.

[Open the diagram](deploy.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **GitHub repo** | Holds the code; a merge to main is the only way to change what runs. |
| **Auto-deploy timer** | Fast-forwards the checkout to origin/main and restarts the service when main moves. |
| **HTTP server + router** | Routes every request to its handler behind one common set of security checks. |
| **Env file** | Holds the runtime settings, including the only copy of the access keys. |

**Deliberately not shown.** Visitor traffic and the tunnel, which a deploy leaves running.

#### The long read

GitHub holds jdubray/2dee-transfer. On the host, a systemd timer runs the Auto-deploy timer script every 60 seconds. It fetches origin/main over public HTTPS (the host pulls; nothing outside can push into it), and if main has moved it resets the checkout to it and restarts the HTTP server.

There is no build step and no dependency install, so a restart is the whole deploy, and it takes a second or two; the Cloudflare tunnel stays up across it.

On startup the server reads its settings from the Env file and opens SQLite, applying any schema change with CREATE TABLE IF NOT EXISTS or a guarded ALTER TABLE. A feature that adds a table or a column therefore needs no manual migration step, but it must be additive: never rename or drop in place.

A pull request merged at 10:00 is live at 10:01. To roll back, revert the merge on main and the same timer undoes it.

#### Terms used here

- **access key**: A secret like abcd-efgh-jkmn given to one named person. Typing it signs you in; everyone with a key can open every workspace and upload.
- **Cloudflare tunnel**: A program on the host that dials out to Cloudflare and receives the site's traffic through that connection, so the home server needs no open inbound port.
- **auto-deploy**: A systemd timer on the host that checks GitHub every minute and, if main changed, updates the code and restarts the service. Merging a pull request is how you deploy.

### How access keys are created and checked

**Where do access keys live, how are they issued, and how does the server use them?**

The repository is public, so keys can never be in git, and the people using the site are not developers, so issuing and revoking keys must be one command. This view shows where the secret lives at each step.

An admin runs add-keys.sh over SSH; it generates a key per name, writes TRANSFER_ACCESS_KEYS into the root-only env file, prints the keys once and restarts the server. The server hands those keys to Access keys, which matches a typed key to a person and signs a session cookie with that person's key, so each key can be rotated alone.

[Open the diagram](keys.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **Admin scripts** | Performs the privileged one-off operations: install, tunnel setup, key rotation. |
| **Env file** | Holds the runtime settings, including the only copy of the access keys. |
| **HTTP server + router** | Routes every request to its handler behind one common set of security checks. |
| **Access keys** | Decides who a request comes from, using a typed key or a signed session cookie. |

**Deliberately not shown.** Visitors' browsers, which only ever see their own key and a signed cookie.

#### The long read

Start with the Admin scripts. From a terminal on the LAN, an admin runs add-keys.sh with sudo and a list of names. It generates a key like abcd-efgh-jkmn for each, keeps the keys of anyone not named, removes the old shared code, and writes the result as TRANSFER_ACCESS_KEYS into the Env file, which only root and the service can read. It prints the new keys once and restarts the server.

On startup the HTTP server reads the env file and gives the list to Access keys. When someone signs in, Access keys compares the typed key against every stored key (in constant time, so timing reveals nothing) and, on a match, signs a session cookie with a secret derived from that person's own key. That is why rotating Edouard's key signs out Edouard and nobody else.

Every later request carries the cookie; the router asks Access keys who it belongs to, and the answer (a name like Jean-Pierre) is what labels uploads and guest links.

A key opens everything. For a secret your feature needs, such as an email provider's API key, follow the same pattern: an env variable read in src/config.ts, set on the host, documented in deploy/2dee-transfer.env.example, never committed.

#### Terms used here

- **access key**: A secret like abcd-efgh-jkmn given to one named person. Typing it signs you in; everyone with a key can open every workspace and upload.
- **guest link**: A public URL (/d/<token>) that lets anyone download one specific file without a key. It can be disabled at any time and dies with the file or its workspace.
- **session cookie**: An HttpOnly cookie the server sets after a correct key, signed so it cannot be forged. It names the key holder and expires after 30 days.

### What deletes data, and when

**When do files disappear, and what removes them?**

This system deletes data on its own, which is unusual and worth understanding before relying on it or changing it. Expiry keeps a home server's disk bounded without anyone doing chores, at the price of no undo.

The Expiry sweeper, inside the server process, runs at startup, every ten minutes and whenever the workspace list is opened. It deletes workspaces past their expiry date (files, guest links and bytes together) and partial uploads idle for a day.

[Open the diagram](expiry.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **HTTP server + router** | Routes every request to its handler behind one common set of security checks. |
| **Expiry sweeper** | Removes everything that has expired, database rows together with their bytes. |
| **SQLite** | Holds workspaces, file metadata, upload progress and guest links as the system of record. |
| **File bytes on disk** | Keeps each file's bytes under a random ID, with partial uploads in a separate folder. |

**Deliberately not shown.** Deletes a key holder makes by hand (a file or a workspace), which run the same removal immediately from the router.

#### The long read

The HTTP server starts the Expiry sweeper three ways: once at startup, on a ten-minute timer, and each time someone opens the workspace list, so an expired workspace never shows up there even between ticks. Workspace and download routes also check expiry themselves when they load a workspace, so an expired workspace is gone from the moment its date passes, not when the sweeper next runs.

The sweeper asks SQLite for workspaces whose expiry time has passed and deletes them. The database deletes cascade: the workspace's files, partial uploads and guest links go with it, which is why a guest link dies with its workspace. It then unlinks the matching bytes from the file store. It does the same for partial uploads nobody has touched for 24 hours, which is what reclaims space when someone closes the tab halfway through.

When the server starts it also removes any file on disk the database does not know about, the leftovers of a crash between writing bytes and committing a row.

New workspaces default to 30 days; Never is an option. If you add a feature that stores something per workspace, give its table a foreign key with ON DELETE CASCADE so expiry cleans it up for free.

#### Terms used here

- **access key**: A secret like abcd-efgh-jkmn given to one named person. Typing it signs you in; everyone with a key can open every workspace and upload.
- **workspace**: A named shared folder of files with its own link (/w/<id>) and an expiry date. Only key holders can open one.
- **guest link**: A public URL (/d/<token>) that lets anyone download one specific file without a key. It can be disabled at any time and dies with the file or its workspace.
- **sweeper**: A routine that runs every 10 minutes (and at startup) to delete expired workspaces and abandoned partial uploads, removing both database rows and bytes.

### Where notifications and previews would plug in

**If we add notifications and previews, where do they hook in so uploads and downloads stay fast?**

This is a design proposal, not a description of code: every box marked planned comes from this conversation. Uploads finish in exactly one place and guest downloads resolve in exactly one place, and those two seams are where side effects like email and previews should attach without putting the core guarantees at risk.

Proposal: emit an event after the upload transaction and after a guest download commit; a notifier turns those into emails through a provider, and a preview worker renders thumbnails into the file store. Neither is ever on the request path.

[Open the diagram](extend-events.architecture.html). 5 components.

| Component | Responsibility |
|---|---|
| **Guest links** | Resolves a guest token to exactly one live file and streams it, counting downloads. |
| **Chunked uploads** | Turns a stream of offset-checked chunks into one stored file, reserving quota up front. |
| **Notifier** *(planned)* | Would tell workspace members about new uploads and tell a sender when a guest downloads their file. |
| **Preview worker** *(planned)* | Would render thumbnails for images and PDFs after an upload completes, off the request path. |
| **Email provider** *(planned)* | Would deliver notification emails on the notifier's behalf. |

**Deliberately not shown.** SQLite and the file store (each event fires after a commit there; the preview worker writes its thumbnail into the file store), the router and browsers, and per-workspace access, which has its own question.

#### The long read

Two moments are worth telling people about: a new file landing in a workspace, and a guest downloading a shared file. Both already have a single point where they become true. Chunked uploads commits the file row in one transaction; Guest links bumps the download counter. The rule is to emit an event after the commit and never inside it, so a slow email provider can never fail or delay an upload.

The Notifier receives those events. In a one-process app it can start as an in-memory queue drained by a timer, exactly like the Expiry sweeper that already runs every ten minutes from the same process. It sends through an Email provider whose credentials live in the env file, following the same secrets pattern as the access keys: set on the host, never committed. Who gets told is the only new data: a notification preference per key holder (a small table added in openDb()).

The Preview worker follows the same trigger: after an upload commits, render a small image for images and PDFs, write it to the file store beside the original, and record it in SQLite so the workspace page can show it. Keep it out of the request path; a 100 MB PDF must not slow the final chunk's reply.

What both must respect: one process (in-memory state means no second instance), additive schema changes in openDb(), and a test in tests/app.test.ts proving the event fires only after the commit. An audit log is the same shape: another after-commit event, written to its own table.

#### Terms used here

- **access key**: A secret like abcd-efgh-jkmn given to one named person. Typing it signs you in; everyone with a key can open every workspace and upload.
- **workspace**: A named shared folder of files with its own link (/w/<id>) and an expiry date. Only key holders can open one.
- **guest link**: A public URL (/d/<token>) that lets anyone download one specific file without a key. It can be disabled at any time and dies with the file or its workspace.
- **chunk**: An 8 MiB slice of a file sent in its own request, with an Upload-Offset header saying which byte it starts at, so uploads stay under Cloudflare's limit and can resume after a dropped connection.
- **sweeper**: A routine that runs every 10 minutes (and at startup) to delete expired workspaces and abandoned partial uploads, removing both database rows and bytes.
- **after commit**: Doing a side effect (an email, a preview) only once the database transaction that made something true has finished, so the side effect can never undo or slow the main action.

### How per-workspace access would work

**How would we stop every key holder seeing every workspace, and what would change?**

Today every key holder can see, download and delete every workspace, which is fine for one circle of friends and wrong as soon as coworkers and friends share the server. This view is a proposal from this conversation, not code, showing the smallest change that closes that gap.

Proposal: a members table (workspace, key name, role) checked in the router right after the existing 401 gate. Workspace routes already funnel through one lookup, so the change is one check plus a members section in Workspace settings; guest links are unaffected because they never open a workspace.

[Open the diagram](extend-access.architecture.html). 5 components.

| Component | Responsibility |
|---|---|
| **HTTP server + router** | Routes every request to its handler behind one common set of security checks. |
| **Access keys** | Decides who a request comes from, using a typed key or a signed session cookie. |
| **Workspace members** *(planned)* | Would record which key holders may see each workspace, replacing today's everyone-sees-everything rule. |
| **SQLite** | Holds workspaces, file metadata, upload progress and guest links as the system of record. |
| **Guest links** | Resolves a guest token to exactly one live file and streams it, counting downloads. |

**Deliberately not shown.** Browsers, edge and storage of file bytes, none of which change.

#### The long read

Start at the HTTP server + router. Today it asks Access keys who the caller is and, if anyone at all, lets them through to every workspace. The proposal adds one more question right after that: is this key holder a member of this workspace? The answer comes from a new Workspace members table in SQLite, created additively in openDb() like every other table.

Every workspace route already loads the workspace through one function, liveWorkspace(), so the check goes there. A non-member gets the same 404 as a missing workspace, so names of other people's workspaces never leak. The workspace list filters to the caller's memberships. Whoever creates a workspace becomes its owner and can add other key holders from Workspace settings.

Guest links need no change. A guest token already resolves to one file without ever opening its workspace, so outside recipients keep working exactly as they do today. That is the reason to keep coworkers as guests where possible: they get files without needing a key at all.

Migration is the one subtle part. Existing workspaces have no members, so the first deploy should make every current key holder a member of every existing workspace, which preserves today's behaviour until owners prune it.

#### Terms used here

- **access key**: A secret like abcd-efgh-jkmn given to one named person. Typing it signs you in; everyone with a key can open every workspace and upload.
- **workspace**: A named shared folder of files with its own link (/w/<id>) and an expiry date. Only key holders can open one.
- **guest link**: A public URL (/d/<token>) that lets anyone download one specific file without a key. It can be disabled at any time and dies with the file or its workspace.
- **session cookie**: An HttpOnly cookie the server sets after a correct key, signed so it cannot be forged. It names the key holder and expires after 30 days.
- **401 gate**: The line in route() that refuses any /api request without a valid session. Only the health check, login, static files and the three guest-link routes are answered before it.

## Boundaries

A boundary is a claim about everything inside it.

### Visitors' browsers

*trust boundary.* Runs on devices we do not control; anything sent from here can be forged, so the server re-checks every rule

Contains: Workspace app, Guest download page.

Crossed by:

- **Workspace app → Cloudflare edge** over https. The session cookie, JSON requests, and raw upload chunks with an Upload-Offset header. Never a whole file in one request.
- **Guest download page → Cloudflare edge** over https. Only the 26-character token in the URL path. No cookie is needed and none is checked.

### One Bun process

*process boundary.* Shares in-memory state (in-flight upload set, login rate limiter), so exactly one instance may run

Contains: HTTP server + router, Access keys, Chunked uploads, Guest links, Zip streamer, Expiry sweeper.

### Ubuntu host glm

*deployment boundary.* Nothing here listens on a public interface; the only way in is the outbound Cloudflare tunnel or SSH on the LAN

Contains: cloudflared tunnel, HTTP server + router, Access keys, Chunked uploads, Guest links, Zip streamer, Expiry sweeper, SQLite, File bytes on disk, Env file, Auto-deploy timer, Admin scripts.

Crossed by:

- **Cloudflare edge → cloudflared tunnel** over https. The decrypted request plus CF-Connecting-IP. Bodies over 100 MB never get this far.
- **Auto-deploy timer → GitHub repo** over https. A git fetch over public HTTPS. Nothing is pushed into the host from outside.
- **Notifier → Email provider** over https. Proposed: recipient, subject and a link back to the workspace. Never a guest token or file bytes.

## Components

**Workspace app**: Lets a key holder sign in, manage workspaces, upload in resumable chunks and create guest links.

- Source: `public/static/app.js:180`, `public/static/app.js:689`, `public/static/app.js:601`, `public/index.html`

**Guest download page**: Offers one shared file for download to a visitor who has no key.

- Source: `public/static/guest.js:53`, `public/download.html`

**Cloudflare edge**: Terminates TLS for transfer.2dee.org and relays requests into the tunnel, rejecting any request body over 100 MB.

**cloudflared tunnel**: Holds an outbound connection to Cloudflare and forwards transfer.2dee.org traffic to 127.0.0.1:4180.

- Source: `deploy/cloudflared/config.yml.example`, `deploy/systemd/cloudflared-transfer.service`, `deploy/setup-tunnel.sh`

**HTTP server + router**: Routes every request to its handler behind one common set of security checks.

- Source: `src/main.ts:17`, `src/app.ts:377`, `src/app.ts:25`

**Access keys**: Decides who a request comes from, using a typed key or a signed session cookie.

- Source: `src/auth.ts:28`, `src/config.ts:49`, `src/app.ts:425`

**Chunked uploads**: Turns a stream of offset-checked chunks into one stored file, reserving quota up front.

- Source: `src/app.ts:248`, `src/app.ts:288`, `src/app.ts:227`, `src/crc32.ts`

**Guest links**: Resolves a guest token to exactly one live file and streams it, counting downloads.

- Source: `src/app.ts:183`, `src/app.ts:391`

**Zip streamer**: Streams a whole workspace as an uncompressed zip straight from disk using CRCs recorded at upload time.

- Source: `src/zip.ts:105`, `src/app.ts:352`

**Expiry sweeper**: Removes everything that has expired, database rows together with their bytes.

- Source: `src/app.ts:139`, `src/main.ts:35`

**SQLite**: Holds workspaces, file metadata, upload progress and guest links as the system of record.

- Source: `src/db.ts:45`

**File bytes on disk**: Keeps each file's bytes under a random ID, with partial uploads in a separate folder.

- Source: `src/app.ts:64`

**Env file**: Holds the runtime settings, including the only copy of the access keys.

- Source: `deploy/2dee-transfer.env.example`, `src/config.ts:76`

**Auto-deploy timer**: Fast-forwards the checkout to origin/main and restarts the service when main moves.

- Source: `deploy/auto-deploy.sh`, `deploy/systemd/2dee-transfer-autodeploy.timer`

**GitHub repo**: Holds the code; a merge to main is the only way to change what runs.

**Admin scripts**: Performs the privileged one-off operations: install, tunnel setup, key rotation.

- Source: `deploy/install.sh`, `deploy/add-keys.sh`, `deploy/setup-tunnel.sh`

**Notifier** *(planned)*: Would tell workspace members about new uploads and tell a sender when a guest downloads their file.

**Email provider** *(planned)*: Would deliver notification emails on the notifier's behalf.

**Workspace members** *(planned)*: Would record which key holders may see each workspace, replacing today's everyone-sees-everything rule.

**Preview worker** *(planned)*: Would render thumbnails for images and PDFs after an upload completes, off the request path.

## What moves between them

| From | To | Mechanism | What crosses |
|---|---|---|---|
| Workspace app | Cloudflare edge | https | The session cookie, JSON requests, and raw upload chunks with an Upload-Offset header. Never a whole file in one request. *(crosses Visitors' browsers)* |
| Guest download page | Cloudflare edge | https | Only the 26-character token in the URL path. No cookie is needed and none is checked. *(crosses Visitors' browsers)* |
| Cloudflare edge | cloudflared tunnel | https | The decrypted request plus CF-Connecting-IP. Bodies over 100 MB never get this far. *(crosses Ubuntu host glm)* |
| cloudflared tunnel | HTTP server + router | http | The request with Host forced to transfer.2dee.org, which the same-origin check relies on. |
| HTTP server + router | Access keys | in-process call | The t2_session cookie (or a typed key at login); back comes the person's key name or nothing. |
| HTTP server + router | Chunked uploads | in-process call | File name, size and the signed-in person's display name; then chunk bytes with their offset. |
| HTTP server + router | Guest links | in-process call | A token from an anonymous visitor, or a file id from a key holder who wants a link. |
| HTTP server + router | Zip streamer | in-process call | The workspace's file list with sizes and CRCs; back comes a byte stream. |
| HTTP server + router | SQLite | database | Workspace names and expiry dates, file listings, deletes. |
| HTTP server + router | Expiry sweeper | in-process call | Only the current time; the sweeper finds its own work. |
| HTTP server + router | Env file | file | Access keys, limits, data dir and public origin, read once when the process starts. |
| Chunked uploads | SQLite | database | An upload row inserted before any await (the quota reservation), then received bytes and running CRC per chunk, then the file row in one transaction. |
| Chunked uploads | File bytes on disk | file | Chunk bytes written at their offset into uploads/<id>; on the last byte, a rename into files/<id>. |
| Guest links | SQLite | database | The token lookup, the file and workspace rows (expiry is checked), and a download counter increment. |
| Guest links | File bytes on disk | file | One file's bytes, always as application/octet-stream with Content-Disposition: attachment. |
| Zip streamer | File bytes on disk | file | File bytes, read sequentially; nothing is written. |
| Expiry sweeper | SQLite | database | Expired workspace ids and stale upload ids; deletes cascade to files and guest links. |
| Expiry sweeper | File bytes on disk | file | Unlinks of the files and partial uploads whose rows were deleted. |
| Auto-deploy timer | GitHub repo | https | A git fetch over public HTTPS. Nothing is pushed into the host from outside. *(crosses Ubuntu host glm)* |
| Auto-deploy timer | HTTP server + router | signal | New code on disk, then systemctl restart. Data and the env file are untouched. |
| Admin scripts | Env file | file | Freshly generated name:key pairs, printed once in the admin's terminal and never committed. |
| Admin scripts | HTTP server + router | signal | systemd unit installation and a restart so new keys take effect. |
| Chunked uploads | Notifier | event | Proposed: a file id and uploader name, emitted after the completing transaction commits. |
| Guest links | Notifier | event | Proposed: the file id and time of a guest download, so the sharer can be told. |
| Notifier | Email provider | https | Proposed: recipient, subject and a link back to the workspace. Never a guest token or file bytes. *(crosses Ubuntu host glm)* |
| HTTP server + router | Workspace members | database | Proposed: workspace id and key name; every workspace route would check it after the 401 gate. |
| Chunked uploads | Preview worker | event | Proposed: a file id; the worker reads bytes from the file store and writes a small image beside them. |
| Preview worker | File bytes on disk | file | Proposed: reads the original's bytes and writes a small image beside it, never touching the original. |

## Doctrines, guarantees and trade-offs

### Doctrines

- **Access keys exist only in /etc/2dee-transfer.env** the repository is public; add-keys.sh generates keys on the host and prints them once
- **Production changes only by merging to main** the host polls GitHub and resets to origin/main; nothing outside can push into it, and a bad merge is undone by reverting on main
- **Schema changes are additive and run at startup** openDb uses CREATE TABLE IF NOT EXISTS plus guarded ALTER TABLE ADD COLUMN, so an auto-deployed restart migrates the live database without a separate step

### Guarantees

- **A retried or duplicated chunk can never skip or double bytes** each chunk names its offset, the server writes positionally and answers 409 with the true offset on mismatch, and a lost final reply is recovered from the completed upload row
- **A guest token opens one file and nothing else** the only unauthenticated routes are /d/<token>, /d/<token>/download and /api/guest/<token>; every other /api route hits the 401 gate, and the token resolves to a single file id
- **Cloudflare never caches a file** download URLs carry no file extension and every API response is Cache-Control: private, no-store
- **Rotating or revoking one person's key signs out only that person** each session cookie is HMAC-signed with a key derived from that person's own key

### Constraints

- **No request body may exceed 100 MB, so files travel in 8 MiB chunks** Cloudflare's free and pro plans reject larger bodies with a 413; the server caps bodies at chunk size + 1 MiB to match
- **Run exactly one server process** the in-flight upload set and the login rate limiter live in memory; two instances would each believe they own an upload
- **Only code inside the Bun process reads or writes the database** the browsers and the edge reach data only through the HTTP routes, where the auth gate and guest scope are enforced
- **Proposed: side effects (email, previews) fire after the database commit and never inside the request's critical path** an upload or guest download must not fail or slow down because an email provider is slow; this is the rule new features should follow

### Trade-offs

- **Expiry really deletes: bytes, metadata and guest links go together** keeps the disk bounded with no admin chores, at the cost of no undo; the default is 30 days

### Risks

- **Every key holder can see, download and delete every workspace** there are no per-workspace permissions; fine for a circle that trusts each other, wrong for mixing groups (see the planned members table)

