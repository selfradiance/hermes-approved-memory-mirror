import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { openDatabase, tableExists, TABLES } from "./db.js";
import { createDraftProposalFromText } from "./draftGeneration.js";
import { createDraftFromText, retrieveRelevantApprovedMemories } from "./hermes.js";
import { retrieveRelevantSourceChunks } from "./sources.js";
import { AnthropicChatProvider } from "./llm/anthropicChatProvider.js";
import { DETERMINISTIC_LABEL, resolveChatModeConfig } from "./llm/chatMode.js";
import type {
  ChatGenerationInput,
  ChatGenerationResult,
  ChatMessage,
  ChatProvider,
  ChatProviderContextMessage,
  ChatProviderId,
  ChatResponse,
  ChatRole,
  ChatSession,
  ChatTurn,
  HermesRuntimeOptions,
  IdeaCandidate,
  MemorySuggestion,
  MemoryDraft,
  SearchResult
} from "./types.js";

const IDEA_PROMPT_RE =
  /\b(ideas?|possibilit(?:y|ies)|directions?|creative sparks?|project ideas?|content ideas?)\b|what does this make you think of/i;

const DIRECT_MEMORY_REQUEST_RE =
  /^(?:please\s+)?(?:remember(?:\s+that)?|save\s+this|save\s+that|add\s+(?:this|that)\s+to\s+memory|add\s+to\s+memory)\s*[:,-]?\s*(.+)$/i;

const MEMORY_INTENT_RE =
  /\b(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:remember|save)\s+(?:this|that|it|all\s+this|it\s+all|everything)\b|\b(?:remember\s+that|add\s+(?:this|that|it|all\s+this|everything)\s+to\s+memory|add\s+to\s+memory)\b/i;

const MEMORY_REQUEST_LINE_RE =
  /^(?:just\s+wondering\b.*?\.\s*)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:(?:remember|save)\s+(?:this|that|it|all\s+this|it\s+all|everything)|add\s+(?:this|that|it|all\s+this|everything)\s+to\s+memory|add\s+to\s+memory)\??(?:\s+(?:for\s+me|please|thank\s+you|thanks))?\.?$/i;

const INLINE_MEMORY_PAYLOAD_RES = [
  /^(?:please\s+)?(?:remember(?:\s+that)?|save\s+(?:this|that|it|all\s+this|everything)|add\s+(?:this|that|it|all\s+this|everything)\s+to\s+memory|add\s+to\s+memory)\s*[:,-]\s*(.+)$/is,
  /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:remember|save)\s+(?:this|that|it|all\s+this|it\s+all|everything)\??\s*[:,-]\s*(.+)$/is,
  /^(?:please\s+)?remember\s+that\s+(.+)$/is
] as const;

const USELESS_MEMORY_PAYLOADS = new Set([
  "this",
  "that",
  "it",
  "all this",
  "it all",
  "everything",
  "remember this",
  "remember that",
  "please remember this",
  "please remember all this",
  "can you remember this",
  "can you remember that",
  "can you remember it",
  "can you remember it all",
  "can you remember all this",
  "could you remember this",
  "would you remember this",
  "save this",
  "save that",
  "please save this",
  "can you save this",
  "add this to memory",
  "add that to memory",
  "add to memory"
]);

