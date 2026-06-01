import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chunkContent,
  importSource,
  getSourceChunks,
  listSources,
  retrieveRelevantSourceChunks,
  searchSourceChunks,
  suggestMemoriesFromSource,
  MAX_SOURCE_BYTES
} from "../src/sources.js";
import { sendChatMessage } from "../src/chat.js";
import { AnthropicChatProvider } from "../src/llm/anthropicChatProvider.js";
import { initHermes, listApprovedMemories, listPendingDrafts } from "../src/hermes.js";
import { handleUiRequest } from "../src/ui.js";
import type {
  ChatGenerationInput,
  ChatGenerationResult,
  ChatProvider,
  HermesRuntimeOptions
} from "../src/types.js";

const tempRoots: string[] = [];

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-sources-test-"));
  tempRoots.push(root);
  initHermes({ projectRoot: root });
  return root;
}

function runtime(root: string): HermesRuntimeOptions {
  return { projectRoot: root };
}

const SAMPLE_MARKDOWN = [
  "# Zion Skank workflow",
  "",
  "I prefer Seedance shot-by-shot prompts for the Zion Skank storyboard so each shot stays consistent.",
  "",
  "The action sheet should always end with one tiny artifact before moving on.",
  "",
  "Watermark and logo must stay off the final frames."
].join("\n");

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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("source import", () => {
  it("imports a Markdown file and creates ordered excerpts without approving memory", () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "zion-skank.md", content: SAMPLE_MARKDOWN },
      runtime(root)
    );

    expect(summary.title).toBe("zion skank");
    expect(summary.source_type).toBe("markdown");
    expect(summary.chunk_count).toBeGreaterThan(0);

    const chunks = getSourceChunks(summary.id, runtime(root));
    expect(chunks.map((chunk) => chunk.chunk_index)).toEqual(
      chunks.map((_chunk, index) => index)
    );

    // Importing a source must never create approved memory or pending drafts.
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
  });

  it("imports a plain text file", () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "notes.txt", content: "Plain text note about a durable preference I keep returning to." },
      runtime(root)
    );
    expect(summary.source_type).toBe("text");
    expect(summary.chunk_count).toBe(1);
  });

  it("rejects unsupported file types with a friendly message", () => {
    const root = makeProject();
    expect(() =>
      importSource({ filename: "secrets.pdf", content: "irrelevant" }, runtime(root))
    ).toThrow(/Markdown.*plain text/i);
  });

  it("rejects files over the size limit", () => {
    const root = makeProject();
    const tooBig = "a".repeat(MAX_SOURCE_BYTES + 1);
    expect(() => importSource({ filename: "big.txt", content: tooBig }, runtime(root))).toThrow(
      /too large/i
    );
  });

  it("rejects empty files", () => {
    const root = makeProject();
    expect(() => importSource({ filename: "empty.txt", content: "   \n  " }, runtime(root))).toThrow(
      /empty/i
    );
  });
});

describe("source chunking", () => {
  it("splits paragraphs deterministically and preserves order", () => {
    const chunks = chunkContent(SAMPLE_MARKDOWN);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join(" ")).toContain("Seedance");
    expect(chunkContent(SAMPLE_MARKDOWN)).toEqual(chunks);
  });

  it("hard-splits a giant paragraph into multiple excerpts", () => {
    const giant = "word ".repeat(800).trim();
    const chunks = chunkContent(giant);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1500)).toBe(true);
  });
});

describe("source listing and search", () => {
  it("lists imported sources and searches inside their excerpts", () => {
    const root = makeProject();
    importSource({ filename: "zion-skank.md", content: SAMPLE_MARKDOWN }, runtime(root));

    expect(listSources(runtime(root))).toHaveLength(1);

    const results = searchSourceChunks("Seedance", runtime(root));
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toContain("Seedance");

    expect(searchSourceChunks("nonexistentterm", runtime(root))).toHaveLength(0);
  });

  it("retrieves relevant source chunks by term overlap", () => {
    const root = makeProject();
    importSource({ filename: "zion-skank.md", content: SAMPLE_MARKDOWN }, runtime(root));

    const relevant = retrieveRelevantSourceChunks("Seedance storyboard prompts", runtime(root));
    expect(relevant.length).toBeGreaterThan(0);
    expect(relevant[0]?.sourceTitle).toBe("zion skank");
  });
});

describe("source-grounded memory suggestions", () => {
  it("creates save-for-review drafts only and never approves memory", () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "zion-skank.md", content: SAMPLE_MARKDOWN },
      runtime(root)
    );

    const drafts = suggestMemoriesFromSource(summary.id, runtime(root));
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((draft) => draft.status === "pending")).toBe(true);
    expect(drafts.every((draft) => draft.source_type === "source")).toBe(true);

    expect(listPendingDrafts(runtime(root))).toHaveLength(drafts.length);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });
});

describe("chat retrieval includes source excerpts", () => {
  it("passes relevant source chunks to the chat provider", async () => {
    const root = makeProject();
    importSource({ filename: "zion-skank.md", content: SAMPLE_MARKDOWN }, runtime(root));

    const provider = new FakeApiProvider({
      responseText: "ok",
      mode: "reflection",
      ideaCandidates: []
    });

    await sendChatMessage("What Seedance storyboard prompts should I reuse?", {
      ...runtime(root),
      chatProvider: provider
    });

    expect(provider.lastInput?.sourceChunks?.length).toBeGreaterThan(0);
    expect(provider.lastInput?.sourceChunks?.[0]?.sourceTitle).toBe("zion skank");
  });
});

describe("provider context distinguishes memories from source excerpts", () => {
  it("labels source excerpts as raw reference material in the system prompt", async () => {
    let capturedBody: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new AnthropicChatProvider({
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      fetchImpl
    });

    await provider.generate({
      userMessage: "What does my source say?",
      recentMessages: [],
      memories: [],
      sourceChunks: [
        {
          chunk: {
            id: 1,
            source_id: 9,
            chunk_index: 0,
            content: "Seedance shot-by-shot prompts keep the storyboard consistent.",
            char_count: 60,
            created_at: "2026-01-01T00:00:00.000Z"
          },
          sourceTitle: "zion skank",
          snippet: "Seedance shot-by-shot prompts keep the storyboard consistent."
        }
      ]
    });

    expect(capturedBody.system).toContain("Source excerpts");
    expect(capturedBody.system).toContain("zion skank");
    expect(capturedBody.system).toContain("not approved memory");
  });
});

describe("sources UI", () => {
  it("imports a source through the local UI and never auto-approves memory", async () => {
    const root = makeProject();

    const response = await handleUiRequest(
      new Request("http://127.0.0.1/sources/import", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ filename: "zion-skank.md", content: SAMPLE_MARKDOWN })
      }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("is not an approved memory");
    expect(listSources(runtime(root))).toHaveLength(1);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("shows the sources page with human-facing language", async () => {
    const root = makeProject();
    importSource({ filename: "zion-skank.md", content: SAMPLE_MARKDOWN }, runtime(root));

    const response = await handleUiRequest(
      new Request("http://127.0.0.1/sources"),
      runtime(root)
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Import a source");
    expect(html).toContain("Suggest memories from this source");
    expect(html).not.toContain("source_chunks");
  });
});
