import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export const COOKIE = "t2_session";

// The HMAC key mixes in the access code, so changing the code logs everyone out.
function key(secret: string, accessCode: string): string {
  return secret + ":" + createHash("sha256").update(accessCode).digest("hex");
}

function sign(payload: string, secret: string, accessCode: string): string {
  return createHmac("sha256", key(secret, accessCode)).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  // Hash first so lengths always match and nothing leaks through timing.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** A named access key. name is "" for the legacy single shared code. */
export interface AccessKey {
  name: string;
  code: string;
}

/** Which key (if any) matches. Every key is compared, so timing doesn't reveal which. */
export function findAccessKey(given: string, keys: AccessKey[]): AccessKey | null {
  const g = given.trim();
  let match: AccessKey | null = null;
  for (const k of keys) if (safeEqual(g, k.code) && !match) match = k;
  return match;
}

// Each session is signed with its own key's code, so removing or rotating one
// person's key signs out only that person.
export function makeSession(secret: string, key: AccessKey, ttlSeconds: number, now = Date.now()): string {
  const payload = `v2.${key.name}.${Math.floor(now / 1000) + ttlSeconds}`;
  return `${payload}.${sign(payload, secret, key.code)}`;
}

export function verifySession(token: string | undefined, secret: string, keys: AccessKey[], now = Date.now()): AccessKey | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") return null;
  const key = keys.find((k) => k.name === parts[1]);
  if (!key) return null;
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  if (!safeEqual(parts[3]!, sign(payload, secret, key.code))) return null;
  const exp = Number(parts[2]);
  return Number.isFinite(exp) && exp * 1000 > now ? key : null;
}

/** "jean-pierre" -> "Jean-Pierre" */
export function displayName(name: string): string {
  return name
    .split("-")
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join("-");
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Fixed-window limiter for login attempts, keyed by client IP. */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {}

  /** Returns true if this attempt is allowed. */
  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.reset <= now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }

  clear(key: string) {
    this.hits.delete(key);
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
}
