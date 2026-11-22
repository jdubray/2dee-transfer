import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { parseAccessKeys, type Config } from "../src/config.ts";
import { crc32 } from "../src/crc32.ts";
import { cleanFileName, contentDisposition } from "../src/names.ts";
import { makeSession, verifySession } from "../src/auth.ts";

const CODE = "friends-only-123";
const ED = "edouard-key-456";
const JP = "jean-pierre-key-789";
const BASE = "http://transfer.test";

let dir: string;
let app: App;
let cookie: string;

function config(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    accessKeys: [
      { name: "", code: CODE },
      { name: "edouard", code: ED },
      { name: "jean-pierre", code: JP },
    ],
    sessionSecret: "test-secret",
    publicOrigin: "https://transfer.test",
    maxFileBytes: 1000,
    maxTotalBytes: 5000,
    chunkBytes: 300,
    sessionTtlSeconds: 3600,
    trustProxy: true,
    requestLog: false,
    ...overrides,
  };
}

function req(method: string, path: string, opts: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; auth?: boolean } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.auth !== false && cookie) headers.cookie = cookie;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  return app.fetch(new Request(BASE + path, { method, headers, body }), "1.2.3.4");
}

async function login(code = CODE): Promise<string> {
  const res = await app.fetch(
    new Request(BASE + "/api/login", { method: "POST", body: JSON.stringify({ code }), headers: { "content-type": "application/json" } }),
    "9.9.9.9",
  );
  expect(res.status).toBe(200);
  const set = res.headers.get("set-cookie")!;
  expect(set).toContain("HttpOnly");
  expect(set).toContain("Secure");
  expect(set).toContain("SameSite=Lax");
  return set.split(";")[0]!;
}

async function newWorkspace(name = "Trip photos"): Promise<string> {
  const res = await req("POST", "/api/workspaces", { json: { name } });
  expect(res.status).toBe(201);
  return (await res.json()).workspace.id;
}

async function uploadBytes(ws: string, bytes: Uint8Array, name = "a.bin", chunk = 300) {
  const init = await (await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name, size: bytes.length, type: "application/x-test" } })).json();
  if (init.complete) return init;
  let offset = 0;
  let last: any;
  while (offset < bytes.length) {
    const piece = bytes.slice(offset, offset + chunk);
    const res = await req("PATCH", `/api/uploads/${init.uploadId}`, { body: piece, headers: { "upload-offset": String(offset) } });
    expect(res.status).toBe(200);
    last = await res.json();
    offset = last.offset;
  }
  return last;
}

function randomBytes(n: number) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "transfer-test-"));
  app = createApp(config());
  cookie = await login();
});

afterEach(() => {
  app.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows can hold SQLite/WAL handles briefly; the OS temp dir cleans up later.
  }
});

