import type { ChatProviderId } from "../types.js";

export interface ChatProviderDescriptor {
  /** Stable internal id used in code, env values, and routing. */
  id: ChatProviderId;
  /** Short, user-facing name for the minimal chat mode label. No provider jargon. */
  displayName: string;
  /** Whether selecting this provider needs an API key from the environment. */
  requiresApiKey: boolean;
  /**
   * Env var that supplies the API key, when one is required. Keys are read from
   * the environment only for the single model call. They are never written to
   * SQLite, surfaced in the UI, logged, or included in errors/exports.
   */
  apiKeyEnvVar?: string;
}

/**
 * Central registry of chat providers. Display names are deliberately short and
 * non-technical for the main chat surface ("Local", "Claude").
 *
 * Adding a future provider (for example an OpenAI-compatible endpoint, DeepSeek,
 * Kimi/Moonshot, or a local Ollama model) means adding a descriptor here, an id
 * to ChatProviderId, and a ChatProvider implementation selected in
 * resolveChatProvider. UI and business logic read display names through this
 * layer instead of hardcoding provider names, so no UI/business-logic change is
 * needed to introduce a new provider's label.
 */
export const CHAT_PROVIDERS = {
  deterministic: {
    id: "deterministic",
    displayName: "Local",
    requiresApiKey: false
  },
  anthropic: {
    id: "anthropic",
    displayName: "Claude",
    requiresApiKey: true,
    apiKeyEnvVar: "ANTHROPIC_API_KEY"
  }
} as const satisfies Record<ChatProviderId, ChatProviderDescriptor>;

export const DETERMINISTIC_LABEL = CHAT_PROVIDERS.deterministic.displayName;
export const ANTHROPIC_LABEL = CHAT_PROVIDERS.anthropic.displayName;
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6" as const;

/** User-facing display name for a provider id, via the registry. */
export function providerDisplayName(id: ChatProviderId): string {
  return CHAT_PROVIDERS[id].displayName;
}

export interface ChatModeConfig {
  id: ChatProviderId;
  label: string;
  model: string;
  apiKey?: string;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Decide which chat provider to use from environment only. API mode is selected
 * solely when HERMES_CHAT_PROVIDER=anthropic and an ANTHROPIC_API_KEY is present;
 * any other state falls back to local deterministic mode. The key is read here
 * but never logged, returned to UI, or persisted.
 */
export function resolveChatModeConfig(env: EnvLike = process.env): ChatModeConfig {
  const provider = (env.HERMES_CHAT_PROVIDER ?? "").trim().toLowerCase();
  const apiKey = (env.ANTHROPIC_API_KEY ?? "").trim();
  const model = (env.HERMES_MODEL ?? "").trim() || DEFAULT_ANTHROPIC_MODEL;

  if (provider === "anthropic" && apiKey) {
    return { id: "anthropic", label: providerDisplayName("anthropic"), model, apiKey };
  }

  return { id: "deterministic", label: providerDisplayName("deterministic"), model };
}

export function chatModeLabel(env: EnvLike = process.env): string {
  return resolveChatModeConfig(env).label;
}
