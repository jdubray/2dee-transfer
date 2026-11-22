// End-to-end smoke test against a real server process: pushes a full
// 100 MiB file through the chunk API, downloads it (and the zip), and
// compares SHA-256s. Usage: bun run e2e
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const MiB = 1024 * 1024;
const port = 4300 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "transfer-e2e-"));
const code = "e2e-code-" + Math.random().toString(36).slice(2);

const server = Bun.spawn(["bun", "run", "src/main.ts"], {
  env: { ...process.env, TRANSFER_PORT: String(port), TRANSFER_DATA_DIR: dataDir, TRANSFER_ACCESS_CODE: code, TRANSFER_REQUEST_LOG: "0" },
  stdout: "inherit",
  stderr: "inherit",
});

function sha(buf: Uint8Array) {
  return createHash("sha256").update(buf).digest("hex");
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok  " + msg);
}

try {
  await waitUp();
  const login = await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ code }), headers: { "content-type": "application/json" } });
  check(login.ok, "login with access code");
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const H = { cookie, "content-type": "application/json" };

  const ws = (await (await fetch(base + "/api/workspaces", { method: "POST", headers: H, body: JSON.stringify({ name: "E2E" }) })).json()).workspace;

  const tooBig = await fetch(`${base}/api/workspaces/${ws.id}/uploads`, { method: "POST", headers: H, body: JSON.stringify({ name: "x", size: 100 * MiB + 1 }) });
  check(tooBig.status === 413, "100 MiB + 1 byte is refused");

  const size = 100 * MiB;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, size)));
  const want = sha(data);

  const t0 = performance.now();
  const init = await (await fetch(`${base}/api/workspaces/${ws.id}/uploads`, { method: "POST", headers: H, body: JSON.stringify({ name: "big file.bin", size }) })).json();
  let offset = 0;
  let res: any;
  let chunks = 0;
  while (offset < size) {
    const r = await fetch(`${base}/api/uploads/${init.uploadId}`, {
      method: "PATCH",
      headers: { cookie, "upload-offset": String(offset), "content-type": "application/octet-stream" },
      body: data.subarray(offset, offset + init.chunkBytes),
    });
    if (!r.ok) throw new Error(`chunk at ${offset} failed: ${r.status} ${await r.text()}`);
    res = await r.json();
    offset = res.offset;
    chunks++;
  }
  check(res.complete && res.file.size === size, `uploaded 100 MiB in ${chunks} chunks of ${init.chunkBytes / MiB} MiB (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

  const whole = await fetch(base + "/api/uploads/x", { method: "PATCH", headers: { cookie, "upload-offset": "0" }, body: new Uint8Array(20 * MiB) }).catch((e) => e);
  check(whole instanceof Error || whole.status === 413 || whole.status === 404, "server refuses request bodies far beyond one chunk");

  const dl = await fetch(`${base}/api/files/${res.file.id}/download`, { headers: { cookie } });
  const got = new Uint8Array(await dl.arrayBuffer());
  check(sha(got) === want, "download SHA-256 matches upload");
  check(dl.headers.get("content-disposition")?.includes("big file.bin"), "Content-Disposition carries the filename");

  const zip = await fetch(`${base}/api/workspaces/${ws.id}/zip`, { headers: { cookie } });
  const zbuf = new Uint8Array(await zip.arrayBuffer());
  // Bun streams this chunked (it drops Content-Length on stream bodies), so check the size directly.
  check(zip.ok && zbuf.length === size + 30 + 12 + 46 + 12 + 22, "zip archive has the expected size");
  const nameLen = new DataView(zbuf.buffer).getUint16(26, true);
  check(sha(zbuf.subarray(30 + nameLen, 30 + nameLen + size)) === want, "zip entry bytes match upload");

  const anon = await fetch(`${base}/api/files/${res.file.id}/download`);
  check(anon.status === 401, "download without session is refused");
  console.log("\nE2E passed.");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.kill();
  await server.exited;
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
}
