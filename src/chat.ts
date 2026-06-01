import type Database from "better-sqlite3";
import { openDatabase, tableExists, TABLES } from "./db.js";
import { createDraftFromText, retrieveRelevantApprovedMemories } from "./hermes.js";
import type {
  ChatMessage,
  ChatResponse,
  ChatSession,
  ChatTurn,
  HermesRuntimeOptions,
  IdeaCandidate,
  MemoryDraft,
  SearchResult
} from "./types.js";

const IDEA_PROMPT_RE =
  /\b(ideas?|possibilit(?:y|ies)|directions?|creative sparks?|project ideas?|content ideas?)\b|what does this make you think of/i;

const CHAT_STOPWORDS = new Set([
  "about",
  "and",
  "could",
  "does",
  "for",
  "give",
  "have",
  "ideas",
  "make",
  "me",
  "need",
  "please",
  "possibilities",
  "project",
  "should",
  "some",
  "that",
  "the",
  "this",
  "think",
  "what",
  "when",
  "where",
  "with",
  "would",
  "you"
]);

const IDEA_TEMPLATES = [
  {
    title: "Tiny brief",
    artifact: "a six-line brief with goal, audience, constraint, tone, shape, and open question"
  },
  {
    title: "Direction map",
    artifact: "three named directions with one sentence of promise and one sentence of risk"
  },
  {
    title: "Proof sketch",
    artifact: "a one-paragraph sketch that proves the idea has a real center"
  },
  {
    title: "Constraint checklist",
    artifact: "a five-item checklist that keeps the idea aligned with what already matters"
  },
  {
    title: "Approval note",
    artifact: "a short note naming what should be kept, changed, and decided next"
  }
] as const;

export function createChatSession(options: HermesRuntimeOptions = {}, title?: string): ChatSession {
  const db = openExistingChatDb(options);
  try {
    return insertChatSession(db, title ?? null);
  } finally {
    db.close();
  }
}

export function sendChatMessage(
  userInput: string,
  options: HermesRuntimeOptions & { sessionId?: number } = {}
): ChatTurn {
  const normalized = userInput.trim();
  if (!normalized) {
    throw new Error("Chat message is required.");
  }

  const memoriesUsed = retrieveRelevantApprovedMemories(normalized, { ...options, limit: 5 });
  const response = createChatResponse(normalized, memoriesUsed);
  const renderedResponse = formatChatResponse(response);
  const memoryIds = memoriesUsed.map(({ memory }) => memory.id);

  const db = openExistingChatDb(options);
  try {
    const insert = db.transaction(() => {
      const session = options.sessionId
        ? getChatSessionByIdOrThrow(db, options.sessionId)
        : insertChatSession(db, makeSessionTitle(normalized));
      const now = nowIso();
      const userMessage = insertChatMessage(db, {
        sessionId: session.id,
        createdAt: now,
        role: "user",
        content: normalized,
        memoryIds: []
      });
      const hermesMessage = insertChatMessage(db, {
        sessionId: session.id,
        createdAt: now,
        role: "hermes",
        content: renderedResponse,
        memoryIds
      });
      db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(now, session.id);
      return {
        session: getChatSessionByIdOrThrow(db, session.id),
        userMessage,
        hermesMessage,
        response
      };
    });

    return insert();
  } finally {
    db.close();
  }
}

export function createChatResponse(userInput: string, memoriesUsed: SearchResult[]): ChatResponse {
  const normalized = userInput.trim();
  if (!normalized) {
    throw new Error("Chat message is required.");
  }

  if (isIdeaModePrompt(normalized)) {
    const ideaCandidates = buildIdeaCandidates(normalized, memoriesUsed);
    return {
      mode: "idea",
      body: formatIdeaBody(memoriesUsed, ideaCandidates),
      memoriesUsed,
      ideaCandidates
    };
  }

  return {
    mode: "reflection",
    body: formatReflectionBody(normalized, memoriesUsed),
    memoriesUsed,
    ideaCandidates: []
  };
}

export function isIdeaModePrompt(input: string): boolean {
  return IDEA_PROMPT_RE.test(input);
}