describe("auth gate", () => {
  test("API refuses requests without a session", async () => {
    cookie = "";
    for (const [m, p] of [
      ["GET", "/api/workspaces"],
      ["POST", "/api/workspaces"],
      ["GET", "/api/files/abc/download"],
      ["PATCH", "/api/uploads/abc"],
      ["GET", "/api/workspaces/abc/zip"],
    ] as const) {
      const res = await req(m, p, { auth: false });
      expect(res.status).toBe(401);
    }
  });

  test("wrong code is rejected, right code works", async () => {
    const bad = await app.fetch(new Request(BASE + "/api/login", { method: "POST", body: JSON.stringify({ code: "nope" }) }), "5.5.5.5");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
    const session = await (await req("GET", "/api/session")).json();
    expect(session.authenticated).toBe(true);
  });

  test("login is rate limited per IP", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const r = await app.fetch(new Request(BASE + "/api/login", { method: "POST", body: JSON.stringify({ code: "x" }) }), "7.7.7.7");
      last = r.status;
    }
    expect(last).toBe(429);
  }, 15000);

  test("rotating one person's key signs out only that person", () => {
    const a = { name: "edouard", code: "code-one" };
    const b = { name: "jean-pierre", code: "code-two" };
    const token = makeSession("s", a, 60);
    expect(verifySession(token, "s", [a, b])).toEqual(a);
    expect(verifySession(token, "s", [{ name: "edouard", code: "rotated" }, b])).toBeNull();
    expect(verifySession(token, "s", [b])).toBeNull();
    expect(verifySession(makeSession("s", b, 60), "s", [{ name: "edouard", code: "rotated" }, b])).toEqual(b);
    expect(verifySession(token, "other", [a, b])).toBeNull();
    expect(verifySession(token.slice(0, -2) + "xx", "s", [a, b])).toBeNull();
    // Swapping the name in a token must not let it pass as someone else.
    expect(verifySession(token.replace("edouard", "jean-pierre"), "s", [a, b])).toBeNull();
    expect(verifySession(makeSession("s", a, 60, Date.now() - 120_000), "s", [a, b])).toBeNull();
  });

  test("named keys identify the person and label their uploads", async () => {
    cookie = await login(ED);
    const session = await (await req("GET", "/api/session")).json();
    expect(session).toMatchObject({ authenticated: true, user: "Edouard" });
    const ws = await newWorkspace();
    const done = await uploadBytes(ws, randomBytes(10), "a.txt");
    expect(done.file.uploader).toBe("Edouard");
    cookie = await login(JP);
    const init = await (await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: "b", size: 0, uploader: "Someone Else" } })).json();
    expect(init.file.uploader).toBe("Jean-Pierre");
  });

  test("access key parsing", () => {
    expect(parseAccessKeys("Jean-Jacques:aaaa-bbbb, edouard:cccc-dddd", undefined)).toEqual([
      { name: "jean-jacques", code: "aaaa-bbbb" },
      { name: "edouard", code: "cccc-dddd" },
    ]);
    expect(parseAccessKeys(undefined, "shared-code")).toEqual([{ name: "", code: "shared-code" }]);
    expect(() => parseAccessKeys(undefined, undefined)).toThrow();
    expect(() => parseAccessKeys("a:123456,a:654321", undefined)).toThrow();
    expect(() => parseAccessKeys("a:123456,b:123456", undefined)).toThrow();
    expect(() => parseAccessKeys("a:short", undefined)).toThrow();
    expect(() => parseAccessKeys("no-colon-here", undefined)).toThrow();
  });

  test("cross-origin writes are refused", async () => {
    const res = await req("POST", "/api/workspaces", { json: { name: "x" }, headers: { origin: "https://evil.example", host: "transfer.test" } });
    expect(res.status).toBe(403);
  });

  test("pages and health are public", async () => {
    expect((await req("GET", "/api/health", { auth: false })).status).toBe(200);
    expect((await req("GET", "/", { auth: false })).status).toBe(200);
    expect((await req("GET", "/w/abc123", { auth: false })).status).toBe(200);
    expect((await req("GET", "/static/app.js", { auth: false })).status).toBe(200);
  });

  test("static paths cannot escape public/", async () => {
    const res = await req("GET", "/static/../../src/config.ts", { auth: false });
    expect(res.status).toBe(404);
    const res2 = await req("GET", "/static/..%2f..%2fsrc%2fconfig.ts", { auth: false });
    expect(res2.status).toBe(404);
  });
});

describe("workspaces", () => {
  test("create, list, rename, delete", async () => {
    const id = await newWorkspace("Birthday");
    let list = (await (await req("GET", "/api/workspaces")).json()).workspaces;
    expect(list.map((w: any) => w.name)).toEqual(["Birthday"]);
    expect(list[0].expiresAt).toBeGreaterThan(Date.now());

    const patched = await req("PATCH", `/api/workspaces/${id}`, { json: { name: "Birthday 2026", expiresInDays: null } });
    expect((await patched.json()).workspace).toMatchObject({ name: "Birthday 2026", expiresAt: null });

    await uploadBytes(id, randomBytes(500));
    expect(readdirSync(join(dir, "files")).length).toBe(1);

    expect((await req("DELETE", `/api/workspaces/${id}`)).status).toBe(200);
    expect((await req("GET", `/api/workspaces/${id}`)).status).toBe(404);
    expect(readdirSync(join(dir, "files")).length).toBe(0);
  });

  test("rejects empty names and odd expiry values", async () => {
    expect((await req("POST", "/api/workspaces", { json: { name: "   " } })).status).toBe(400);
    expect((await req("POST", "/api/workspaces", { json: { name: "x", expiresInDays: 3 } })).status).toBe(400);
  });

  test("expired workspaces disappear on sweep", async () => {
    const id = await newWorkspace();
    await uploadBytes(id, randomBytes(100));
    app.sweep(Date.now() + 31 * 24 * 3600 * 1000);
    expect((await req("GET", `/api/workspaces/${id}`)).status).toBe(404);
    expect(readdirSync(join(dir, "files")).length).toBe(0);
  });
});