const MEMORY_SIGNAL_PATTERNS = [
  /\bi want\b/i,
  /\bi prefer\b/i,
  /\bi don['’]?t want\b/i,
  /\bgoing forward\b/i,
  /\bremember\b/i,
  /\bi['’]?m moving toward\b/i,
  /\bthis is the direction\b/i,
  /\bi['’]?m working on\b/i,
  /\bi decided\b/i,
  /\bi learned\b/i,
  /\bi keep coming back to\b/i,
  /\bthe problem is\b/i,
  /\bwhat matters to me is\b/i,
  /\bi['’]?m trying to\b/i,
  /\bmy goal is\b/i,
  /\bi (?:hate|love|prefer|dislike)\b/i,
  /\b(?:project|workflow|process|system|ritual|routine)\b.+\b(?:should|needs?|works?|uses?|depends?|matters?)\b/i,
  /\b(?:design|product|architecture|implementation) decision\b/i,
  /\b(?:settled|decided) (?:direction|decision|approach)\b/i
] as const;

const GREETING_OR_TINY_RE = /^(?:hi|hello|hey|thanks|thank you|ok|okay|cool|nice|yes|no|yo)\b[!. ]*$/i;
const TEMPORARY_RE =
  /\b(?:today|tonight|tomorrow|this morning|this afternoon|this evening|right now|for now|temporary|just testing|test message)\b/i;
const SYSTEMISH_RE =
  /\b(?:stack trace|debug log|sqlite error|database path|table names?|npm run|node_modules|localhost|127\.0\.0\.1)\b/i;

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

/**
 * Local, offline provider. Its text output is byte-identical to the previous
 * deterministic behavior so existing reflection/idea tests stay valid. It reads
 * memories and chat context but performs no network calls and proposes nothing
 * on its own (memory suggestions still come from the rule-based heuristics).
 */
export class DeterministicChatProvider implements ChatProvider {
  readonly id = "deterministic" as const;
  readonly label = DETERMINISTIC_LABEL;

  async generate(input: ChatGenerationInput): Promise<ChatGenerationResult> {
    const response = createChatResponse(input.userMessage, input.memories);
    return {
      responseText: response.body,
      mode: response.mode,
      ideaCandidates: response.ideaCandidates
    };
  }
}

export function resolveChatProvider(options: HermesRuntimeOptions = {}): ChatProvider {
  if (options.chatProvider) {
    return options.chatProvider;
  }

  const config = resolveChatModeConfig();
  if (config.id === "anthropic" && config.apiKey) {
    return new AnthropicChatProvider({ apiKey: config.apiKey, model: config.model });
  }

  return new DeterministicChatProvider();
}

export async function sendChatMessage(
  userInput: string,
  options: HermesRuntimeOptions & { sessionId?: number } = {}
): Promise<ChatTurn> {
  const normalized = userInput.trim();
  if (!normalized) {
    throw new Error("Chat message is required.");
  }

  const memoriesUsed = retrieveRelevantApprovedMemories(normalized, { ...options, limit: 5 });
  const sourceChunks = retrieveRelevantSourceChunks(normalized, { ...options, limit: 3 });
  const recentMessages = options.sessionId ? gatherRecentContext(options.sessionId, options) : [];
  const generationInput: ChatGenerationInput = {
    userMessage: normalized,
    recentMessages,
    memories: memoriesUsed,
    sourceChunks
  };

  const provider = resolveChatProvider(options);
  const fallbackProvider =
    provider.id === "deterministic" ? provider : new DeterministicChatProvider();

  let providerId: ChatProviderId = provider.id;
  let providerLabel = provider.label;
  let providerError: string | undefined;
  let generation: ChatGenerationResult;
  try {
    generation = await provider.generate(generationInput);
  } catch (error) {
    providerError = sanitizeProviderError(error);
    providerId = fallbackProvider.id;
    providerLabel = fallbackProvider.label;
    generation = await fallbackProvider.generate(generationInput);
  }

  const response: ChatResponse = {
    mode: generation.mode,
    body: generation.responseText,
    memoriesUsed,
    ideaCandidates: generation.ideaCandidates
  };
  const renderedResponse = formatChatResponse(response);
  const memoryIds = memoriesUsed.map(({ memory }) => memory.id);

  const db = openExistingChatDb(options);
  let persistedTurn!: {
    session: ChatSession;
    userMessage: ChatMessage;
    hermesMessage: ChatMessage;
    response: ChatResponse;
  };
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

    persistedTurn = insert();
  } finally {
    db.close();
  }

  const base: ChatTurn = { ...persistedTurn, providerId, providerLabel, providerError };
  const memoryPayload = extractMemoryPayloadFromUserMessage(normalized);

  if (memoryPayload.kind === "payload") {
    const savedDraft = createDraftFromText(
      memoryPayload.payload,
      "chat",
      memorySuggestionSourceLabel(persistedTurn.session.id, persistedTurn.userMessage.id),
      options
    );
    return { ...base, savedDraft };
  }

  if (memoryPayload.kind === "request_without_payload") {
    return { ...base, memoryRequestNeedsPayload: true };
  }

  const proposedFromProvider = generation.proposedMemoryText?.trim();
  const providerSuggestion = proposedFromProvider
    ? createProviderMemorySuggestion(proposedFromProvider, normalized, {
        sessionId: persistedTurn.session.id,
        messageId: persistedTurn.userMessage.id
      })
    : undefined;
  const memorySuggestion =
    providerSuggestion ??
    suggestMemoryFromUserMessage(normalized, {
        sessionId: persistedTurn.session.id,
        messageId: persistedTurn.userMessage.id
      });

  return memorySuggestion ? { ...base, memorySuggestion } : base;
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

export function suggestMemoryFromUserMessage(
  userInput: string,
  context: { sessionId?: number; messageId?: number } = {}
): MemorySuggestion | undefined {
  const normalized = normalizeUserMemoryText(userInput);
  if (!normalized || extractMemoryPayloadFromUserMessage(normalized).kind !== "none") {
    return undefined;
  }

  const candidate = extractDurableMemoryCandidate(normalized);
  if (!candidate) {
    return undefined;
  }

  return createMemorySuggestion(candidate, context);
}

export function extractMemoryPayloadFromUserMessage(
  userInput: string
):
  | { kind: "none" }
  | { kind: "request_without_payload" }
  | { kind: "payload"; payload: string } {
  const normalized = normalizeUserMemoryText(userInput);
  if (!normalized || !MEMORY_INTENT_RE.test(normalized)) {
    return { kind: "none" };
  }

  const paragraphPayload = extractPayloadAfterRequestParagraph(normalized);
  if (paragraphPayload) {
    return { kind: "payload", payload: paragraphPayload };
  }

  const inlinePayload = extractInlineMemoryPayload(normalized);
  if (inlinePayload) {
    return { kind: "payload", payload: inlinePayload };
  }

  const linePayload = extractPayloadAfterRequestLine(normalized);
  if (linePayload) {
    return { kind: "payload", payload: linePayload };
  }

  return { kind: "request_without_payload" };
}

export function getLatestMemorySuggestion(
  sessionId: number,
  options: HermesRuntimeOptions = {}
): MemorySuggestion | undefined {
  const db = openExistingChatDb(options);
  try {
    const latestUserMessage = db
      .prepare("SELECT * FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
      .get(sessionId) as ChatMessage | undefined;
    if (!latestUserMessage) {
      return undefined;
    }

    const suggestion = suggestMemoryFromUserMessage(latestUserMessage.content, {
      sessionId,
      messageId: latestUserMessage.id
    });
    if (!suggestion || isSuggestionDismissed(db, sessionId, latestUserMessage.id, suggestion.suggestionKey)) {
      return undefined;
    }

    return suggestion;
  } finally {
    db.close();
  }
}

export function saveSuggestedMemoryDraft(
  suggestion: {
    proposedContent: string;
    sourceSessionId: number;
    sourceMessageId: number;
    suggestionKey: string;
  },
  options: HermesRuntimeOptions = {}
): MemoryDraft {
  const content = normalizeUserMemoryText(suggestion.proposedContent);
  if (!content) {
    throw new Error("Suggested memory text is required.");
  }

  const sourceMessage = getUserChatMessageOrThrow(
    suggestion.sourceSessionId,
    suggestion.sourceMessageId,
    options
  );
  const guardedContent = guardMemorySuggestionContent(content, sourceMessage.content);
  if (!guardedContent) {
    throw new Error("Suggested memory text needs actual information to remember.");
  }
  const draft = createDraftFromText(
    guardedContent,
    "chat",
    memorySuggestionSourceLabel(suggestion.sourceSessionId, suggestion.sourceMessageId),
    options
  );
  dismissMemorySuggestion(
    suggestion.sourceSessionId,
    suggestion.sourceMessageId,
    suggestion.suggestionKey,
    options
  );
  return draft;
}

export function dismissMemorySuggestion(
  sessionId: number,
  messageId: number,
  suggestionKey: string,
  options: HermesRuntimeOptions = {}
): void {
  const normalizedKey = suggestionKey.trim();
  if (!normalizedKey) {
    throw new Error("Suggestion key is required.");
  }

  const db = openExistingChatDb(options);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO memory_suggestion_dismissals (
        created_at,
        session_id,
        message_id,
        suggestion_key
      ) VALUES (?, ?, ?, ?)`
    ).run(nowIso(), sessionId, messageId, normalizedKey);
  } finally {
    db.close();
  }
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

function extractDurableMemoryCandidate(userInput: string): string | undefined {
  const normalized = normalizeUserMemoryText(userInput);
  if (!normalized || normalized.startsWith("/") || GREETING_OR_TINY_RE.test(normalized)) {
    return undefined;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 5 || normalized.length < 24) {
    return undefined;
  }

  if (TEMPORARY_RE.test(normalized) || SYSTEMISH_RE.test(normalized)) {
    return undefined;
  }

  const durableSentence = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .find((sentence) => MEMORY_SIGNAL_PATTERNS.some((pattern) => pattern.test(sentence)));

  if (!durableSentence) {
    return undefined;
  }

  return stripTrailingCommandTone(durableSentence);
}

function extractPayloadAfterRequestParagraph(userInput: string): string | undefined {
  const paragraphs = userInput
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (paragraphs.length < 2 || !paragraphContainsMemoryRequest(paragraphs[0] ?? "")) {
    return undefined;
  }

  return cleanMemoryPayload(paragraphs.slice(1).join("\n\n"));
}

function extractInlineMemoryPayload(userInput: string): string | undefined {
  for (const pattern of INLINE_MEMORY_PAYLOAD_RES) {
    const match = userInput.match(pattern);
    const payload = match?.[1];
    const cleaned = payload ? cleanMemoryPayload(payload) : undefined;
    if (cleaned) {
      return cleaned;
    }
  }

  const directMatch = userInput.match(DIRECT_MEMORY_REQUEST_RE);
  const directPayload = directMatch?.[1];
  return directPayload ? cleanMemoryPayload(directPayload) : undefined;
}

function extractPayloadAfterRequestLine(userInput: string): string | undefined {
  const lines = userInput
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const requestLineIndex = lines.findIndex((line) => isMemoryRequestOnly(line));
  if (requestLineIndex === -1 || requestLineIndex === lines.length - 1) {
    return undefined;
  }

  return cleanMemoryPayload(lines.slice(requestLineIndex + 1).join("\n"));
}

function createProviderMemorySuggestion(
  proposedContent: string,
  userInput: string,
  context: { sessionId?: number; messageId?: number }
): MemorySuggestion | undefined {
  const guarded = guardMemorySuggestionContent(proposedContent, userInput, { allowEmpty: true });
  return guarded ? createMemorySuggestion(guarded, context) : undefined;
}

function createMemorySuggestion(
  proposedContent: string,
  context: { sessionId?: number; messageId?: number }
): MemorySuggestion {
  const proposal = createDraftProposalFromText(
    proposedContent,
    "chat",
    context.sessionId && context.messageId
      ? memorySuggestionSourceLabel(context.sessionId, context.messageId)
      : "chat_session:pending"
  );

  return {
    proposedContent: proposal.proposed_content,
    suggestedCategory: proposal.proposed_category,
    suggestedTags: parseTags(proposal.proposed_tags_json),
    sourceType: "chat",
    sourceLabel: proposal.source_label,
    sourceSessionId: context.sessionId ?? null,
    sourceMessageId: context.messageId ?? null,
    suggestionKey: makeSuggestionKey(proposal.proposed_content)
  };
}

function memorySuggestionSourceLabel(sessionId: number, messageId: number): string {
  return `chat_session:${sessionId}:message:${messageId}`;
}

function makeSuggestionKey(content: string): string {
  const normalized = normalizeUserMemoryText(content).toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function isSuggestionDismissed(
  db: Database.Database,
  sessionId: number,
  messageId: number,
  suggestionKey: string
): boolean {
  const row = db
    .prepare(
      `SELECT id FROM memory_suggestion_dismissals
       WHERE session_id = ? AND message_id = ? AND suggestion_key = ?
       LIMIT 1`
    )
    .get(sessionId, messageId, suggestionKey);
  return Boolean(row);
}

function guardMemorySuggestionContent(
  proposedContent: string,
  sourceMessageContent: string,
  options: { allowEmpty?: boolean } = {}
): string | undefined {
  const cleaned = cleanMemoryPayload(proposedContent);
  if (cleaned && !isUselessMemoryPayload(cleaned)) {
    return cleaned;
  }

  const sourcePayload = extractMemoryPayloadFromUserMessage(sourceMessageContent);
  if (sourcePayload.kind === "payload") {
    return sourcePayload.payload;
  }

  if (options.allowEmpty) {
    return undefined;
  }
  throw new Error("Suggested memory text needs actual information to remember.");
}

function cleanMemoryPayload(payload: string): string | undefined {
  const normalized = payload
    .replace(/\r\n/g, "\n")
    .replace(/^[\s>:`"'-]+/, "")
    .replace(/[\s`"']+$/, "")
    .replace(/\s+(?:thank you|thanks)\.?$/i, "")
    .trim();
  if (!normalized || isUselessMemoryPayload(normalized)) {
    return undefined;
  }

  return normalizePayloadPerspective(normalized);
}

function isUselessMemoryPayload(value: string): boolean {
  const normalized = normalizeCommandText(value);
  if (!normalized) {
    return true;
  }
  if (USELESS_MEMORY_PAYLOADS.has(normalized)) {
    return true;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length <= 5 && MEMORY_REQUEST_LINE_RE.test(value.trim());
}

function paragraphContainsMemoryRequest(paragraph: string): boolean {
  return MEMORY_INTENT_RE.test(paragraph);
}

function isMemoryRequestOnly(line: string): boolean {
  return MEMORY_REQUEST_LINE_RE.test(line.trim()) || USELESS_MEMORY_PAYLOADS.has(normalizeCommandText(line));
}

function normalizeCommandText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[?.!,;:]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePayloadPerspective(payload: string): string {
  return payload
    .replace(/^I prefer\b/i, "James prefers")
    .replace(/^I don['’]?t want\b/i, "James does not want")
    .replace(/^I want\b/i, "James wants")
    .replace(/^I love\b/i, "James loves")
    .replace(/^I hate\b/i, "James hates")
    .replace(/^I dislike\b/i, "James dislikes")
    .replace(/^My goal is\b/i, "James's goal is")
    .replace(/^I['’]?m working on\b/i, "James is working on")
    .trim();
}

function getUserChatMessageOrThrow(
  sessionId: number,
  messageId: number,
  options: HermesRuntimeOptions
): ChatMessage {
  const db = openExistingChatDb(options);
  try {
    const message = db
      .prepare("SELECT * FROM chat_messages WHERE id = ? AND session_id = ? AND role = 'user'")
      .get(messageId, sessionId) as ChatMessage | undefined;
    if (!message) {
      throw new Error(`Chat message ${messageId} was not found in session ${sessionId}.`);
    }
    return message;
  } finally {
    db.close();
  }
}

function gatherRecentContext(
  sessionId: number,
  options: HermesRuntimeOptions
): ChatProviderContextMessage[] {
  const db = openExistingChatDb(options);
  try {
    const rows = db
      .prepare(
        "SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT 10"
      )
      .all(sessionId) as Array<{ role: ChatRole; content: string }>;
    return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
  } finally {
    db.close();
  }
}

/**
 * Convert any provider failure into a short, human-facing notice. Defensive
 * redaction guarantees an API key can never leak into UI, logs, or exports even
 * if an upstream error message somehow embedded one.
 */
function sanitizeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw.replace(/sk-[A-Za-z0-9-_]+/g, "[redacted]").trim();
  return cleaned || "Unknown chat provider error.";
}

function normalizeUserMemoryText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function stripTrailingCommandTone(text: string): string {
  return text.replace(/\s+(?:please|thanks)\.?$/i, "").trim();
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
