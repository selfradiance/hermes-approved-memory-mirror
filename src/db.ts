import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { HermesPaths, HermesRuntimeOptions } from "./types.js";

export const TABLES = [
  "memory_entries",
  "memory_drafts",
  "memory_events",
  "chat_sessions",
  "chat_messages",
  "memory_suggestion_dismissals",
  "sources",
  "source_chunks",
  "context_packs"
] as const;

const DB_FILE_RE = /^[A-Za-z0-9._-]+\.db$/;

export function resolveHermesPaths(options: HermesRuntimeOptions = {}): HermesPaths {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const dbFileName = options.dbFileName ?? "hermes.db";

  if (!DB_FILE_RE.test(dbFileName)) {
    throw new Error("Database filename must be a simple .db filename.");
  }

  const hermesDir = path.join(projectRoot, ".hermes");
  return {
    projectRoot,
    hermesDir,
    dbPath: path.join(hermesDir, dbFileName),
    exportDir: path.join(hermesDir, "export")
  };
}

export function ensureHermesDir(paths: HermesPaths): void {
  fs.mkdirSync(paths.hermesDir, { recursive: true });
}

export function openDatabase(
  options: HermesRuntimeOptions = {},
  mode: "create" | "existing" = "existing"
): Database.Database {
  const paths = resolveHermesPaths(options);
  if (mode === "create") {
    ensureHermesDir(paths);
  } else if (!fs.existsSync(paths.dbPath)) {
    throw new Error(`HERmes database not found at ${paths.dbPath}. Run "hermes init" first.`);
  }

  const db = new Database(paths.dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      source_type TEXT NOT NULL,
      source_label TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
      status TEXT NOT NULL CHECK (status IN ('approved', 'superseded', 'deleted')),
      supersedes_id INTEGER REFERENCES memory_entries(id),
      deleted_at TEXT,
      retired_at TEXT,
      retired_reason TEXT,
      approval_note TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_label TEXT NOT NULL,
      proposed_category TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      proposed_tags_json TEXT NOT NULL,
      proposed_confidence TEXT NOT NULL CHECK (proposed_confidence IN ('low', 'medium', 'high')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      review_note TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER REFERENCES memory_entries(id),
      draft_id INTEGER REFERENCES memory_drafts(id),
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      details_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      title TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'hermes')),
      content TEXT NOT NULL,
      memory_ids_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_suggestion_dismissals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      suggestion_key TEXT NOT NULL,
      UNIQUE(session_id, message_id, suggestion_key)
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      source_type TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived'))
    );

    CREATE TABLE IF NOT EXISTS source_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS context_packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      markdown TEXT NOT NULL,
      filename TEXT,
      export_path TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_entries_status ON memory_entries(status);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_source ON memory_entries(source_type, source_label);
    CREATE INDEX IF NOT EXISTS idx_memory_drafts_status ON memory_drafts(status);
    CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id ON memory_events(memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_events_draft_id ON memory_events(draft_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_memory_suggestion_dismissals_message ON memory_suggestion_dismissals(session_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status);
    CREATE INDEX IF NOT EXISTS idx_source_chunks_source ON source_chunks(source_id, chunk_index);
    CREATE INDEX IF NOT EXISTS idx_context_packs_created_at ON context_packs(created_at);
  `);

  ensureColumn(db, "memory_entries", "retired_at", "TEXT");
  ensureColumn(db, "memory_entries", "retired_reason", "TEXT");
}

export function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function ensureColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
  definition: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
