import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase, tableExists, TABLES } from "./db.js";
import { createDraftFromProposal, listApprovedMemories, listPendingDrafts } from "./hermes.js";
import { detectCategory, detectTags } from "./draftGeneration.js";
import { resolveChatModeConfig } from "./llm/chatMode.js";
import { AnthropicChatProvider } from "./llm/anthropicChatProvider.js";
import type {
  ChatProvider,
  DraftProposal,
  HermesRuntimeOptions,
  MemoryDraft,
  Source,
  SourceChunk,
  SourceChunkResult,
  SourceExtractionDiagnostics,
  SourceMemoryCandidate,
  SourceSuggestionResult,
  SourceSummary
} from "./types.js";

export const MAX_SOURCE_BYTES = 1_000_000;
const ALLOWED_EXTENSIONS = [".md", ".markdown", ".txt"] as const;
const TARGET_CHUNK_CHARS = 1000;
const MAX_CHUNK_CHARS = 1500;
const MIN_CHUNK_CHARS = 80;

const DEFAULT_SUGGESTION_LIMIT = 7;
const MIN_SUGGESTION_LIMIT = 1;
const MAX_SUGGESTION_LIMIT = 10;
const MIN_STATEMENT_CHARS = 40;
const MAX_STATEMENT_CHARS = 320;
const MIN_STATEMENT_WORDS = 6;

// Full-source extraction budget: chunks are batched so a single provider call
// stays within a safe input size; larger sources are processed map-reduce style.
export const MAX_BATCH_CHARS = 24_000;
const MIN_CANDIDATE_CHARS = 20;
const MIN_CANDIDATE_WORDS = 4;
const NEAR_DUPLICATE_JACCARD = 0.8;
const MAX_EXISTING_MEMORIES_TO_PROVIDER = 60;

// Lines that describe the document itself rather than durable personal context.
const METADATA_KEYS = new Set([
  "title",
  "subtitle",
  "purpose",
  "created",
  "date",
  "updated",
  "author",
  "filename",
  "file",
  "source",
  "version",
  "status",
  "tags",
  "category",
  "type",
  "name",
  "id"
]);

