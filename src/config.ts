import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const MiB = 1024 * 1024;

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  accessCode: string;
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

export function loadConfig(): Config {
  const host = process.env.TRANSFER_HOST || "127.0.0.1";
  const port = int("TRANSFER_PORT", 4180);
  const dataDir = resolve(process.env.TRANSFER_DATA_DIR || "./var");
  mkdirSync(dataDir, { recursive: true });

  const accessCode = process.env.TRANSFER_ACCESS_CODE || "";
  if (accessCode.length < 6) {
    throw new Error(
      "TRANSFER_ACCESS_CODE must be set (at least 6 characters). " +
        "Example: TRANSFER_ACCESS_CODE=$(openssl rand -hex 6) bun run dev",
    );
  }

  return {
    host,
    port,
    dataDir,
    accessCode,
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