describe("chunked uploads", () => {
  test("round-trips bytes exactly and records the CRC", async () => {
    const ws = await newWorkspace();
    const bytes = randomBytes(1000);
    const done = await uploadBytes(ws, bytes, "report.pdf");
    expect(done.complete).toBe(true);
    expect(done.file).toMatchObject({ name: "report.pdf", size: 1000 });

    const dl = await req("GET", `/api/files/${done.file.id}/download`);
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(bytes);
    expect(dl.headers.get("content-disposition")).toContain('filename="report.pdf"');
    expect(dl.headers.get("cache-control")).toBe("private, no-store");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("download URLs carry no file extension (keeps Cloudflare from caching them)", async () => {
    const ws = await newWorkspace();
    const done = await uploadBytes(ws, randomBytes(10), "photo.jpg");
    const files = (await (await req("GET", `/api/workspaces/${ws}`)).json()).files;
    expect(files[0].id).toBe(done.file.id);
    expect(`/api/files/${done.file.id}/download`).not.toMatch(/\.[a-z0-9]+$/i);
  });

  test("rejects files over the size cap at init", async () => {
    const ws = await newWorkspace();
    const res = await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: "big", size: 1001 } });
    expect(res.status).toBe(413);
    const ok = await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: "edge", size: 1000 } });
    expect(ok.status).toBe(201);
  });

  test("offset mismatch returns 409 with the server offset", async () => {
    const ws = await newWorkspace();
    const init = await (await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: "a", size: 600 } })).json();
    const first = await req("PATCH", `/api/uploads/${init.uploadId}`, { body: randomBytes(300), headers: { "upload-offset": "0" } });
    expect(first.status).toBe(200);
    const dup = await req("PATCH", `/api/uploads/${init.uploadId}`, { body: randomBytes(300), headers: { "upload-offset": "0" } });
    expect(dup.status).toBe(409);
    expect((await dup.json()).offset).toBe(300);
    const status = await (await req("GET", `/api/uploads/${init.uploadId}`)).json();
    expect(status.offset).toBe(300);
  });

  test("a retried final chunk (lost response) reports the stored file instead of failing", async () => {
    const ws = await newWorkspace();
    const bytes = randomBytes(500);
    const done = await uploadBytes(ws, bytes, "x.bin");
    // Simulate the client never seeing that reply: it asks for status, then resends the last chunk.
    const uploadId = (await (await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: "y", size: 10 } })).json()).uploadId;
    const last = await req("PATCH", `/api/uploads/${uploadId}`, { body: randomBytes(10), headers: { "upload-offset": "0" } });
    const fileId = (await last.json()).file.id;
    const status = await (await req("GET", `/api/uploads/${uploadId}`)).json();
    expect(status).toMatchObject({ complete: true, file: { id: fileId } });
    const resend = await (await req("PATCH", `/api/uploads/${uploadId}`, { body: randomBytes(10), headers: { "upload-offset": "0" } })).json();
    expect(resend).toMatchObject({ complete: true, file: { id: fileId } });
    const files = (await (await req("GET", `/api/workspaces/${ws}`)).json()).files;
    expect(files.map((f: any) => f.id).sort()).toEqual([done.file.id, fileId].sort());
  });

  test("cancelling after the final chunk landed removes the stored file", async () => {
    const ws = await newWorkspace();
    const uploadId = (await (await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: "z", size: 10 } })).json()).uploadId;
    await req("PATCH", `/api/uploads/${uploadId}`, { body: randomBytes(10), headers: { "upload-offset": "0" } });
    expect((await req("DELETE", `/api/uploads/${uploadId}`)).status).toBe(200);
    expect((await (await req("GET", `/api/workspaces/${ws}`)).json()).files).toEqual([]);
    expect(readdirSync(join(dir, "files")).length).toBe(0);
  });

  test("databases from before uploads.file_id are migrated", () => {
    app.close();
    const old = mkdtempSync(join(tmpdir(), "transfer-old-"));
    const db = new Database(join(old, "transfer.db"));
    db.run(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER);
      CREATE TABLE uploads (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
        mime TEXT NOT NULL, uploader TEXT NOT NULL DEFAULT '', received INTEGER NOT NULL DEFAULT 0,
        crc32 INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    db.close();
    app = createApp(config({ dataDir: old }));
    const cols = new Database(join(old, "transfer.db")).query<{ name: string }, []>("PRAGMA table_info(uploads)").all();
    expect(cols.map((c) => c.name)).toContain("file_id");
  });

  test("concurrent inits can't overshoot the storage quota", async () => {
    const ws = await newWorkspace();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: `c${i}`, size: 1000 } })),
    );
    expect(results.filter((r) => r.status === 201).length).toBe(5);
    expect(results.filter((r) => r.status === 507).length).toBe(3);
  });

  test("rejects oversized chunks and chunks past the declared size", async () => {
    const ws = await newWorkspace();
    const init = await (await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: "a", size: 400 } })).json();
    const big = await req("PATCH", `/api/uploads/${init.uploadId}`, { body: randomBytes(301), headers: { "upload-offset": "0" } });
    expect(big.status).toBe(413);
    await req("PATCH", `/api/uploads/${init.uploadId}`, { body: randomBytes(300), headers: { "upload-offset": "0" } });
    const over = await req("PATCH", `/api/uploads/${init.uploadId}`, { body: randomBytes(200), headers: { "upload-offset": "300" } });
    expect(over.status).toBe(400);
  });

  test("cancelling removes the partial upload", async () => {
    const ws = await newWorkspace();
    const init = await (await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: "a", size: 600 } })).json();
    await req("PATCH", `/api/uploads/${init.uploadId}`, { body: randomBytes(300), headers: { "upload-offset": "0" } });
    expect((await req("DELETE", `/api/uploads/${init.uploadId}`)).status).toBe(200);
    expect(readdirSync(join(dir, "uploads")).length).toBe(0);
    const after = await req("PATCH", `/api/uploads/${init.uploadId}`, { body: randomBytes(300), headers: { "upload-offset": "300" } });
    expect(after.status).toBe(404);
  });

  test("zero-byte files complete immediately", async () => {
    const ws = await newWorkspace();
    const res = await (await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: "empty.txt", size: 0 } })).json();
    expect(res.complete).toBe(true);
    expect(res.file.size).toBe(0);
  });

  test("total storage quota is enforced", async () => {
    const ws = await newWorkspace();
    for (let i = 0; i < 5; i++) await uploadBytes(ws, randomBytes(1000), `f${i}`);
    const res = await req("POST", `/api/workspaces/${ws}/uploads`, { json: { name: "one-too-many", size: 1 } });
    expect(res.status).toBe(507);
  });

  test("path-like file names are flattened", async () => {
    const ws = await newWorkspace();
    const done = await uploadBytes(ws, randomBytes(5), "../../etc/passwd");
    expect(done.file.name).toBe("passwd");
    const win = await uploadBytes(ws, randomBytes(5), "..\\..\\boot.ini");
    expect(win.file.name).toBe("boot.ini");
    // Stored under random IDs only.
    for (const f of readdirSync(join(dir, "files"))) expect(f).toMatch(/^[a-z0-9]{16}$/);
  });
});

