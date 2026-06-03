import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeterministicChatProvider,
  resolveChatProvider,
  saveSuggestedMemoryDraft,
  sendChatMessage
} from "../src/chat.js";
import {
  AnthropicChatProvider,
  HERMES_SYSTEM_PROMPT
} from "../src/llm/anthropicChatProvider.js";
import {
  CHAT_PROVIDERS,
  chatModeLabel,
  providerDisplayName,
  resolveChatModeConfig
} from "../src/llm/chatMode.js";
import {
  approveDraft,
  initHermes,
  intakeText,
  listApprovedMemories,
  listPendingDrafts
} from "../src/hermes.js";
import type {
  ChatGenerationInput,
  ChatGenerationResult,
  ChatProvider,
  HermesRuntimeOptions,
  SourceExtractionInput,
  SourceMemoryCandidate
} from "../src/types.js";

const tempRoots: string[] = [];

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-provider-test-"));
  tempRoots.push(root);
  return root;
}

function runtime(root: string): HermesRuntimeOptions {
  return { projectRoot: root };
}

function approveText(root: string, text: string): number {
  const [draft] = intakeText(text, runtime(root));
  return approveDraft(draft.id, runtime(root)).id;
}

/** A fake API-style provider so tests never make real network calls. */
class FakeApiProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly label = "Claude";
  lastInput?: ChatGenerationInput;

  constructor(private readonly result: ChatGenerationResult) {}

  async generate(input: ChatGenerationInput): Promise<ChatGenerationResult> {
    this.lastInput = input;
    return this.result;
  }
}

class FakeExtractionChatProvider extends FakeApiProvider {
  lastExtractionInput?: SourceExtractionInput;

  constructor(
    result: ChatGenerationResult,
    private readonly extractionResult: SourceMemoryCandidate[] | Error
  ) {
    super(result);
  }

  async extractSourceMemories(input: SourceExtractionInput): Promise<SourceMemoryCandidate[]> {
    this.lastExtractionInput = input;
    if (this.extractionResult instanceof Error) {
      throw this.extractionResult;
    }
    return this.extractionResult;
  }
}

class ThrowingProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly label = "Claude";

  async generate(): Promise<ChatGenerationResult> {
    throw new Error("Claude API request failed with status 500.");
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("chat provider abstraction", () => {
  it("defaults to the deterministic provider when no API mode is configured", () => {
    const config = resolveChatModeConfig({});
    expect(config.id).toBe("deterministic");
    expect(resolveChatProvider().id).toBe("deterministic");
  });

  it("exposes short, non-technical provider display names through the registry", () => {
    expect(providerDisplayName("deterministic")).toBe("Local");
    expect(providerDisplayName("anthropic")).toBe("Claude");
    expect(CHAT_PROVIDERS.anthropic.requiresApiKey).toBe(true);
    expect(CHAT_PROVIDERS.anthropic.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(CHAT_PROVIDERS.deterministic.requiresApiKey).toBe(false);
    expect(chatModeLabel({})).toBe("Local");
    expect(
      chatModeLabel({ HERMES_CHAT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test-123" })
    ).toBe("Claude");
  });

  it("selects the Anthropic provider only when provider and key are present", () => {
    expect(
      resolveChatModeConfig({ HERMES_CHAT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test-123" }).id
    ).toBe("anthropic");
    expect(resolveChatModeConfig({ HERMES_CHAT_PROVIDER: "anthropic" }).id).toBe("deterministic");
    expect(resolveChatModeConfig({ ANTHROPIC_API_KEY: "sk-test-123" }).id).toBe("deterministic");
  });

  it("uses an injected provider and records its label on the turn", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const provider = new FakeApiProvider({
      responseText: "Mirrored in API mode.",
      proposedMemoryText: undefined,
      mode: "reflection",
      ideaCandidates: []
    });

    const turn = await sendChatMessage("Reflect on local-first memory.", {
      ...runtime(root),
      chatProvider: provider
    });

    expect(turn.providerId).toBe("anthropic");
    expect(turn.providerLabel).toBe("Claude");
    expect(turn.providerError).toBeUndefined();
    expect(turn.hermesMessage.content).toContain("Mirrored in API mode.");
    expect(provider.lastInput?.userMessage).toBe("Reflect on local-first memory.");
  });

  it("passes retrieved approved memories to the provider", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const memoryId = approveText(root, "Seedance storyboard work should use shot-by-shot prompt notes.");
    const provider = new FakeApiProvider({
      responseText: "ok",
      mode: "reflection",
      ideaCandidates: []
    });

    await sendChatMessage("What Seedance storyboard ideas fit?", {
      ...runtime(root),
      chatProvider: provider
    });

    expect(provider.lastInput?.memories.map(({ memory }) => memory.id)).toContain(memoryId);
  });

  it("turns an API memory suggestion into a save-for-review draft only", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const provider = new FakeApiProvider({
      responseText: "That sounds like a durable preference.",
      proposedMemoryText: "I prefer local-first tools that ask before saving memory.",
      mode: "reflection",
      ideaCandidates: []
    });

    const turn = await sendChatMessage("I keep choosing local-first tools.", {
      ...runtime(root),
      chatProvider: provider
    });

    expect(turn.memorySuggestion?.proposedContent).toContain("local-first tools");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);

    const draft = saveSuggestedMemoryDraft(
      {
        proposedContent: turn.memorySuggestion?.proposedContent ?? "",
        sourceSessionId: turn.session.id,
        sourceMessageId: turn.userMessage.id,
        suggestionKey: turn.memorySuggestion?.suggestionKey ?? ""
      },
      runtime(root)
    );

    expect(draft.status).toBe("pending");
    expect(listPendingDrafts(runtime(root))).toHaveLength(1);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("filters provider-suggested remember command phrases before draft creation", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const provider = new FakeApiProvider({
      responseText: "I can help with that.",
      proposedMemoryText: "Can you remember it all?",
      mode: "reflection",
      ideaCandidates: []
    });

    const turn = await sendChatMessage(
      "I prefer memory review prompts to stay inline with the material I am reviewing.",
      {
        ...runtime(root),
        chatProvider: provider
      }
    );

    expect(turn.memorySuggestion?.proposedContent).toContain("I prefer memory review prompts");
    expect(turn.memorySuggestion?.proposedContent).not.toContain("Can you remember it all");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);

    const draft = saveSuggestedMemoryDraft(
      {
        proposedContent: turn.memorySuggestion?.proposedContent ?? "",
        sourceSessionId: turn.session.id,
        sourceMessageId: turn.userMessage.id,
        suggestionKey: turn.memorySuggestion?.suggestionKey ?? ""
      },
      runtime(root)
    );

    expect(draft.proposed_content).not.toContain("Can you remember it all");
    expect(draft.status).toBe("pending");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("uses provider-assisted extraction for long remembered payloads", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const provider = new FakeExtractionChatProvider(
      {
        responseText: "I saved the useful parts for review.",
        mode: "reflection",
        ideaCandidates: []
      },
      [
        {
          content: "James prefers source suggestions to appear inline.",
          category: "preference",
          tags: ["source-suggestions"]
        },
        {
          content: "Project Source Review should keep new memory suggestions under the source result.",
          category: "project_note",
          tags: ["source-review"]
        },
        {
          content: "Can you remember all this?",
          category: "general_note",
          tags: []
        }
      ]
    );

    await sendChatMessage(
      [
        "Can you remember all this?",
        "",
        "I prefer source suggestions to appear inline because jumping between pages is annoying.",
        "",
        "Project Source Review should keep new memory suggestions under the source result.",
        "",
        "Use chat-local extraction when pasted memory payloads contain multiple durable items."
      ].join("\n"),
      { ...runtime(root), chatProvider: provider }
    );
    const drafts = listPendingDrafts(runtime(root));

    expect(provider.lastExtractionInput?.sourceTitle).toBe("Chat pasted memory");
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.proposed_content)).toContain("James prefers source suggestions to appear inline.");
    expect(drafts.every((draft) => !draft.proposed_content.includes("Can you remember all this"))).toBe(true);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("falls back to deterministic extraction when provider extraction fails", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const provider = new FakeExtractionChatProvider(
      {
        responseText: "I can review that.",
        mode: "reflection",
        ideaCandidates: []
      },
      new Error("provider extraction failed")
    );

    await sendChatMessage(
      [
        "Can you remember all this?",
        "",
        "I prefer inline source suggestions because jumping between pages is annoying.",
        "",
        "Project Source Review should avoid hiding memory suggestions on another page.",
        "",
        "Use chat-local extraction for pasted notes and source extraction for imported files."
      ].join("\n"),
      { ...runtime(root), chatProvider: provider }
    );
    const drafts = listPendingDrafts(runtime(root));

    expect(provider.lastExtractionInput).toBeDefined();
    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts.map((draft) => draft.proposed_content).join("\n")).toContain("inline source suggestions");
    expect(drafts.every((draft) => !draft.proposed_content.includes("Can you remember all this"))).toBe(true);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("falls back to deterministic output when the API provider fails", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const turn = await sendChatMessage("What does this make you think of for a tiny local app?", {
      ...runtime(root),
      chatProvider: new ThrowingProvider()
    });

    expect(turn.providerId).toBe("deterministic");
    expect(turn.providerError).toContain("status 500");
    expect(turn.response.mode).toBe("idea");
    expect(turn.hermesMessage.content).toContain("these ideas come only from your current message");
  });
});

describe("Anthropic chat provider (mocked transport)", () => {
  const baseMemory = {
    memory: {
      id: 42,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: null,
      source_type: "manual_text",
      source_label: "test",
      category: "preference",
      content: "Keep memory approval human-only.",
      tags_json: JSON.stringify(["memory"]),
      confidence: "high" as const,
      status: "approved" as const,
      supersedes_id: null,
      deleted_at: null,
      retired_at: null,
      retired_reason: null,
      approval_note: null
    },
    snippet: "Keep memory approval human-only."
  };

  it("embeds the required system prompt language and memory ids, and parses suggestions", async () => {
    let capturedBody: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "Here is a grounded reflection citing [42].\nMEMORY_SUGGESTION: I value human-only memory approval." }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new AnthropicChatProvider({
      apiKey: "sk-secret-key",
      model: "claude-sonnet-4-6",
      fetchImpl
    });

    const result = await provider.generate({
      userMessage: "How should memory approval work?",
      recentMessages: [],
      memories: [baseMemory]
    });

    expect(HERMES_SYSTEM_PROMPT).toContain(
      "ContextCrate is a local context generator for LLM-ready context packs."
    );
    expect(HERMES_SYSTEM_PROMPT).toContain(
      "Use approved context as context, not as unquestioned truth."
    );
    expect(capturedBody.system).toContain("[42]");
    expect(result.responseText).toContain("grounded reflection citing [42]");
    expect(result.proposedMemoryText).toBe("I value human-only memory approval.");
  });

  it("never leaks the API key when the request fails", async () => {
    const fetchImpl = (async () =>
      new Response("provider detail", { status: 401 })) as unknown as typeof fetch;
    const provider = new AnthropicChatProvider({
      apiKey: "sk-super-secret",
      model: "claude-sonnet-4-6",
      fetchImpl
    });

    await expect(
      provider.generate({ userMessage: "hi", recentMessages: [], memories: [] })
    ).rejects.toThrow(/status 401/);
    await expect(
      provider.generate({ userMessage: "hi", recentMessages: [], memories: [] })
    ).rejects.not.toThrow(/sk-super-secret/);
  });

  it("deterministic provider performs no network work", async () => {
    const provider = new DeterministicChatProvider();
    const result = await provider.generate({
      userMessage: "What ideas does this make you think of?",
      recentMessages: [],
      memories: [baseMemory]
    });
    expect(result.mode).toBe("idea");
    expect(result.proposedMemoryText).toBeUndefined();
  });
});
