import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // 32 symbols, no 0/o/1/l

export function newId(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! & 31];
  return out;
}

/**
 * Display name for an uploaded file. Files are stored on disk under random
 * IDs, so this only has to be safe for listings, Content-Disposition and zip
 * entry names: no path separators, no control characters, bounded length.
 */
export function cleanFileName(raw: unknown): string {
  let n = String(raw ?? "").normalize("NFC");
  n = n.split(/[\\/]/).pop() ?? "";
  n = n.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (n === "" || /^\.+$/.test(n)) n = "file";
  if (n.length > 200) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : "";
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}

export function cleanLabel(raw: unknown, max: number): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, max);
}

/** attachment; filename="ascii"; filename*=UTF-8''encoded (RFC 6266 / 5987). */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Only pass through well-formed MIME types; everything else downloads as bytes. */
export function cleanMime(raw: unknown): string {
  const m = String(raw ?? "").toLowerCase().trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(m) ? m : "application/octet-stream";
}
