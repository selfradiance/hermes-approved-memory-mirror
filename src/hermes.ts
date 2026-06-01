import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDraftProposalFromText } from "./draftGeneration.js";
import { initializeSchema, openDatabase, resolveHermesPaths, tableExists, TABLES } from "./db.js";
import { readExplicitIntakeFile } from "./fileSafety.js";
import type {
  DoctorReport,
  DraftProposal,
  HermesPaths,
  HermesRuntimeOptions,
  MemoryDraft,
  MemoryEntry,
  MemoryEvent,
  ReflectionReport,
  SearchResult
} from "./types.js";

const BASIS_NOTE = "Reflection is based only on approved local memory." as const;
const REFLECTION_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "based",
  "could",
  "reuse",
  "should",
  "that",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "video"
]);

export function initHermes(options: HermesRuntimeOptions = {}): HermesPaths {
  const paths = resolveHermesPaths(options);
  const db = openDatabase(options, "create");
  try {
    initializeSchema(db);
    insertEvent(db, {
      event_type: "database_initialized",
      details: { dbPath: paths.dbPath }
    });
  } finally {
    db.close();
  }
  return paths;
}

export function ensureHermesInitialized(options: HermesRuntimeOptions = {}): HermesPaths {
  const paths = resolveHermesPaths(options);
  const db = openDatabase(options, "create");
  try {
    initializeSchema(db);
  } finally {
    db.close();
  }
  return paths;
}

export function intakeText(text: string, options: HermesRuntimeOptions = {}): MemoryDraft[] {
  const proposal = createDraftProposalFromText(text, "manual_text", "cli --text");
  return insertDraftProposals([proposal], options);
}

export function createDraftFromText(
  text: string,
  sourceType: string,
  sourceLabel: string,
  options: HermesRuntimeOptions = {}
): MemoryDraft {
  const proposal = createDraftProposalFromText(text, sourceType, sourceLabel);
  const [draft] = insertDraftProposals([proposal], options);
  if (!draft) {
    throw new Error("Expected draft creation to return one pending draft.");
  }
  return draft;
}

export function intakeFile(
  filePath: string,
  options: HermesRuntimeOptions & { allowExternalFile?: boolean } = {}
): MemoryDraft[] {
  const file = readExplicitIntakeFile(filePath, options);
  const proposal = createDraftProposalFromText(file.content, "file", file.sourceLabel);
  return insertDraftProposals([proposal], options);
}

export function listPendingDrafts(options: HermesRuntimeOptions = {}): MemoryDraft[] {
  const db = openExistingDb(options);
  try {
    return db
      .prepare("SELECT * FROM memory_drafts WHERE status = 'pending' ORDER BY id ASC")
      .all() as MemoryDraft[];
  } finally {
    db.close();
  }
}

export function approveDraft(
  draftId: number,
  options: HermesRuntimeOptions & { approvalNote?: string } = {}
): MemoryEntry {
  const db = openExistingDb(options);
  try {
    const approve = db.transaction(() => {
      const draft = getPendingDraftOrThrow(db, draftId);
      const now = nowIso();

      const memoryInfo = db
        .prepare(
          `INSERT INTO memory_entries (
            created_at,
            updated_at,
            source_type,
            source_label,
            category,
            content,
            tags_json,
            confidence,
            status,
            supersedes_id,
            deleted_at,
            approval_note
          ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'approved', NULL, NULL, ?)`
        )
        .run(
          now,
          draft.source_type,
          draft.source_label,
          draft.proposed_category,
          draft.proposed_content,
          draft.proposed_tags_json,
          draft.proposed_confidence,
          options.approvalNote ?? null
        );

      const memoryId = Number(memoryInfo.lastInsertRowid);
      db.prepare("UPDATE memory_drafts SET status = 'approved', review_note = ? WHERE id = ?").run(
        options.approvalNote ?? null,
        draftId
      );

      insertEvent(db, {
        memory_id: memoryId,
        draft_id: draftId,
        event_type: "memory_created",
        created_at: now,
        details: { sourceType: draft.source_type, sourceLabel: draft.source_label }
      });
      insertEvent(db, {
        memory_id: memoryId,
        draft_id: draftId,
        event_type: "draft_approved",
        created_at: now,
        details: { approvalNote: options.approvalNote ?? null }
      });

      return getMemoryByIdOrThrow(db, memoryId);
    });

    return approve();
  } finally {
    db.close();
  }
}

export function rejectDraft(
  draftId: number,
  options: HermesRuntimeOptions & { note?: string } = {}
): MemoryDraft {
  const db = openExistingDb(options);
  try {
    const reject = db.transaction(() => {
      getPendingDraftOrThrow(db, draftId);
      db.prepare("UPDATE memory_drafts SET status = 'rejected', review_note = ? WHERE id = ?").run(
        options.note ?? null,
        draftId
      );
      insertEvent(db, {
        draft_id: draftId,
        event_type: "draft_rejected",
        details: { note: options.note ?? null }
      });
      return getDraftByIdOrThrow(db, draftId);
    });

    return reject();
  } finally {
    db.close();
  }
}

