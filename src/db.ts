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
  created_at: number;
  updated_at: number;
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
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `);
  return db;
}
