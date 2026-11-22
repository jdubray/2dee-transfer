import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AccessKey } from "./auth.ts";

export const MiB = 1024 * 1024;

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  accessKeys: AccessKey[];
  sessionSecret: string;
  /** Public URL, e.g. https://transfer.2dee.org. https => Secure cookies. */
  publicOrigin: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Size of each upload chunk. Must stay well under Cloudflare's 100 MB body cap. */
  chunkBytes: number;
  sessionTtlSeconds: number;
  /** Trust CF-Connecting-IP / X-Forwarded-For (true when bound to loopback behind cloudflared). */
  trustProxy: boolean;
  requestLog: boolean;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(n);
}

/** Session secret: env wins; otherwise one is generated once and kept in the data dir. */
function loadSecret(dataDir: string): string {
  const fromEnv = process.env.TRANSFER_SESSION_SECRET;
  if (fromEnv) return fromEnv;
  const path = join(dataDir, "session.secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  return secret;
}

/**
 * TRANSFER_ACCESS_KEYS="jean-jacques:abcd-efgh-jkmn,edouard:..." gives each person
 * their own key. TRANSFER_ACCESS_CODE (one shared, unnamed code) still works too.
 */
export function parseAccessKeys(keysEnv: string | undefined, sharedCode: string | undefined): AccessKey[] {
  const keys: AccessKey[] = [];
  for (const entry of (keysEnv ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const colon = entry.indexOf(":");
    const name = entry.slice(0, colon).trim().toLowerCase();
    const code = entry.slice(colon + 1).trim();
    if (colon < 1 || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
      throw new Error(`TRANSFER_ACCESS_KEYS: bad entry "${entry.slice(0, Math.max(colon, 0))}…" (want name:key)`);
    }
    if (code.length < 6) throw new Error(`TRANSFER_ACCESS_KEYS: key for ${name} is shorter than 6 characters`);
    if (keys.some((k) => k.name === name)) throw new Error(`TRANSFER_ACCESS_KEYS: ${name} is listed twice`);
    keys.push({ name, code });
  }
  if (sharedCode) {
    if (sharedCode.length < 6) throw new Error("TRANSFER_ACCESS_CODE must be at least 6 characters");
    keys.push({ name: "", code: sharedCode });
  }
  if (keys.length === 0) {
    throw new Error(
      "Set TRANSFER_ACCESS_KEYS (name:key,name:key) or TRANSFER_ACCESS_CODE. " +
        "Example: TRANSFER_ACCESS_KEYS=me:$(openssl rand -hex 6) bun run dev",
    );
  }
  if (new Set(keys.map((k) => k.code)).size !== keys.length) throw new Error("Two access keys are identical");
  return keys;
}

export function loadConfig(): Config {
  const host = process.env.TRANSFER_HOST || "127.0.0.1";
  const port = int("TRANSFER_PORT", 4180);
  const dataDir = resolve(process.env.TRANSFER_DATA_DIR || "./var");
  mkdirSync(dataDir, { recursive: true });

  const accessKeys = parseAccessKeys(process.env.TRANSFER_ACCESS_KEYS, process.env.TRANSFER_ACCESS_CODE);

  return {
    host,
    port,
    dataDir,
    accessKeys,
    sessionSecret: loadSecret(dataDir),
    publicOrigin: process.env.TRANSFER_PUBLIC_ORIGIN || `http://${host}:${port}`,
    maxFileBytes: int("TRANSFER_MAX_FILE_BYTES", 100 * MiB),
    maxTotalBytes: int("TRANSFER_MAX_TOTAL_BYTES", 50 * 1024 * MiB),
    chunkBytes: int("TRANSFER_CHUNK_BYTES", 8 * MiB),
    sessionTtlSeconds: int("TRANSFER_SESSION_TTL", 30 * 24 * 3600),
    trustProxy: process.env.TRANSFER_TRUST_PROXY !== "0",
    requestLog: process.env.TRANSFER_REQUEST_LOG !== "0",
  };
}