export function listApprovedMemories(options: HermesRuntimeOptions = {}): MemoryEntry[] {
  const db = openExistingDb(options);
  try {
    return db
      .prepare(
        "SELECT * FROM memory_entries WHERE status = 'approved' AND deleted_at IS NULL ORDER BY id ASC"
      )
      .all() as MemoryEntry[];
  } finally {
    db.close();
  }
}

export function searchApprovedMemories(
  query: string,
  options: HermesRuntimeOptions & { limit?: number } = {}
): SearchResult[] {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error("Search query is required.");
  }

  const db = openExistingDb(options);
  try {
    const like = `%${escapeLike(normalized)}%`;
    const rows = db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE status = 'approved'
           AND deleted_at IS NULL
           AND (
             content LIKE ? ESCAPE '\\'
             OR category LIKE ? ESCAPE '\\'
             OR tags_json LIKE ? ESCAPE '\\'
             OR source_type LIKE ? ESCAPE '\\'
             OR source_label LIKE ? ESCAPE '\\'
           )
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(like, like, like, like, like, options.limit ?? 20) as MemoryEntry[];

    return rows.map((memory) => ({ memory, snippet: makeSnippet(memory.content, normalized) }));
  } finally {
    db.close();
  }
}

export function reflectOnApprovedMemory(
  question: string,
  options: HermesRuntimeOptions = {}
): ReflectionReport {
  const normalized = question.trim();
  if (!normalized) {
    throw new Error("Reflection question is required.");
  }

  const relevant = retrieveRelevantApprovedMemories(normalized, options).slice(0, 5);
  const categories = countValues(relevant.map(({ memory }) => memory.category));
  const tags = countValues(
    relevant.flatMap(({ memory }) => parseTags(memory.tags_json)).filter((tag) => tag.length > 0)
  );

  const patternSummary: string[] = [];
  if (relevant.length === 0) {
    patternSummary.push("No approved local memories matched this question.");
  } else {
    patternSummary.push(`Relevant approved memories found: ${relevant.length}.`);
    patternSummary.push(`Categories represented: ${formatCounts(categories)}.`);
    if (tags.size > 0) {
      patternSummary.push(`Common tags: ${formatCounts(tags)}.`);
    }
  }

  return {
    question: normalized,
    relevantMemoryIds: relevant.map(({ memory }) => memory.id),
    relevantSnippets: relevant.map(({ memory, snippet }) => ({ id: memory.id, snippet })),
    patternSummary,
    basisNote: BASIS_NOTE
  };
}