describe("guest links", () => {
  async function share(fileId: string) {
    const res = await req("POST", `/api/files/${fileId}/link`);
    expect(res.status).toBe(200);
    return (await res.json()).guestLink as { url: string; downloads: number };
  }
  const tokenOf = (url: string) => url.split("/d/")[1]!;

  test("a guest link downloads exactly that file without a session", async () => {
    const ws = await newWorkspace();
    const bytes = randomBytes(700);
    const done = await uploadBytes(ws, bytes, "contract.pdf");
    await uploadBytes(ws, randomBytes(50), "other.txt");
    const link = await share(done.file.id);
    expect(link.url).toMatch(/^https:\/\/transfer\.test\/d\/[a-z0-9]{26}$/);
    expect((await share(done.file.id)).url).toBe(link.url); // idempotent

    const t = tokenOf(link.url);
    cookie = ""; // guest: no session at all
    const page = await req("GET", `/d/${t}`, { auth: false });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const meta = await (await req("GET", `/api/guest/${t}`, { auth: false })).json();
    expect(meta).toMatchObject({ name: "contract.pdf", size: 700 });
    expect(meta.workspaceId).toBeUndefined();

    const dl = await req("GET", `/d/${t}/download`, { auth: false });
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(bytes);
    expect(dl.headers.get("content-disposition")).toContain("contract.pdf");
    expect(dl.headers.get("cache-control")).toBe("private, no-store");

    // ...and nothing else: no workspace, no listing, no other files, no uploads.
    expect((await req("GET", `/api/workspaces/${ws}`, { auth: false })).status).toBe(401);
    expect((await req("GET", "/api/workspaces", { auth: false })).status).toBe(401);
    expect((await req("GET", `/api/workspaces/${ws}/zip`, { auth: false })).status).toBe(401);
    expect((await req("POST", `/api/workspaces/${ws}/uploads`, { auth: false, json: { name: "x", size: 1 } })).status).toBe(401);
  });

  test("download count, disabling, and deletion", async () => {
    const ws = await newWorkspace();
    const done = await uploadBytes(ws, randomBytes(20), "a.bin");
    const t = tokenOf((await share(done.file.id)).url);
    await req("GET", `/d/${t}/download`, { auth: false });
    await req("GET", `/d/${t}/download`, { auth: false });
    const files = (await (await req("GET", `/api/workspaces/${ws}`)).json()).files;
    expect(files[0].guestLink.downloads).toBe(2);

    expect((await req("DELETE", `/api/files/${done.file.id}/link`)).status).toBe(200);
    expect((await req("GET", `/d/${t}/download`, { auth: false })).status).toBe(404);
    expect((await req("GET", `/api/guest/${t}`, { auth: false })).status).toBe(404);

    const t2 = tokenOf((await share(done.file.id)).url);
    expect(t2).not.toBe(t); // re-sharing issues a fresh token
    await req("DELETE", `/api/files/${done.file.id}`);
    expect((await req("GET", `/d/${t2}/download`, { auth: false })).status).toBe(404);
  });

  test("links die with an expired or deleted workspace, and bad tokens 404", async () => {
    const ws = await newWorkspace();
    const done = await uploadBytes(ws, randomBytes(20), "a.bin");
    const t = tokenOf((await share(done.file.id)).url);
    app.sweep(Date.now() + 31 * 24 * 3600 * 1000);
    expect((await req("GET", `/d/${t}/download`, { auth: false })).status).toBe(404);
    expect((await req("GET", `/d/${"a".repeat(26)}/download`, { auth: false })).status).toBe(404);
    expect((await req("GET", `/d/short/download`, { auth: false })).status).toBe(404);
  });

  test("creating a link requires a session", async () => {
    const ws = await newWorkspace();
    const done = await uploadBytes(ws, randomBytes(5), "a.bin");
    expect((await req("POST", `/api/files/${done.file.id}/link`, { auth: false })).status).toBe(401);
  });
});

