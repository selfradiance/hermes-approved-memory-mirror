import type { ChatProviderId } from "../types.js";

export const DETERMINISTIC_LABEL = "Local deterministic" as const;
export const ANTHROPIC_LABEL = "Claude API" as const;
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6" as const;

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
    return { id: "anthropic", label: ANTHROPIC_LABEL, model, apiKey };
  }

  return { id: "deterministic", label: DETERMINISTIC_LABEL, model };
}

export function chatModeLabel(env: EnvLike = process.env): string {
  return resolveChatModeConfig(env).label;
}
