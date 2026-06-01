import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase, tableExists, TABLES } from "./db.js";
import { createDraftFromText } from "./hermes.js";
import type {
  HermesRuntimeOptions,
  MemoryDraft,
  Source,
  SourceChunk,
  SourceChunkResult,
  SourceSummary
} from "./types.js";

export const MAX_SOURCE_BYTES = 1_000_000;
const ALLOWED_EXTENSIONS = [".md", ".markdown", ".txt"] as const;
const TARGET_CHUNK_CHARS = 1000;
const MAX_CHUNK_CHARS = 1500;
const MIN_CHUNK_CHARS = 80;

const SOURCE_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "based",
  "could",
  "should",
  "that",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would"
]);

export interface ImportSourceInput {
  filename: string;
  content: string;
  title?: string;
}

export function importSource(input: ImportSourceInput, options: HermesRuntimeOptions = {}): SourceSummary {
  const filename = input.filename.trim();
  if (!filename) {
    throw new Error("A filename is required to import a source.");
  }

  const extension = fileExtension(filename);
  if (!ALLOWED_EXTENSIONS.includes(extension as (typeof ALLOWED_EXTENSIONS)[number])) {
    throw new Error("Only Markdown (.md, .markdown) and plain text (.txt) files can be imported.");
  }

  const content = input.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes === 0 || !content.trim()) {
    throw new Error("This file looks empty, so there is nothing to import.");
  }
  if (sizeBytes > MAX_SOURCE_BYTES) {
    const limitKb = Math.round(MAX_SOURCE_BYTES / 1000);
    throw new Error(`This file is too large to import. The limit is about ${limitKb} KB of text.`);
  }

  const title = (input.title?.trim() || titleFromFilename(filename)).slice(0, 200);
  const sourceType = extension === ".txt" ? "text" : "markdown";
  const contentHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const chunks = chunkContent(content);
  const now = nowIso();

  const db = openExistingDb(options);
  try {
    const insert = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO sources (
            title,
            original_filename,
            source_type,
            imported_at,
            content_hash,
            size_bytes,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, 'active')`
        )
        .run(title, filename, sourceType, now, contentHash, sizeBytes);
      const sourceId = Number(info.lastInsertRowid);

      const chunkStmt = db.prepare(
        `INSERT INTO source_chunks (source_id, chunk_index, content, char_count, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      chunks.forEach((chunk, index) => {
        chunkStmt.run(sourceId, index, chunk, chunk.length, now);
      });

      return sourceId;
    });

    const sourceId = insert();
    const summary = getSourceSummary(db, sourceId);
    if (!summary) {
      throw new Error("Expected the imported source to be readable.");
    }
    return summary;
  } finally {
    db.close();
  }
}

export function listSources(options: HermesRuntimeOptions = {}): SourceSummary[] {
  const db = openExistingDb(options);
  try {
    return db
      .prepare(
        `SELECT s.*, COUNT(c.id) AS chunk_count
         FROM sources s
         LEFT JOIN source_chunks c ON c.source_id = s.id
         WHERE s.status = 'active'
         GROUP BY s.id
         ORDER BY s.id DESC`
      )
      .all() as SourceSummary[];
  } finally {
    db.close();
  }
}

export function getSource(sourceId: number, options: HermesRuntimeOptions = {}): SourceSummary | undefined {
  const db = openExistingDb(options);
  try {
    return getSourceSummary(db, sourceId);
  } finally {
    db.close();
  }
}

export function getSourceChunks(sourceId: number, options: HermesRuntimeOptions = {}): SourceChunk[] {
  const db = openExistingDb(options);
  try {
    return db
      .prepare("SELECT * FROM source_chunks WHERE source_id = ? ORDER BY chunk_index ASC")
      .all(sourceId) as SourceChunk[];
  } finally {
    db.close();
  }
}

export function searchSourceChunks(
  query: string,
  options: HermesRuntimeOptions & { limit?: number } = {}
): SourceChunkResult[] {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error("Search query is required.");
  }

  const db = openExistingDb(options);
  try {
    const like = `%${escapeLike(normalized)}%`;
    const rows = db
      .prepare(
        `SELECT c.*, s.title AS source_title
         FROM source_chunks c
         JOIN sources s ON s.id = c.source_id
         WHERE s.status = 'active' AND c.content LIKE ? ESCAPE '\\'
         ORDER BY c.source_id DESC, c.chunk_index ASC
         LIMIT ?`
      )
      .all(like, options.limit ?? 20) as Array<SourceChunk & { source_title: string }>;

    return rows.map((row) => toChunkResult(row, row.source_title, normalized));
  } finally {
    db.close();
  }
}

