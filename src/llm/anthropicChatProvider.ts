import type {
  ChatGenerationInput,
  ChatGenerationResult,
  ChatProvider,
  SearchResult,
  SourceChunkResult,
  SourceExtractionInput,
  SourceMemoryCandidate
} from "../types.js";
import { ANTHROPIC_LABEL } from "./chatMode.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;
// Source extraction returns a JSON array of several memories, so it needs more
// output headroom than a single chat reply to avoid truncated JSON.
const EXTRACTION_MAX_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 30_000;
const MEMORY_SUGGESTION_PREFIX = "MEMORY_SUGGESTION:";

export const HERMES_SYSTEM_PROMPT = [
  "ContextCrate is a local context generator for LLM-ready context packs.",
  "Use approved context as context, not as unquestioned truth.",
  "Be conversational, concise, and idea-oriented.",
  "Do not claim to have performed actions.",
  "Do not say you saved context unless the app explicitly saved it for review.",
  "Suggest context only when the user states a durable preference, decision, goal, project direction, or recurring pattern.",
  "If the user asks you to remember this, remember it all, save this, or add this to memory, treat that as an instruction, not as memory content.",
  "When that instruction includes pasted content, propose only durable facts, preferences, or project context from the pasted content; never propose the instruction phrase itself.",
  "If there is no actual payload, omit the context suggestion and invite the user to paste the information.",
  "Approved context is durable, human-approved context. Source excerpts are raw, possibly incomplete passages from imported documents.",
  "Treat source excerpts as reference material only; never present them as approved context, and prefer approved context when they conflict.",
  "You have no tools, cannot browse, cannot run code, and cannot approve or write context.",
  `When (and only when) a durable item is useful as approved context, end your reply with a separate final line in the exact form "${MEMORY_SUGGESTION_PREFIX} <one concise sentence>". Otherwise omit that line entirely.`
].join("\n");

export const SOURCE_EXTRACTION_PROMPT = [
  "You review an imported document as source material (not as a chat) and extract durable, high-value context suggestions for future LLM handoffs.",
  "Read all of the provided excerpts. Extract the strongest context worth keeping long term: stable preferences, project direction, identity anchors, recurring principles, workflows, decision patterns, health and training patterns, creative direction, finance or Bitcoin thesis, and AI or coding principles.",
  "Ignore document metadata such as the title, filename, creation date, \"purpose\" lines, and headings (for example \"MASTER IDENTITY DOCUMENT\") unless the line itself states a durable fact.",
  "Do not summarize the document. Do not propose vague fragments, bare labels, headings, or trivial facts.",
  "If the text includes a request such as \"remember this\" or \"can you remember all this\", treat that as instruction text only and never return it as context.",
  "Do not repeat context the user already has. Skip anything that duplicates or closely restates listed existing context.",
  "Each suggestion must be a complete, standalone sentence that makes sense on its own.",
  "Return exactly the requested number of suggestions when there is enough strong material. If there is less, return only the genuinely strong ones rather than padding with weak ones.",
  "Phrase suggestions cautiously and do not infer sensitive identity claims beyond what the source clearly states.",
  "You have no tools and cannot approve or write context; a human reviews and approves every suggestion.",
  "Return ONLY a JSON array. Each element is an object with keys: \"content\" (string, required), \"category\" (string), \"tags\" (array of strings), \"rationale\" (short string), and \"chunkIndexes\" (array of integers). Return [] if nothing is worth saving. Output no prose outside the JSON."
].join("\n");

interface AnthropicTextBlock {
  type: string;
  text?: string;
}

interface AnthropicMessagesResponse {
  content?: AnthropicTextBlock[];
}

