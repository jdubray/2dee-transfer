import { Database } from "bun:sqlite";
import { join } from "node:path";

export interface WorkspaceRow {
  id: string;
  name: string;
  created_at: number;
  expires_at: number | null;
}

export interface FileRow {
  id: string;
  workspace_id: string;
  name: string;
  size: number;
  mime: string;
  crc32: number;
  uploader: string;
  created_at: number;
}

export interface UploadRow {
  id: string;
  workspace_id: string;
  name: string;
  size: number;
  mime: string;
  uploader: string;
  received: number;
  crc32: number;
  /** Set once the upload has completed and become a file. */
  file_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ShareLinkRow {
  token: string;
  file_id: string;
  created_by: string;
  created_at: number;
  downloads: number;
}

export function openDb(dataDir: string): Database {
  const db = new Database(join(dataDir, "transfer.db"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS files (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      mime         TEXT NOT NULL,
      crc32        INTEGER NOT NULL,
      uploader     TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_by_workspace ON files(workspace_id, created_at);
    CREATE TABLE IF NOT EXISTS uploads (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      mime         TEXT NOT NULL,
      uploader     TEXT NOT NULL DEFAULT '',
      received     INTEGER NOT NULL DEFAULT 0,
      crc32        INTEGER NOT NULL DEFAULT 0,
      file_id      TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `);
  // Guest links: a secret token that downloads one file, nothing else.
  db.run(`
    CREATE TABLE IF NOT EXISTS share_links (
      token      TEXT PRIMARY KEY,
      file_id    TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      downloads  INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Additive migrations for databases created by older versions.
  const uploadCols = db.query<{ name: string }, []>("PRAGMA table_info(uploads)").all().map((c) => c.name);
  if (!uploadCols.includes("file_id")) db.run("ALTER TABLE uploads ADD COLUMN file_id TEXT");
  return db;
}