export function retrieveRelevantSourceChunks(
  question: string,
  options: HermesRuntimeOptions & { limit?: number } = {}
): SourceChunkResult[] {
  const terms = extractTerms(question);
  if (terms.length === 0) {
    return [];
  }

  const db = openExistingDb(options);
  try {
    const rows = db
      .prepare(
        `SELECT c.*, s.title AS source_title
         FROM source_chunks c
         JOIN sources s ON s.id = c.source_id
         WHERE s.status = 'active'`
      )
      .all() as Array<SourceChunk & { source_title: string }>;

    const scored = rows
      .map((row) => {
        const haystack = row.content.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        const term = terms.find((candidate) => haystack.includes(candidate)) ?? question;
        return { row, score, snippet: makeSnippet(row.content, term) };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.row.source_id - b.row.source_id || a.row.chunk_index - b.row.chunk_index)
      .slice(0, options.limit ?? 3);

    return scored.map(({ row, snippet }) => ({
      chunk: stripSourceTitle(row),
      sourceTitle: row.source_title,
      snippet
    }));
  } finally {
    db.close();
  }
}

export function suggestMemoriesFromSource(
  sourceId: number,
  options: HermesRuntimeOptions & { limit?: number } = {}
): MemoryDraft[] {
  const summary = getSource(sourceId, options);
  if (!summary) {
    throw new Error(`Source ${sourceId} was not found.`);
  }

  const chunks = getSourceChunks(sourceId, options);
  const candidates = chunks
    .map((chunk) => ({ chunk, text: firstDurableStatement(chunk.content) }))
    .filter((entry): entry is { chunk: SourceChunk; text: string } => Boolean(entry.text))
    .slice(0, options.limit ?? 3);

  const sourceLabel = `source #${summary.id}: ${summary.title}`;
  return candidates.map(({ chunk, text }) =>
    createDraftFromText(text, "source", `${sourceLabel} (excerpt ${chunk.chunk_index + 1})`, options)
  );
}

export function chunkContent(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    buffer = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      flush();
      for (const piece of hardSplit(paragraph)) {
        chunks.push(piece);
      }
      continue;
    }

    if (!buffer) {
      buffer = paragraph;
    } else if (buffer.length + paragraph.length + 2 <= TARGET_CHUNK_CHARS) {
      buffer = `${buffer}\n\n${paragraph}`;
    } else {
      flush();
      buffer = paragraph;
    }
  }
  flush();

  // Merge a trailing tiny chunk into the previous one to avoid sliver excerpts.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    if (last.length < MIN_CHUNK_CHARS) {
      const merged = `${chunks[chunks.length - 2]}\n\n${last}`;
      chunks.splice(chunks.length - 2, 2, merged);
    }
  }

  return chunks;
}

function hardSplit(paragraph: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < paragraph.length; start += MAX_CHUNK_CHARS) {
    pieces.push(paragraph.slice(start, start + MAX_CHUNK_CHARS).trim());
  }
  return pieces.filter(Boolean);
}

function firstDurableStatement(content: string): string | undefined {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length < MIN_CHUNK_CHARS) {
    return undefined;
  }
  const sentence = compact.split(/(?<=[.!?])\s+/)[0] ?? compact;
  return sentence.length > 280 ? `${sentence.slice(0, 277)}...` : sentence;
}

function getSourceSummary(db: Database.Database, sourceId: number): SourceSummary | undefined {
  const row = db
    .prepare(
      `SELECT s.*, COUNT(c.id) AS chunk_count
       FROM sources s
       LEFT JOIN source_chunks c ON c.source_id = s.id
       WHERE s.id = ? AND s.status = 'active'
       GROUP BY s.id`
    )
    .get(sourceId) as SourceSummary | undefined;
  return row;
}

function toChunkResult(
  row: SourceChunk & { source_title: string },
  sourceTitle: string,
  query: string
): SourceChunkResult {
  return { chunk: stripSourceTitle(row), sourceTitle, snippet: makeSnippet(row.content, query) };
}

function stripSourceTitle(row: SourceChunk & { source_title?: string }): SourceChunk {
  const { source_title: _unused, ...chunk } = row;
  return chunk;
}

function fileExtension(filename: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(filename);
  return match ? match[0].toLowerCase() : "";
}

function titleFromFilename(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[A-Za-z0-9]+$/, "");
  const cleaned = base.replace(/[-_]+/g, " ").trim();
  return cleaned || filename;
}

function extractTerms(question: string): string[] {
  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !SOURCE_STOPWORDS.has(term));
  return Array.from(new Set(terms));
}

function makeSnippet(content: string, query: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  const lowered = compact.toLowerCase();
  const index = lowered.indexOf(query.toLowerCase());
  if (index === -1) {
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
  }

  const start = Math.max(0, index - 50);
  const end = Math.min(compact.length, index + query.length + 90);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function openExistingDb(options: HermesRuntimeOptions): Database.Database {
  const db = openDatabase(options, "existing");
  const missingTable = TABLES.find((table) => !tableExists(db, table));
  if (missingTable) {
    db.close();
    throw new Error(`HERmes database is missing table ${missingTable}. Run "hermes init" first.`);
  }
  return db;
}

function nowIso(): string {
  return new Date().toISOString();
}