describe("download all", () => {
  test("produces a valid zip whose entries match the uploads", async () => {
    const ws = await newWorkspace("Zip me");
    const a = randomBytes(700);
    const b = randomBytes(123);
    await uploadBytes(ws, a, "same.txt");
    await uploadBytes(ws, b, "same.txt");
    const res = await req("GET", `/api/workspaces/${ws}/zip`);
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get("content-length"))).toBe(buf.length);

    // Parse the archive back via its central directory.
    const v = new DataView(buf.buffer);
    const eocd = buf.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const out: Record<string, Uint8Array> = {};
    for (let i = 0; i < count; i++) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      const crc = v.getUint32(p + 16, true);
      const size = v.getUint32(p + 24, true);
      const nameLen = v.getUint16(p + 28, true);
      const local = v.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + nameLen));
      const localNameLen = v.getUint16(local + 26, true);
      const data = buf.slice(local + 30 + localNameLen, local + 30 + localNameLen + size);
      expect(crc32(data)).toBe(crc);
      out[name] = data;
      p += 46 + nameLen;
    }
    expect(Object.keys(out).sort()).toEqual(["same (2).txt", "same.txt"]);
    expect(out["same.txt"]).toEqual(a);
    expect(out["same (2).txt"]).toEqual(b);
  });
});

describe("helpers", () => {
  test("crc32 matches known vectors and chains across chunks", () => {
    const enc = new TextEncoder();
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(enc.encode("6789"), crc32(enc.encode("12345")))).toBe(0xcbf43926);
  });

  test("file names and content-disposition", () => {
    expect(cleanFileName("")).toBe("file");
    expect(cleanFileName("..")).toBe("file");
    expect(cleanFileName("a\u0000b\nc.txt")).toBe("abc.txt");
    const cd = contentDisposition('été "quoted".pdf');
    expect(cd).toContain('filename="_t_ _quoted_.pdf"');
    expect(cd).toContain("filename*=UTF-8''%C3%A9t%C3%A9%20%22quoted%22.pdf");
  });
});