export function exportApprovedMemories(options: HermesRuntimeOptions = {}): string {
  const paths = resolveHermesPaths(options);
  const db = openExistingDb(options);
  try {
    fs.mkdirSync(paths.exportDir, { recursive: true });
    const approvedMemories = db
      .prepare(
        "SELECT * FROM memory_entries WHERE status = 'approved' AND deleted_at IS NULL ORDER BY id ASC"
      )
      .all() as MemoryEntry[];
    const events = db.prepare("SELECT * FROM memory_events ORDER BY event_id ASC").all() as MemoryEvent[];

    const exportPath = path.join(paths.exportDir, "memories-export.json");
    fs.writeFileSync(
      exportPath,
      `${JSON.stringify(
        {
          generated_at: nowIso(),
          approved_memories: approvedMemories,
          memory_events: events
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    insertEvent(db, {
      event_type: "approved_memory_exported",
      details: { exportPath, approvedMemoryCount: approvedMemories.length }
    });

    return exportPath;
  } finally {
    db.close();
  }
}

export function doctor(options: HermesRuntimeOptions = {}): DoctorReport {
  const paths = resolveHermesPaths(options);
  const dbExists = fs.existsSync(paths.dbPath);

  if (!dbExists) {
    return {
      dbPath: paths.dbPath,
      dbExists: false,
      tables: Object.fromEntries(TABLES.map((table) => [table, false])),
      pendingDraftCount: 0,
      approvedMemoryCount: 0,
      externalConnectorsConfigured: false,
      toolsConfigured: false
    };
  }

  const db = openDatabase(options, "existing");
  try {
    const tables = Object.fromEntries(TABLES.map((table) => [table, tableExists(db, table)]));
    const pendingDraftCount = tables.memory_drafts
      ? countSingle(db, "SELECT COUNT(*) AS count FROM memory_drafts WHERE status = 'pending'")
      : 0;
    const approvedMemoryCount = tables.memory_entries
      ? countSingle(
          db,
          "SELECT COUNT(*) AS count FROM memory_entries WHERE status = 'approved' AND deleted_at IS NULL"
        )
      : 0;

    return {
      dbPath: paths.dbPath,
      dbExists: true,
      tables,
      pendingDraftCount,
      approvedMemoryCount,
      externalConnectorsConfigured: false,
      toolsConfigured: false
    };
  } finally {
    db.close();
  }
}

export function listMemoryEvents(options: HermesRuntimeOptions = {}): MemoryEvent[] {
  const db = openExistingDb(options);
  try {
    return db.prepare("SELECT * FROM memory_events ORDER BY event_id ASC").all() as MemoryEvent[];
  } finally {
    db.close();
  }
}

export function retrieveRelevantApprovedMemories(
  question: string,
  options: HermesRuntimeOptions & { limit?: number } = {}
): SearchResult[] {
  const terms = extractSearchTerms(question);
  if (terms.length === 0) {
    return [];
  }

  const memories = listApprovedMemories(options);
  const scored = memories
    .map((memory) => {
      const haystack = [
        memory.content,
        memory.category,
        memory.tags_json,
        memory.source_type,
        memory.source_label
      ]
        .join(" ")
        .toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return {
        memory,
        score,
        snippet: makeSnippet(memory.content, terms.find((term) => haystack.includes(term)) ?? question)
      };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.memory.id - b.memory.id)
    .slice(0, options.limit ?? 5);

  return scored.map(({ memory, snippet }) => ({ memory, snippet }));
}

function insertDraftProposals(
  proposals: DraftProposal[],
  options: HermesRuntimeOptions = {}
): MemoryDraft[] {
  const db = openExistingDb(options);
  try {
    const insert = db.transaction(() => {
      const drafts: MemoryDraft[] = [];
      for (const proposal of proposals) {
        const now = nowIso();
        const info = db
          .prepare(
            `INSERT INTO memory_drafts (
              created_at,
              source_type,
              source_label,
              proposed_category,
              proposed_content,
              proposed_tags_json,
              proposed_confidence,
              status,
              review_note
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`
          )
          .run(
            now,
            proposal.source_type,
            proposal.source_label,
            proposal.proposed_category,
            proposal.proposed_content,
            proposal.proposed_tags_json,
            proposal.proposed_confidence
          );
        const draftId = Number(info.lastInsertRowid);
        insertEvent(db, {
          draft_id: draftId,
          event_type: "draft_created",
          created_at: now,
          details: {
            sourceType: proposal.source_type,
            sourceLabel: proposal.source_label,
            category: proposal.proposed_category
          }
        });
        drafts.push(getDraftByIdOrThrow(db, draftId));
      }
      return drafts;
    });
    return insert();
  } finally {
    db.close();
  }
}

function extractSearchTerms(question: string): string[] {
  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !REFLECTION_STOPWORDS.has(term));
  return Array.from(new Set(terms));
}

function getPendingDraftOrThrow(db: Database.Database, draftId: number): MemoryDraft {
  const draft = db
    .prepare("SELECT * FROM memory_drafts WHERE id = ? AND status = 'pending'")
    .get(draftId) as MemoryDraft | undefined;
  if (!draft) {
    throw new Error(`Pending draft ${draftId} was not found.`);
  }
  return draft;
}

function getDraftByIdOrThrow(db: Database.Database, draftId: number): MemoryDraft {
  const draft = db.prepare("SELECT * FROM memory_drafts WHERE id = ?").get(draftId) as
    | MemoryDraft
    | undefined;
  if (!draft) {
    throw new Error(`Draft ${draftId} was not found.`);
  }
  return draft;
}

function getMemoryByIdOrThrow(db: Database.Database, memoryId: number): MemoryEntry {
  const memory = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(memoryId) as
    | MemoryEntry
    | undefined;
  if (!memory) {
    throw new Error(`Memory ${memoryId} was not found.`);
  }
  return memory;
}

function insertEvent(
  db: Database.Database,
  event: {
    memory_id?: number | null;
    draft_id?: number | null;
    event_type: string;
    created_at?: string;
    details?: unknown;
  }
): void {
  db.prepare(
    `INSERT INTO memory_events (
      memory_id,
      draft_id,
      event_type,
      created_at,
      details_json
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(
    event.memory_id ?? null,
    event.draft_id ?? null,
    event.event_type,
    event.created_at ?? nowIso(),
    JSON.stringify(event.details ?? {})
  );
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

function countSingle(db: Database.Database, sql: string): number {
  const row = db.prepare(sql).get() as { count: number };
  return row.count;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function makeSnippet(content: string, query: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  const lowered = compact.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const index = lowered.indexOf(loweredQuery);
  if (index === -1) {
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
  }

  const start = Math.max(0, index - 50);
  const end = Math.min(compact.length, index + loweredQuery.length + 90);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => `${value} (${count})`)
    .join(", ");
}

function nowIso(): string {
  return new Date().toISOString();
}
