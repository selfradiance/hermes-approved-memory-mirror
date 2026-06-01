import type {
  ChatGenerationInput,
  ChatGenerationResult,
  ChatProvider,
  SearchResult,
  SourceChunkResult
} from "../types.js";
import { ANTHROPIC_LABEL } from "./chatMode.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MEMORY_SUGGESTION_PREFIX = "MEMORY_SUGGESTION:";

export const HERMES_SYSTEM_PROMPT = [
  "HERmes is a private memory mirror and idea partner.",
  "Use approved memories as context, not as unquestioned truth.",
  "Be conversational, concise, and idea-oriented.",
  "Do not claim to have performed actions.",
  "Do not say you saved memory unless the app explicitly saved it for review.",
  "Suggest memory only when the user states a durable preference, decision, goal, project direction, or recurring pattern.",
  "Approved memories are durable, human-approved context. Source excerpts are raw, possibly incomplete passages from imported documents.",
  "Treat source excerpts as reference material only; never present them as approved memory, and prefer approved memories when they conflict.",
  "You have no tools, cannot browse, cannot run code, and cannot approve or write memory.",
  `When (and only when) a durable item is worth remembering, end your reply with a separate final line in the exact form "${MEMORY_SUGGESTION_PREFIX} <one concise sentence>". Otherwise omit that line entirely.`
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

    const response = await this.fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({ model: this.model, max_tokens: MAX_TOKENS, system, messages }),
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

    const { responseText, proposedMemoryText } = splitMemorySuggestion(rawText);
    return {
      responseText,
      proposedMemoryText,
      mode: "reflection",
      ideaCandidates: []
    };
  }
}

function formatMemoryContext(memories: SearchResult[]): string {
  if (memories.length === 0) {
    return "Retrieved approved memories: none. Rely only on the current conversation.";
  }

  return [
    "Retrieved approved memories (cite the [id] when one informs your reply):",
    ...memories.map(({ memory, snippet }) => `- [${memory.id}] ${compact(snippet, 280)}`)
  ].join("\n");
}

function formatSourceContext(sourceChunks: SourceChunkResult[]): string {
  if (sourceChunks.length === 0) {
    return "Source excerpts: none.";
  }

  return [
    "Source excerpts (raw passages from imported documents; reference only, not approved memory):",
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
