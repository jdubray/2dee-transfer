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

export function checkAccessCode(given: string, expected: string): boolean {
  return safeEqual(given.trim(), expected);
}

export function makeSession(secret: string, accessCode: string, ttlSeconds: number, now = Date.now()): string {
  const payload = `v1.${Math.floor(now / 1000) + ttlSeconds}`;
  return `${payload}.${sign(payload, secret, accessCode)}`;
}

export function verifySession(token: string | undefined, secret: string, accessCode: string, now = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const payload = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(parts[2]!, sign(payload, secret, accessCode))) return false;
  const exp = Number(parts[1]);
  return Number.isFinite(exp) && exp * 1000 > now;
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
