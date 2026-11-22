import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { crc32 } from "../src/crc32.ts";
import { cleanFileName, contentDisposition } from "../src/names.ts";
import { makeSession, verifySession } from "../src/auth.ts";

const CODE = "friends-only-123";
const BASE = "http://transfer.test";

let dir: string;
let app: App;
let cookie: string;

function config(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    accessCode: CODE,
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

async function login(): Promise<string> {
  const res = await app.fetch(
    new Request(BASE + "/api/login", { method: "POST", body: JSON.stringify({ code: CODE }), headers: { "content-type": "application/json" } }),
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

  test("sessions are invalidated when the access code changes", () => {
    const token = makeSession("s", "code-one", 60);
    expect(verifySession(token, "s", "code-one")).toBe(true);
    expect(verifySession(token, "s", "code-two")).toBe(false);
    expect(verifySession(token, "other", "code-one")).toBe(false);
    expect(verifySession(token.slice(0, -2) + "xx", "s", "code-one")).toBe(false);
    expect(verifySession(makeSession("s", "code-one", 60, Date.now() - 120_000), "s", "code-one")).toBe(false);
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