export interface AnthropicChatProviderOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export class AnthropicChatProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly label = ANTHROPIC_LABEL;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicChatProviderOptions) {
    if (!options.apiKey) {
      throw new Error("Anthropic chat provider requires an API key.");
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(input: ChatGenerationInput): Promise<ChatGenerationResult> {
    const system = [
      HERMES_SYSTEM_PROMPT,
      formatMemoryContext(input.memories),
      formatSourceContext(input.sourceChunks ?? [])
    ].join("\n\n");
    const messages = [
      ...input.recentMessages.map((message) => ({
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        content: message.content
      })),
      { role: "user" as const, content: input.userMessage }
    ];

    const rawText = await this.requestText(system, messages);
    const { responseText, proposedMemoryText } = splitMemorySuggestion(rawText);
    return {
      responseText,
      proposedMemoryText,
      mode: "reflection",
      ideaCandidates: []
    };
  }

  async extractSourceMemories(input: SourceExtractionInput): Promise<SourceMemoryCandidate[]> {
    const sections = [
      `Source title: ${input.sourceTitle}`,
      `Return up to ${input.limit} of the strongest durable memories as a JSON array.`
    ];
    if (input.existingMemories && input.existingMemories.length > 0) {
      sections.push(
        [
          "Avoid repeating these existing approved or pending context items (skip near-duplicates):",
          ...input.existingMemories.map((memory) => `- ${memory}`)
        ].join("\n")
      );
    }
    sections.push("Document excerpts (in source order):");
    sections.push(...input.chunks.map((chunk) => `[excerpt ${chunk.chunkIndex}] ${chunk.content}`));

    const rawText = await this.requestText(
      SOURCE_EXTRACTION_PROMPT,
      [{ role: "user", content: sections.join("\n\n") }],
      EXTRACTION_MAX_TOKENS
    );
    return parseSourceCandidates(rawText, input.limit);
  }

  private async requestText(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    maxTokens: number = MAX_TOKENS
  ): Promise<string> {
    const response = await this.fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, system, messages }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      // Never include the API key or raw provider body in the surfaced error.
      throw new Error(`Claude API request failed with status ${response.status}.`);
    }

    const data = (await response.json()) as AnthropicMessagesResponse;
    const rawText = (data.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("")
      .trim();

    if (!rawText) {
      throw new Error("Claude API returned an empty response.");
    }
    return rawText;
  }
}

function parseSourceCandidates(rawText: string, limit: number): SourceMemoryCandidate[] {
  const start = rawText.indexOf("[");
  const end = rawText.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Claude API returned no JSON array for source extraction.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    throw new Error("Claude API returned an unparseable source extraction response.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Claude API source extraction did not return a list.");
  }

  const candidates: SourceMemoryCandidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) {
      continue;
    }
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const chunkIndexes = Array.isArray(record.chunkIndexes)
      ? record.chunkIndexes.filter((value): value is number => Number.isInteger(value))
      : undefined;
    candidates.push({
      content,
      category: typeof record.category === "string" ? record.category : "",
      tags,
      rationale: typeof record.rationale === "string" ? record.rationale : undefined,
      chunkIndexes
    });
    if (candidates.length >= limit) {
      break;
    }
  }
  return candidates;
}

function formatMemoryContext(memories: SearchResult[]): string {
  if (memories.length === 0) {
    return "Retrieved approved context: none. Rely only on the current conversation.";
  }

  return [
    "Retrieved approved context (cite the [id] when one informs your reply):",
    ...memories.map(({ memory, snippet }) => `- [${memory.id}] ${compact(snippet, 280)}`)
  ].join("\n");
}

function formatSourceContext(sourceChunks: SourceChunkResult[]): string {
  if (sourceChunks.length === 0) {
    return "Source excerpts: none.";
  }

  return [
    "Source excerpts (raw passages from imported documents; reference only, not approved context):",
    ...sourceChunks.map(
      ({ chunk, sourceTitle, snippet }) =>
        `- "${compact(sourceTitle, 80)}" (excerpt ${chunk.chunk_index + 1}): ${compact(snippet, 280)}`
    )
  ].join("\n");
}

function splitMemorySuggestion(text: string): {
  responseText: string;
  proposedMemoryText?: string;
} {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      continue;
    }
    if (line.toUpperCase().startsWith(MEMORY_SUGGESTION_PREFIX)) {
      const proposed = line.slice(MEMORY_SUGGESTION_PREFIX.length).trim();
      const responseText = lines.slice(0, index).join("\n").trim();
      return {
        responseText: responseText || proposed,
        proposedMemoryText: proposed || undefined
      };
    }
    break;
  }
  return { responseText: text };
}

function compact(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