export function formatChatResponse(response: ChatResponse): string {
  return [response.body, formatMemoriesUsed(response.memoriesUsed)].join("\n\n");
}

export function formatMemoriesUsed(memoriesUsed: SearchResult[]): string {
  if (memoriesUsed.length === 0) {
    return "Memories used:\n- none";
  }

  return [
    "Memories used:",
    ...memoriesUsed.map(({ memory, snippet }) => `- [${memory.id}] ${compactText(snippet, 140)}`)
  ].join("\n");
}

export function saveLatestChatExchangeDraft(
  sessionId: number,
  options: HermesRuntimeOptions = {}
): MemoryDraft {
  const db = openExistingChatDb(options);
  let userMessage: ChatMessage | undefined;
  let hermesMessage: ChatMessage | undefined;

  try {
    hermesMessage = db
      .prepare("SELECT * FROM chat_messages WHERE session_id = ? AND role = 'hermes' ORDER BY id DESC LIMIT 1")
      .get(sessionId) as ChatMessage | undefined;

    if (!hermesMessage) {
      throw new Error("No HERmes response is available to save as a draft.");
    }

    userMessage = db
      .prepare(
        "SELECT * FROM chat_messages WHERE session_id = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT 1"
      )
      .get(sessionId, hermesMessage.id) as ChatMessage | undefined;

    if (!userMessage) {
      throw new Error("No user message is available to save as a draft.");
    }
  } finally {
    db.close();
  }

  const draftContent = [
    "User:",
    userMessage.content,
    "",
    "HERmes:",
    hermesMessage.content
  ].join("\n");
  return createDraftFromText(draftContent, "chat", `chat_session:${sessionId}`, options);
}

