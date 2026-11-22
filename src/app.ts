import { mkdirSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import { openDb, type FileRow, type ShareLinkRow, type UploadRow, type WorkspaceRow } from "./db.ts";
import {
  COOKIE,
  RateLimiter,
  displayName,
  findAccessKey,
  makeSession,
  readCookie,
  verifySession,
  type AccessKey,
} from "./auth.ts";
import { crc32 } from "./crc32.ts";
import { cleanFileName, cleanLabel, cleanMime, contentDisposition, newId } from "./names.ts";
import { ZIP_LIMIT_BYTES, ZIP_LIMIT_ENTRIES, uniqueNames, zipLength, zipStream } from "./zip.ts";

const DAY = 24 * 3600 * 1000;
const EXPIRY_CHOICES = [1, 7, 30, 90];
const STALE_UPLOAD_MS = DAY;
const DISK_HEADROOM = 1024 * 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const data = await req.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export interface App {
  fetch(req: Request, clientIp?: string): Promise<Response>;
  sweep(now?: number): void;
  close(): void;
}

export function createApp(cfg: Config): App {
  const db = openDb(cfg.dataDir);
  const filesDir = join(cfg.dataDir, "files");
  const tmpDir = join(cfg.dataDir, "uploads");
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const publicDir = resolve(import.meta.dir, "..", "public");
  const secureCookie = cfg.publicOrigin.startsWith("https://");
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const busy = new Set<string>(); // upload IDs with a chunk in flight

  const q = {
    listWorkspaces: db.query<WorkspaceRow & { file_count: number; total_bytes: number }, []>(`
      SELECT w.*, COUNT(f.id) AS file_count, COALESCE(SUM(f.size), 0) AS total_bytes
      FROM workspaces w LEFT JOIN files f ON f.workspace_id = w.id
      GROUP BY w.id ORDER BY w.created_at DESC`),
    getWorkspace: db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?"),
    insertWorkspace: db.query("INSERT INTO workspaces (id, name, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    updateWorkspace: db.query("UPDATE workspaces SET name = ?, expires_at = ? WHERE id = ?"),
    deleteWorkspace: db.query("DELETE FROM workspaces WHERE id = ?"),
    expiredWorkspaces: db.query<{ id: string }, [number]>(
      "SELECT id FROM workspaces WHERE expires_at IS NOT NULL AND expires_at <= ?",
    ),
    filesIn: db.query<FileRow, [string]>("SELECT * FROM files WHERE workspace_id = ? ORDER BY created_at, rowid"),
    getFile: db.query<FileRow, [string]>("SELECT * FROM files WHERE id = ?"),
    insertFile: db.query(
      "INSERT INTO files (id, workspace_id, name, size, mime, crc32, uploader, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    deleteFile: db.query("DELETE FROM files WHERE id = ?"),
    allFileIds: db.query<{ id: string }, []>("SELECT id FROM files"),
    linkForFile: db.query<ShareLinkRow, [string]>("SELECT * FROM share_links WHERE file_id = ?"),
    getLink: db.query<ShareLinkRow, [string]>("SELECT * FROM share_links WHERE token = ?"),
    insertLink: db.query("INSERT INTO share_links (token, file_id, created_by, created_at) VALUES (?, ?, ?, ?)"),
    deleteLinkForFile: db.query("DELETE FROM share_links WHERE file_id = ?"),
    countDownload: db.query("UPDATE share_links SET downloads = downloads + 1 WHERE token = ?"),
    uploadsIn: db.query<{ id: string }, [string]>("SELECT id FROM uploads WHERE workspace_id = ?"),
    getUpload: db.query<UploadRow, [string]>("SELECT * FROM uploads WHERE id = ?"),
    insertUpload: db.query(
      "INSERT INTO uploads (id, workspace_id, name, size, mime, uploader, received, crc32, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)",
    ),
    advanceUpload: db.query("UPDATE uploads SET received = ?, crc32 = ?, updated_at = ? WHERE id = ?"),
    completeUpload: db.query("UPDATE uploads SET file_id = ?, received = ?, crc32 = ?, updated_at = ? WHERE id = ?"),
    deleteUpload: db.query("DELETE FROM uploads WHERE id = ?"),
    staleUploads: db.query<{ id: string }, [number]>("SELECT id FROM uploads WHERE updated_at < ?"),
    allUploadIds: db.query<{ id: string }, []>("SELECT id FROM uploads"),
    usedBytes: db.query<{ used: number }, []>(
      "SELECT (SELECT COALESCE(SUM(size), 0) FROM files) + (SELECT COALESCE(SUM(size), 0) FROM uploads WHERE file_id IS NULL) AS used",
    ),
  };

  const filePath = (id: string) => join(filesDir, id);
  const tmpPath = (id: string) => join(tmpDir, id);

  // Drop anything on disk the database doesn't know about (e.g. after a crash).
  {
    const files = new Set(q.allFileIds.all().map((r) => r.id));
    for (const name of readdirSync(filesDir)) if (!files.has(name)) rmSync(filePath(name), { force: true });
    const uploads = new Set(q.allUploadIds.all().map((r) => r.id));
    for (const name of readdirSync(tmpDir)) if (!uploads.has(name)) rmSync(tmpPath(name), { force: true });
  }

  function removeWorkspace(id: string) {
    const files = q.filesIn.all(id);
    const uploads = q.uploadsIn.all(id);
    q.deleteWorkspace.run(id); // cascades to files + uploads rows
    for (const f of files) rmSync(filePath(f.id), { force: true });
    for (const u of uploads) rmSync(tmpPath(u.id), { force: true });
  }

  function removeUpload(id: string) {
    q.deleteUpload.run(id);
    rmSync(tmpPath(id), { force: true });
  }

  function sweep(now = Date.now()) {
    for (const { id } of q.expiredWorkspaces.all(now)) removeWorkspace(id);
    for (const { id } of q.staleUploads.all(now - STALE_UPLOAD_MS)) if (!busy.has(id)) removeUpload(id);
  }

  function liveWorkspace(id: string): WorkspaceRow {
    const ws = q.getWorkspace.get(id);
    if (!ws) throw new HttpError(404, "Workspace not found");
    if (ws.expires_at !== null && ws.expires_at <= Date.now()) {
      removeWorkspace(id);
      throw new HttpError(404, "Workspace has expired");
    }
    return ws;
  }

  function expiryFrom(raw: unknown, base: number): number | null {
    if (raw === null || raw === "never") return null;
    const days = Number(raw);
    if (!EXPIRY_CHOICES.includes(days)) throw new HttpError(400, "expiresInDays must be one of 1, 7, 30, 90 or null");
    return base + days * DAY;
  }

  const linkView = (l: ShareLinkRow) => ({
    url: `${cfg.publicOrigin}/d/${l.token}`,
    createdBy: l.created_by,
    createdAt: l.created_at,
    downloads: l.downloads,
  });

  const fileView = (f: FileRow) => {
    const link = q.linkForFile.get(f.id);
    return {
      id: f.id,
      name: f.name,
      size: f.size,
      mime: f.mime,
      uploader: f.uploader,
      createdAt: f.created_at,
      guestLink: link ? linkView(link) : null,
    };
  };

  /** Resolve a guest token to its file, or 404 — without saying which part failed. */
  function guestFile(token: string): { link: ShareLinkRow; file: FileRow; ws: WorkspaceRow } {
    const gone = () => new HttpError(404, "This link is no longer available.");
    const link = q.getLink.get(token);
    if (!link) throw gone();
    const file = q.getFile.get(link.file_id);
    if (!file) throw gone();
    let ws: WorkspaceRow;
    try {
      ws = liveWorkspace(file.workspace_id);
    } catch {
      throw gone();
    }
    return { link, file, ws };
  }

  function fileDownload(f: FileRow): Response {
    return new Response(Bun.file(filePath(f.id)), {
      headers: {
        "Content-Type": f.mime,
        "Content-Length": String(f.size),
        "Content-Disposition": contentDisposition(f.name),
      },
    });
  }

  const workspaceView = (w: WorkspaceRow) => ({
    id: w.id,
    name: w.name,
    createdAt: w.created_at,
    expiresAt: w.expires_at,
  });

  function sessionCookie(value: string, maxAge: number): string {
    return [
      `${COOKIE}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
      ...(secureCookie ? ["Secure"] : []),
    ].join("; ");
  }

  function checkQuota(size: number) {
    const { used } = q.usedBytes.get()!;
    if (used + size > cfg.maxTotalBytes) throw new HttpError(507, "Storage is full — delete some old workspaces first");
    try {
      const fs = statfsSync(cfg.dataDir);
      if (Number(fs.bavail) * Number(fs.bsize) < size + DISK_HEADROOM) throw new HttpError(507, "Server disk is full");
    } catch (e) {
      if (e instanceof HttpError) throw e;
    }
  }

  async function staticFile(rel: string, cache: string): Promise<Response> {
    const full = resolve(publicDir, rel);
    if (!full.startsWith(publicDir + sep)) return json({ error: "Not found" }, 404);
    const file = Bun.file(full);
    if (!(await file.exists())) return json({ error: "Not found" }, 404);
    return new Response(file, { headers: { "Cache-Control": cache } });
  }

  // ---- route handlers -------------------------------------------------------

  async function createUpload(req: Request, workspaceId: string, who: AccessKey): Promise<Response> {
    liveWorkspace(workspaceId);
    const b = await body(req);
    const size = Number(b.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "size must be a whole number of bytes");
    if (size > cfg.maxFileBytes) {
      throw new HttpError(413, `File is larger than the ${Math.round(cfg.maxFileBytes / 1024 / 1024)} MB limit`);
    }
    checkQuota(size);
    const name = cleanFileName(b.name);
    const mime = cleanMime(b.type);
    // Named keys know who is uploading; only the legacy shared code relies on a typed name.
    const uploader = who.name ? displayName(who.name) : cleanLabel(b.uploader, 40);
    const now = Date.now();

    if (size === 0) {
      const id = newId(16);
      await writeFile(filePath(id), new Uint8Array());
      q.insertFile.run(id, workspaceId, name, 0, mime, 0, uploader, now);
      return json({ complete: true, offset: 0, file: fileView(q.getFile.get(id)!) }, 201);
    }

    // Reserve quota synchronously (before any await) so concurrent inits can't overshoot it.
    const id = newId(20);
    q.insertUpload.run(id, workspaceId, name, size, mime, uploader, now, now);
    try {
      await writeFile(tmpPath(id), new Uint8Array());
    } catch (e) {
      q.deleteUpload.run(id);
      throw e;
    }
    return json({ uploadId: id, offset: 0, size, chunkBytes: cfg.chunkBytes, complete: false }, 201);
  }

  function completed(up: UploadRow): Response {
    const file = q.getFile.get(up.file_id!);
    if (!file) throw new HttpError(404, "That file has since been deleted");
    return json({ offset: up.size, complete: true, file: fileView(file) });
  }

  async function appendChunk(req: Request, uploadId: string): Promise<Response> {
    const up = q.getUpload.get(uploadId);
    if (!up) throw new HttpError(404, "Upload not found (it may have expired or been cancelled)");
    if (up.file_id) return completed(up); // final chunk retried after its response was lost
    if (busy.has(uploadId)) throw new HttpError(409, "Another chunk is in flight", { offset: up.received });
    busy.add(uploadId);
    try {
      const offset = Number(req.headers.get("upload-offset"));
      if (offset !== up.received) throw new HttpError(409, "Offset mismatch", { offset: up.received });
      const declared = Number(req.headers.get("content-length") ?? NaN);
      if (declared > cfg.chunkBytes) throw new HttpError(413, "Chunk too large", { chunkBytes: cfg.chunkBytes });

      const chunk = new Uint8Array(await req.arrayBuffer());
      if (chunk.length === 0) throw new HttpError(400, "Empty chunk");
      if (chunk.length > cfg.chunkBytes) throw new HttpError(413, "Chunk too large", { chunkBytes: cfg.chunkBytes });
      if (offset + chunk.length > up.size) throw new HttpError(400, "Chunk runs past the declared file size");

      // Positional write: a retried chunk simply overwrites the same range.
      const fh = await open(tmpPath(uploadId), "r+").catch(() => {
        throw new HttpError(404, "Upload was cancelled");
      });
      try {
        let written = 0;
        while (written < chunk.length) {
          const r = await fh.write(chunk, written, chunk.length - written, offset + written);
          written += r.bytesWritten;
        }
      } finally {
        await fh.close();
      }

      // The upload may have been cancelled (or its workspace deleted) while we wrote.
      if (!q.getUpload.get(uploadId)) throw new HttpError(404, "Upload was cancelled");

      const received = offset + chunk.length;
      const crc = crc32(chunk, up.crc32);
      const now = Date.now();
      if (received < up.size) {
        q.advanceUpload.run(received, crc, now, uploadId);
        return json({ offset: received, complete: false });
      }

      const fileId = newId(16);
      await rename(tmpPath(uploadId), filePath(fileId));
      // Keep the upload row (marked complete) so a client whose final response
      // got lost can still learn the file ID instead of re-uploading.
      // Re-check inside the transaction: the upload (or its whole workspace)
      // may have been deleted while the rename was in flight.
      const stored = db.transaction(() => {
        if (!q.getUpload.get(uploadId)) return false;
        q.insertFile.run(fileId, up.workspace_id, up.name, up.size, up.mime, crc, up.uploader, now);
        q.completeUpload.run(fileId, received, crc, now, uploadId);
        return true;
      })();
      if (!stored) {
        rmSync(filePath(fileId), { force: true });
        throw new HttpError(404, "Upload was cancelled");
      }
      return json({ offset: received, complete: true, file: fileView(q.getFile.get(fileId)!) });
    } finally {
      busy.delete(uploadId);
    }
  }

  function downloadAll(ws: WorkspaceRow): Response {
    const files = q.filesIn.all(ws.id);
    if (files.length === 0) throw new HttpError(404, "This workspace has no files yet");
    const names = uniqueNames(files.map((f) => f.name));
    const entries = files.map((f, i) => ({
      name: names[i]!,
      size: f.size,
      crc32: f.crc32,
      mtime: f.created_at,
      path: filePath(f.id),
    }));
    const length = zipLength(entries);
    // 0xFFFF / 0xFFFFFFFF are ZIP64 sentinels, so the limits are exclusive.
    if (length >= ZIP_LIMIT_BYTES || entries.length >= ZIP_LIMIT_ENTRIES) {
      throw new HttpError(413, "Too much to zip in one go (4 GB max) — download files individually");
    }
    return new Response(zipStream(entries), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(length),
        "Content-Disposition": contentDisposition(cleanFileName(ws.name) + ".zip"),
      },
    });
  }

  async function route(req: Request, clientIp: string): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Public routes.
    if (path === "/api/health") return json({ ok: true });
    if (method === "GET" && (path === "/" || /^\/w\/[a-z0-9]+$/.test(path))) {
      return staticFile("index.html", "no-store");
    }
    if (method === "GET" && (path.startsWith("/static/") || path === "/favicon.svg")) {
      return staticFile(path.slice(1), "no-cache");
    }

    // Guest links: anyone with the token may download that one file — nothing else.
    let g: RegExpMatchArray | null;
    if (method === "GET" && (g = path.match(/^\/d\/([a-z0-9]{26})$/))) {
      return staticFile("download.html", "no-store");
    }
    if (method === "GET" && (g = path.match(/^\/api\/guest\/([a-z0-9]{26})$/))) {
      const { link, file, ws } = guestFile(g[1]!);
      return json({
        name: file.name,
        size: file.size,
        sharedBy: link.created_by || file.uploader,
        createdAt: file.created_at,
        expiresAt: ws.expires_at,
      });
    }
    if (method === "GET" && (g = path.match(/^\/d\/([a-z0-9]{26})\/download$/))) {
      const { link, file } = guestFile(g[1]!);
      q.countDownload.run(link.token);
      return fileDownload(file);
    }

    if (method !== "GET" && method !== "HEAD") {
      // Same-origin check on writes (defence in depth on top of SameSite=Lax).
      const origin = req.headers.get("origin");
      const host = req.headers.get("host") ?? url.host;
      if (origin && origin !== "null") {
        let originHost = "";
        try {
          originHost = new URL(origin).host;
        } catch {}
        if (originHost !== host) throw new HttpError(403, "Cross-origin request refused");
      }
    }

    const who = verifySession(readCookie(req, COOKIE), cfg.sessionSecret, cfg.accessKeys);

    if (path === "/api/session" && method === "GET") {
      return json({
        authenticated: !!who,
        user: who?.name ? displayName(who.name) : null,
        maxFileBytes: cfg.maxFileBytes,
        chunkBytes: cfg.chunkBytes,
      });
    }
    if (path === "/api/login" && method === "POST") {
      if (!loginLimiter.take(clientIp)) throw new HttpError(429, "Too many attempts. Please try again in 15 minutes.");
      const b = await body(req);
      const key = findAccessKey(String(b.code ?? ""), cfg.accessKeys);
      if (!key) {
        await Bun.sleep(400);
        throw new HttpError(401, "This access key is not valid.");
      }
      loginLimiter.clear(clientIp);
      const token = makeSession(cfg.sessionSecret, key, cfg.sessionTtlSeconds);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, cfg.sessionTtlSeconds) });
    }
    if (path === "/api/logout" && method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
    }

    if (!path.startsWith("/api/")) return json({ error: "Not found" }, 404);
    if (!who) throw new HttpError(401, "Please sign in with your access key.");

    // Authenticated API.
    if (path === "/api/workspaces") {
      if (method === "GET") {
        sweep();
        return json({
          workspaces: q.listWorkspaces.all().map((w) => ({
            ...workspaceView(w),
            fileCount: w.file_count,
            totalBytes: w.total_bytes,
          })),
        });
      }
      if (method === "POST") {
        const b = await body(req);
        const name = cleanLabel(b.name, 80);
        if (!name) throw new HttpError(400, "Give the workspace a name");
        const now = Date.now();
        const expires = expiryFrom(b.expiresInDays === undefined ? 30 : b.expiresInDays, now);
        const id = newId(10);
        q.insertWorkspace.run(id, name, now, expires);
        return json({ workspace: workspaceView(q.getWorkspace.get(id)!) }, 201);
      }
    }

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/api\/workspaces\/([a-z0-9]+)$/))) {
      const ws = liveWorkspace(m[1]!);
      if (method === "GET") {
        return json({ workspace: workspaceView(ws), files: q.filesIn.all(ws.id).map(fileView) });
      }
      if (method === "PATCH") {
        const b = await body(req);
        const name = b.name === undefined ? ws.name : cleanLabel(b.name, 80);
        if (!name) throw new HttpError(400, "Give the workspace a name");
        const expires = b.expiresInDays === undefined ? ws.expires_at : expiryFrom(b.expiresInDays, Date.now());
        q.updateWorkspace.run(name, expires, ws.id);
        return json({ workspace: workspaceView(q.getWorkspace.get(ws.id)!) });
      }
      if (method === "DELETE") {
        removeWorkspace(ws.id);
        return json({ ok: true });
      }
    }
    if ((m = path.match(/^\/api\/workspaces\/([a-z0-9]+)\/zip$/)) && method === "GET") {
      return downloadAll(liveWorkspace(m[1]!));
    }
    if ((m = path.match(/^\/api\/workspaces\/([a-z0-9]+)\/uploads$/)) && method === "POST") {
      return createUpload(req, m[1]!, who);
    }
    if ((m = path.match(/^\/api\/uploads\/([a-z0-9]+)$/))) {
      const id = m[1]!;
      if (method === "PATCH") return appendChunk(req, id);
      if (method === "GET") {
        const up = q.getUpload.get(id);
        if (!up) throw new HttpError(404, "Upload not found");
        if (up.file_id) return completed(up);
        return json({ offset: up.received, size: up.size, complete: false });
      }
      if (method === "DELETE") {
        const up = q.getUpload.get(id);
        if (up) {
          removeUpload(id);
          // Cancel raced the final chunk: the file already landed, so honour the cancel.
          if (up.file_id) {
            q.deleteFile.run(up.file_id);
            rmSync(filePath(up.file_id), { force: true });
          }
        }
        return json({ ok: true });
      }
    }
    if ((m = path.match(/^\/api\/files\/([a-z0-9]+)\/download$/)) && method === "GET") {
      const f = q.getFile.get(m[1]!);
      if (!f) throw new HttpError(404, "File not found");
      liveWorkspace(f.workspace_id);
      return fileDownload(f);
    }
    if ((m = path.match(/^\/api\/files\/([a-z0-9]+)\/link$/))) {
      const f = q.getFile.get(m[1]!);
      if (!f) throw new HttpError(404, "File not found");
      liveWorkspace(f.workspace_id);
      if (method === "POST") {
        // One guest link per file; asking again returns the existing one.
        let link = q.linkForFile.get(f.id);
        if (!link) {
          q.insertLink.run(newId(26), f.id, who.name ? displayName(who.name) : "", Date.now());
          link = q.linkForFile.get(f.id)!;
        }
        return json({ guestLink: linkView(link) });
      }
      if (method === "DELETE") {
        q.deleteLinkForFile.run(f.id);
        return json({ ok: true });
      }
    }
    if ((m = path.match(/^\/api\/files\/([a-z0-9]+)$/)) && method === "DELETE") {
      const f = q.getFile.get(m[1]!);
      if (f) {
        q.deleteFile.run(f.id);
        rmSync(filePath(f.id), { force: true });
      }
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  }

  async function fetch(req: Request, clientIp = "local"): Promise<Response> {
    let res: Response;
    try {
      res = await route(req, clientIp);
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message, ...e.extra }, e.status);
      else {
        console.error("[transfer] unhandled error", e);
        res = json({ error: "Something went wrong on the server" }, 500);
      }
    }
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    if (!res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "private, no-store");
    return res;
  }

  return { fetch, sweep, close: () => db.close() };
}