// Signals that a sentence states something durable worth remembering.
const DURABLE_SIGNALS: RegExp[] = [
  /\bprefer(?:s|red|ence)?\b/i,
  /\bi (?:always|never|like|love|want|need|believe|value|tend|aim|try|focus|care|hold|keep)\b/i,
  /\bmy (?:goal|approach|workflow|principle|philosophy|thesis|preference|routine|style|process|plan|practice|rule)\b/i,
  /\b(?:always|never|consistently|routinely|by default)\b/i,
  /\b(?:decided|decision|committed|chose|settled|standard|rule|principle)\b/i,
  /\bproject\b/i,
  /\b(?:philosophy|value|values|belief|thesis|approach|mindset|identity)\b/i,
  /\b(?:bitcoin|finance|financial|investing|investment|money|wealth)\b/i,
  /\b(?:training|health|fitness|workout|exercise|diet|nutrition|sleep)\b/i,
  /\b(?:should|must|need to|have to|ought to)\b/i,
  /\b(?:workflow|storyboard|prompt|seedance|video|render|footage)\b/i,
  /\b(?:don't|do not|avoid|refuse)\b/i,
  /\b(?:ai|coding|engineering|software)\b/i
];

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

interface ExtractionOutcome {
  candidates: SourceMemoryCandidate[];
  mode: "provider" | "deterministic";
  chunksSentToProvider: number;
  approxCharsSent: number;
  batchCount: number;
  providerReturnedCount: number;
  duplicatesSkippedCount: number;
}

/**
 * "Suggest context from this source" is a full-source extraction workflow: it
 * reviews every excerpt (not a chat-style top-N retrieval), avoids repeating
 * context the user already approved or has pending, and returns up to the
 * requested number of strong, source-grounded suggestions for human review.
 */
export async function suggestMemoriesFromSource(
  sourceId: number,
  options: HermesRuntimeOptions & { limit?: number } = {}
): Promise<SourceSuggestionResult> {
  const summary = getSource(sourceId, options);
  if (!summary) {
    throw new Error(`Source ${sourceId} was not found.`);
  }

  const chunks = getSourceChunks(sourceId, options);
  const limit = clampSuggestionLimit(options.limit);
  const existingMemories = collectExistingMemoryTexts(options);

  const outcome = await extractFullSourceMemories(summary, chunks, limit, existingMemories, options);

  const sourceLabel = `source #${summary.id}: ${summary.title}`;
  const drafts = outcome.candidates.map((candidate) =>
    createDraftFromProposal(buildProposalFromCandidate(candidate, sourceLabel), options)
  );

  const totalCharCount = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
  const diagnostics: SourceExtractionDiagnostics = {
    sourceId: summary.id,
    sourceTitle: summary.title,
    sourceChunkCount: chunks.length,
    totalCharCount,
    chunksSentToProvider: outcome.chunksSentToProvider,
    approxCharsSent: outcome.approxCharsSent,
    batchCount: outcome.batchCount,
    requestedCount: limit,
    providerReturnedCount: outcome.providerReturnedCount,
    duplicatesSkippedCount: outcome.duplicatesSkippedCount,
    finalSuggestionCount: drafts.length,
    mode: outcome.mode
  };
  logExtractionDiagnostics(diagnostics);

  return { drafts, diagnostics };
}

function clampSuggestionLimit(limit: number | undefined): number {
  const requested = Number.isInteger(limit) ? (limit as number) : DEFAULT_SUGGESTION_LIMIT;
  return Math.min(MAX_SUGGESTION_LIMIT, Math.max(MIN_SUGGESTION_LIMIT, requested));
}

function collectExistingMemoryTexts(options: HermesRuntimeOptions): string[] {
  const approved = listApprovedMemories(options).map((memory) => memory.content);
  const pending = listPendingDrafts(options).map((draft) => draft.proposed_content);
  return [...approved, ...pending].map((text) => text.trim()).filter(Boolean);
}

async function extractFullSourceMemories(
  summary: SourceSummary,
  chunks: SourceChunk[],
  limit: number,
  existingMemories: string[],
  options: HermesRuntimeOptions
): Promise<ExtractionOutcome> {
  const provider = resolveSourceExtractionProvider(options);
  if (provider?.extractSourceMemories) {
    try {
      return await extractWithProvider(provider, summary, chunks, limit, existingMemories);
    } catch {
      // A genuine provider failure (network/parse/HTTP) falls back to deterministic
      // extraction below. A successful-but-empty provider result does NOT fall back.
    }
  }

  // Pull extra deterministic candidates so dedupe/ranking has material to work with.
  const rawDeterministic = extractDeterministicSourceMemories(chunks, limit * 3);
  const { kept, duplicatesSkipped } = finalizeCandidates(rawDeterministic, limit, existingMemories);
  return {
    candidates: kept,
    mode: "deterministic",
    chunksSentToProvider: 0,
    approxCharsSent: 0,
    batchCount: 0,
    providerReturnedCount: 0,
    duplicatesSkippedCount: duplicatesSkipped
  };
}

async function extractWithProvider(
  provider: ChatProvider,
  summary: SourceSummary,
  chunks: SourceChunk[],
  limit: number,
  existingMemories: string[]
): Promise<ExtractionOutcome> {
  const batches = batchChunks(chunks, MAX_BATCH_CHARS);
  const raw: SourceMemoryCandidate[] = [];
  let chunksSentToProvider = 0;
  let approxCharsSent = 0;

  for (const batch of batches) {
    chunksSentToProvider += batch.length;
    approxCharsSent += batch.reduce((sum, chunk) => sum + chunk.content.length, 0);
    const result = await provider.extractSourceMemories!({
      sourceId: summary.id,
      sourceTitle: summary.title,
      chunks: batch.map((chunk) => ({ chunkIndex: chunk.chunk_index, content: chunk.content })),
      limit,
      existingMemories: existingMemories.slice(0, MAX_EXISTING_MEMORIES_TO_PROVIDER)
    });
    if (Array.isArray(result)) {
      raw.push(...result);
    }
  }

  const { kept, duplicatesSkipped } = finalizeCandidates(raw, limit, existingMemories);
  return {
    candidates: kept,
    mode: "provider",
    chunksSentToProvider,
    approxCharsSent,
    batchCount: batches.length,
    providerReturnedCount: raw.length,
    duplicatesSkippedCount: duplicatesSkipped
  };
}

// Group chunks into batches that stay under the char budget while preserving source order.
function batchChunks(chunks: SourceChunk[], maxChars: number): SourceChunk[][] {
  const batches: SourceChunk[][] = [];
  let current: SourceChunk[] = [];
  let currentChars = 0;

  for (const chunk of chunks) {
    const chunkChars = chunk.content.length;
    if (current.length > 0 && currentChars + chunkChars > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(chunk);
    currentChars += chunkChars;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/**
 * Validate, deduplicate (against each other AND existing approved/pending
 * memories), rank by durable-signal strength, and slice to the requested count.
 */
function finalizeCandidates(
  rawCandidates: SourceMemoryCandidate[],
  limit: number,
  existingMemories: string[]
): { kept: SourceMemoryCandidate[]; duplicatesSkipped: number } {
  const existingNormalized = existingMemories.map(normalizeForCompare).filter(Boolean);
  const keptNormalized: string[] = [];
  const scored: Array<{ candidate: SourceMemoryCandidate; score: number; order: number }> = [];
  let duplicatesSkipped = 0;
  let order = 0;

  for (const raw of rawCandidates) {
    const content = (raw?.content ?? "").replace(/\s+/g, " ").trim();
    if (!content || !isValidCandidateContent(content)) {
      continue;
    }
    const normalized = normalizeForCompare(content);
    if (isNearDuplicate(normalized, existingNormalized) || isNearDuplicate(normalized, keptNormalized)) {
      duplicatesSkipped += 1;
      continue;
    }
    keptNormalized.push(normalized);
    const chunkOrder = candidateOrder(raw.chunkIndexes, order);
    scored.push({ candidate: sanitizeCandidate(content, raw), score: scoreDurableStatement(content), order: chunkOrder });
    order += 1;
  }

  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return { kept: scored.slice(0, limit).map((entry) => entry.candidate), duplicatesSkipped };
}

function candidateOrder(chunkIndexes: number[] | undefined, fallback: number): number {
  if (Array.isArray(chunkIndexes)) {
    const valid = chunkIndexes.filter((index) => Number.isInteger(index) && index >= 0);
    if (valid.length > 0) {
      return Math.min(...valid);
    }
  }
  return fallback;
}

function isValidCandidateContent(content: string): boolean {
  if (content.length < MIN_CANDIDATE_CHARS) {
    return false;
  }
  if (wordCount(content) < MIN_CANDIDATE_WORDS) {
    return false;
  }
  // Reject metadata-only or heading-only lines that are not durable memories.
  if (isMetadataLine(content)) {
    return false;
  }
  return true;
}

function sanitizeCandidate(content: string, raw: SourceMemoryCandidate): SourceMemoryCandidate {
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    : [];
  const chunkIndexes = Array.isArray(raw.chunkIndexes)
    ? raw.chunkIndexes.filter((index): index is number => Number.isInteger(index) && index >= 0)
    : undefined;
  return {
    content,
    category: typeof raw.category === "string" ? raw.category.trim() : "",
    tags,
    rationale: typeof raw.rationale === "string" ? raw.rationale.trim() : undefined,
    chunkIndexes
  };
}

function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNearDuplicate(normalized: string, others: string[]): boolean {
  if (!normalized) {
    return false;
  }
  const tokens = new Set(normalized.split(" ").filter(Boolean));
  for (const other of others) {
    if (!other) {
      continue;
    }
    if (other === normalized || other.includes(normalized) || normalized.includes(other)) {
      return true;
    }
    const otherTokens = new Set(other.split(" ").filter(Boolean));
    if (jaccardSimilarity(tokens, otherTokens) >= NEAR_DUPLICATE_JACCARD) {
      return true;
    }
  }
  return false;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function logExtractionDiagnostics(diagnostics: SourceExtractionDiagnostics): void {
  if (!process.env.HERMES_DEBUG_EXTRACTION) {
    return;
  }
  // Counts and the source title only — never source body content or the API key.
  const safe = {
    sourceId: diagnostics.sourceId,
    title: diagnostics.sourceTitle,
    chunks: diagnostics.sourceChunkCount,
    totalChars: diagnostics.totalCharCount,
    chunksSent: diagnostics.chunksSentToProvider,
    approxCharsSent: diagnostics.approxCharsSent,
    batches: diagnostics.batchCount,
    requested: diagnostics.requestedCount,
    providerReturned: diagnostics.providerReturnedCount,
    duplicatesSkipped: diagnostics.duplicatesSkippedCount,
    final: diagnostics.finalSuggestionCount,
    mode: diagnostics.mode
  };
  process.stderr.write(`[hermes:extraction] ${JSON.stringify(safe)}\n`);
}

function resolveSourceExtractionProvider(options: HermesRuntimeOptions): ChatProvider | undefined {
  if (options.chatProvider) {
    return options.chatProvider;
  }
  const config = resolveChatModeConfig();
  if (config.id === "anthropic" && config.apiKey) {
    return new AnthropicChatProvider({ apiKey: config.apiKey, model: config.model });
  }
  return undefined;
}

export function extractDeterministicSourceMemories(
  chunks: SourceChunk[],
  limit: number
): SourceMemoryCandidate[] {
  const seen = new Set<string>();
  const scored: Array<{ content: string; score: number; chunkIndex: number }> = [];

  for (const chunk of chunks) {
    for (const statement of extractStatements(chunk.content)) {
      const key = statement.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      const score = scoreDurableStatement(statement);
      if (score <= 0) {
        continue;
      }
      seen.add(key);
      scored.push({ content: statement, score, chunkIndex: chunk.chunk_index });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex);
  return scored.slice(0, limit).map(({ content, chunkIndex }) => ({
    content,
    category: detectCategory(content),
    tags: detectTags(content),
    chunkIndexes: [chunkIndex]
  }));
}

function extractStatements(content: string): string[] {
  const statements: string[] = [];
  for (const rawLine of content.split(/\n/)) {
    const line = stripListMarkers(rawLine.trim());
    if (!line || isMetadataLine(line)) {
      continue;
    }
    for (const piece of line.split(/(?<=[.!?])\s+/)) {
      const statement = toCompleteStatement(piece);
      if (statement) {
        statements.push(statement);
      }
    }
  }
  return statements;
}

function stripListMarkers(line: string): string {
  return line.replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s+)/, "").trim();
}

function isMetadataLine(line: string): boolean {
  const stripped = line.replace(/^#{1,6}\s*/, "").replace(/^\*+|\*+$/g, "").replace(/^_+|_+$/g, "").trim();
  if (!stripped) {
    return true;
  }
  if (/^#{1,6}\s/.test(line) || /^[-*_=]{3,}$/.test(line)) {
    return true;
  }

  const letters = stripped.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && stripped === stripped.toUpperCase() && !/[.!?]$/.test(stripped)) {
    // All-caps heading such as "MASTER IDENTITY DOCUMENT".
    return true;
  }

  const keyValue = /^([A-Za-z][\w /-]{0,24}):\s*(.*)$/.exec(stripped);
  if (keyValue) {
    const key = (keyValue[1] ?? "").trim().toLowerCase();
    const value = (keyValue[2] ?? "").trim();
    if (METADATA_KEYS.has(key)) {
      return true;
    }
    // Short "Label: value" fragments (e.g. "Dynamics: Not tribal.") are not standalone memories.
    if (wordCount(value) < MIN_STATEMENT_WORDS) {
      return true;
    }
  }
  return false;
}

function toCompleteStatement(piece: string): string | undefined {
  const normalized = piece.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  // Must begin like a sentence (capital letter or opening quote), not mid-word fragments.
  if (!/^[A-Z"'“]/.test(normalized)) {
    return undefined;
  }
  if (wordCount(normalized) < MIN_STATEMENT_WORDS) {
    return undefined;
  }
  if (normalized.length < MIN_STATEMENT_CHARS || normalized.length > MAX_STATEMENT_CHARS) {
    return undefined;
  }
  // Must read as a finished sentence rather than a clipped excerpt.
  if (!/[.!?]["'”)\]]?$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function scoreDurableStatement(statement: string): number {
  return DURABLE_SIGNALS.reduce((sum, pattern) => sum + (pattern.test(statement) ? 1 : 0), 0);
}

function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function buildProposalFromCandidate(
  candidate: SourceMemoryCandidate,
  sourceLabel: string
): DraftProposal {
  const content = candidate.content.trim();
  const category = candidate.category?.trim() || detectCategory(content);
  const tags = candidate.tags.length > 0 ? candidate.tags : detectTags(content);
  const excerptLabel =
    candidate.chunkIndexes && candidate.chunkIndexes.length > 0
      ? ` (excerpt ${candidate.chunkIndexes.map((index) => index + 1).join(", ")})`
      : "";
  return {
    source_type: "source",
    source_label: `${sourceLabel}${excerptLabel}`,
    proposed_category: category,
    proposed_content: content,
    proposed_tags_json: JSON.stringify(tags.slice(0, 12)),
    proposed_confidence: "medium"
  };
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