export function listChatMessages(
  sessionId: number,
  options: HermesRuntimeOptions = {}
): ChatMessage[] {
  const db = openExistingChatDb(options);
  try {
    return db
      .prepare("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as ChatMessage[];
  } finally {
    db.close();
  }
}

export function listChatSessions(options: HermesRuntimeOptions = {}): ChatSession[] {
  const db = openExistingChatDb(options);
  try {
    return db.prepare("SELECT * FROM chat_sessions ORDER BY id ASC").all() as ChatSession[];
  } finally {
    db.close();
  }
}

function formatReflectionBody(userInput: string, memoriesUsed: SearchResult[]): string {
  if (memoriesUsed.length === 0) {
    return [
      "I do not have an approved memory that matches this yet, so I am mirroring only the message in front of me.",
      `What I hear: ${compactText(userInput, 220)}`,
      "Smallest useful next move: name the decision, artifact, or question you want this to turn into."
    ].join("\n");
  }

  const ids = memoriesUsed.map(({ memory }) => memory.id).join(", ");
  const categories = summarizeUnique(memoriesUsed.map(({ memory }) => readableLabel(memory.category)));
  const tags = summarizeUnique(memoriesUsed.flatMap(({ memory }) => parseTags(memory.tags_json)));
  const strongest = memoriesUsed[0];
  const anchor = strongest ? compactText(strongest.snippet, 180) : compactText(userInput, 180);
  const tagLine = tags ? ` Tags that recur here: ${tags}.` : "";

  return [
    `I found ${memoriesUsed.length} approved memor${memoriesUsed.length === 1 ? "y" : "ies"} that seem relevant: ${ids}.`,
    `The strongest pattern I can mirror back is ${categories || "a prior note"} anchored by: ${anchor}.${tagLine}`,
    `Applied to your message, I would keep the next step small and concrete: turn "${compactText(
      userInput,
      120
    )}" into one inspectable note, outline, or decision.`
  ].join("\n");
}

function formatIdeaBody(memoriesUsed: SearchResult[], candidates: IdeaCandidate[]): string {
  const opening =
    memoriesUsed.length === 0
      ? "I do not have an approved memory that matches this yet, so these ideas come only from your current message."
      : `Here are ${candidates.length} deterministic idea candidates grounded in approved memory.`;

  return [
    opening,
    ...candidates.map((candidate, index) =>
      [
        `${index + 1}. ${candidate.title}`,
        `Why it fits: ${candidate.whyItFits}`,
        `Inspired by memories: ${candidate.memoryIds.length > 0 ? candidate.memoryIds.join(", ") : "none"}`,
        `Smallest next artifact: ${candidate.smallestNextArtifact}`
      ].join("\n")
    )
  ].join("\n\n");
}

function buildIdeaCandidates(userInput: string, memoriesUsed: SearchResult[]): IdeaCandidate[] {
  const count = memoriesUsed.length === 0 ? 3 : Math.min(5, Math.max(3, memoriesUsed.length + 1));
  const topic = extractTopic(userInput);
  const candidates: IdeaCandidate[] = [];

  for (let index = 0; index < count; index += 1) {
    const template = IDEA_TEMPLATES[index];
    const memory = memoriesUsed.length > 0 ? memoriesUsed[index % memoriesUsed.length] : undefined;
    const memoryTags = memory ? parseTags(memory.memory.tags_json) : [];
    const anchor = memoryTags[0] ?? (memory ? readableLabel(memory.memory.category) : topic);
    const title = memory
      ? `${template.title}: ${titleCase(topic)} through ${titleCase(anchor)}`
      : `${template.title}: ${titleCase(topic)}`;
    const whyItFits = memory
      ? `Memory [${memory.memory.id}] says ${compactText(memory.snippet, 120)}, giving this idea a known local anchor.`
      : "No approved memory matched, so this is only a tentative spark from the current message.";

    candidates.push({
      title,
      whyItFits,
      memoryIds: memory ? [memory.memory.id] : [],
      smallestNextArtifact: template.artifact
    });
  }

  return candidates;
}

function insertChatSession(db: Database.Database, title: string | null): ChatSession {
  const now = nowIso();
  const info = db
    .prepare("INSERT INTO chat_sessions (created_at, updated_at, title) VALUES (?, ?, ?)")
    .run(now, now, title);
  return getChatSessionByIdOrThrow(db, Number(info.lastInsertRowid));
}

function insertChatMessage(
  db: Database.Database,
  message: {
    sessionId: number;
    createdAt: string;
    role: "user" | "hermes";
    content: string;
    memoryIds: number[];
  }
): ChatMessage {
  const info = db
    .prepare(
      `INSERT INTO chat_messages (
        session_id,
        created_at,
        role,
        content,
        memory_ids_json
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      message.sessionId,
      message.createdAt,
      message.role,
      message.content,
      JSON.stringify(message.memoryIds)
    );
  return getChatMessageByIdOrThrow(db, Number(info.lastInsertRowid));
}

function getChatSessionByIdOrThrow(db: Database.Database, sessionId: number): ChatSession {
  const session = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(sessionId) as
    | ChatSession
    | undefined;
  if (!session) {
    throw new Error(`Chat session ${sessionId} was not found.`);
  }
  return session;
}

function getChatMessageByIdOrThrow(db: Database.Database, messageId: number): ChatMessage {
  const message = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(messageId) as
    | ChatMessage
    | undefined;
  if (!message) {
    throw new Error(`Chat message ${messageId} was not found.`);
  }
  return message;
}

function openExistingChatDb(options: HermesRuntimeOptions): Database.Database {
  const db = openDatabase(options, "existing");
  const missingTable = TABLES.find((table) => !tableExists(db, table));
  if (missingTable) {
    db.close();
    throw new Error(`HERmes database is missing table ${missingTable}. Run "hermes init" first.`);
  }
  return db;
}

function extractTopic(input: string): string {
  const words = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !CHAT_STOPWORDS.has(word));
  return words.slice(0, 3).join(" ") || "this thread";
}

function makeSessionTitle(input: string): string {
  return compactText(input, 64);
}

function compactText(input: string, maxLength: number): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function summarizeUnique(values: string[]): string {
  return Array.from(new Set(values.filter(Boolean))).slice(0, 4).join(", ");
}

function readableLabel(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function nowIso(): string {
  return new Date().toISOString();
}
