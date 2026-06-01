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
  MAX_BATCH_CHARS,
  MAX_SOURCE_BYTES
} from "../src/sources.js";
import { sendChatMessage } from "../src/chat.js";
import { AnthropicChatProvider } from "../src/llm/anthropicChatProvider.js";
import { approveDraft, initHermes, listApprovedMemories, listPendingDrafts } from "../src/hermes.js";
import { handleUiRequest } from "../src/ui.js";
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

const METADATA_HEAVY_MARKDOWN = [
  "# MASTER IDENTITY DOCUMENT",
  "",
  "Title: Master Identity Document",
  "Filename: identity.md",
  "Created: 2026-01-01",
  "Purpose: To capture the core identity anchors.",
  "",
  "## Dynamics",
  "",
  "Dynamics: Not tribal.",
  "",
  "I believe Bitcoin is the hardest money ever created, so I hold it for the long term.",
  "",
  "I always train every morning because a consistent fitness routine keeps me grounded.",
  "",
  "My coding principle is to make the smallest safe change and verify it before moving on."
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

class FakeExtractionProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly label = "Claude";
  lastInput?: SourceExtractionInput;

  constructor(private readonly candidates: SourceMemoryCandidate[]) {}

  async generate(): Promise<ChatGenerationResult> {
    return { responseText: "ok", mode: "reflection", ideaCandidates: [] };
  }

  async extractSourceMemories(input: SourceExtractionInput): Promise<SourceMemoryCandidate[]> {
    this.lastInput = input;
    return this.candidates;
  }
}

class FailingExtractionProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly label = "Claude";
  called = false;

  async generate(): Promise<ChatGenerationResult> {
    return { responseText: "ok", mode: "reflection", ideaCandidates: [] };
  }

  async extractSourceMemories(): Promise<SourceMemoryCandidate[]> {
    this.called = true;
    throw new Error("Claude API request failed with status 500.");
  }
}

// Records how the full-source workflow batches and orders the chunks it sends.
class RecordingExtractionProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly label = "Claude";
  callCount = 0;
  receivedChunkIndexes: number[] = [];
  lastInput?: SourceExtractionInput;

  constructor(private readonly candidates: SourceMemoryCandidate[]) {}

  async generate(): Promise<ChatGenerationResult> {
    return { responseText: "ok", mode: "reflection", ideaCandidates: [] };
  }

  async extractSourceMemories(input: SourceExtractionInput): Promise<SourceMemoryCandidate[]> {
    this.callCount += 1;
    this.lastInput = input;
    this.receivedChunkIndexes.push(...input.chunks.map((chunk) => chunk.chunkIndex));
    return this.candidates;
  }
}

const TEN_DISTINCT_CANDIDATES: SourceMemoryCandidate[] = [
  { content: "James prefers Seedance shot-by-shot prompts for storyboard consistency.", category: "preference", tags: ["video"] },
  { content: "James holds a long-term Bitcoin thesis and treats it as the hardest money.", category: "preference", tags: ["bitcoin"] },
  { content: "James trains every morning to stay grounded and focused.", category: "routine", tags: ["health"] },
  { content: "James makes the smallest safe change and verifies it before moving on.", category: "principle", tags: ["coding"] },
  { content: "James values concise idea-oriented conversations over long summaries.", category: "preference", tags: ["communication"] },
  { content: "James keeps watermarks and logos off the final video frames.", category: "preference", tags: ["video"] },
  { content: "James pushes commits to GitHub immediately after verification.", category: "workflow", tags: ["git"] },
  { content: "James reads the project context file before making any changes.", category: "workflow", tags: ["process"] },
  { content: "James prefers TypeScript with strict compiler settings for new code.", category: "preference", tags: ["typescript"] },
  { content: "James schedules deep creative work during quiet morning hours.", category: "routine", tags: ["focus"] }
];

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
  it("creates save-for-review drafts only and never approves memory", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "zion-skank.md", content: SAMPLE_MARKDOWN },
      runtime(root)
    );

    const { drafts } = await suggestMemoriesFromSource(summary.id, runtime(root));
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((draft) => draft.status === "pending")).toBe(true);
    expect(drafts.every((draft) => draft.source_type === "source")).toBe(true);

    expect(listPendingDrafts(runtime(root))).toHaveLength(drafts.length);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("ignores document metadata and tiny fragments, keeping complete standalone sentences", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );

    const { drafts } = await suggestMemoriesFromSource(summary.id, runtime(root));
    const contents = drafts.map((draft) => draft.proposed_content);

    // Headings, titles, and "purpose" metadata must never become memories.
    expect(contents.some((content) => /MASTER IDENTITY DOCUMENT/i.test(content))).toBe(false);
    expect(contents.some((content) => /^Purpose:/i.test(content))).toBe(false);
    // Tiny "Label: value" fragments are not standalone memories.
    expect(contents.some((content) => /^Dynamics: Not tribal/i.test(content))).toBe(false);

    // Every suggestion reads as a complete sentence: starts capitalized, ends with terminal punctuation.
    expect(drafts.length).toBeGreaterThan(0);
    for (const content of contents) {
      expect(/^[A-Z"'“]/.test(content)).toBe(true);
      expect(/[.!?]["'”)\]]?$/.test(content)).toBe(true);
      expect(content.split(/\s+/).length).toBeGreaterThanOrEqual(6);
    }

    // A durable statement from the body should be captured.
    expect(contents.some((content) => /bitcoin/i.test(content))).toBe(true);
  });

  it("clamps the suggestion count to at most ten", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );

    const { drafts } = await suggestMemoriesFromSource(summary.id, { ...runtime(root), limit: 50 });
    expect(drafts.length).toBeLessThanOrEqual(10);
  });

  it("uses the provider for extraction when one is configured", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "zion-skank.md", content: SAMPLE_MARKDOWN },
      runtime(root)
    );

    const provider = new FakeExtractionProvider([
      { content: "James holds a long-term Bitcoin thesis and treats it as the hardest money.", category: "preference", tags: ["bitcoin"], chunkIndexes: [0] }
    ]);

    const { drafts } = await suggestMemoriesFromSource(summary.id, {
      ...runtime(root),
      chatProvider: provider
    });

    expect(provider.lastInput?.sourceTitle).toBe("zion skank");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.proposed_content).toContain("Bitcoin thesis");
    expect(drafts[0]?.proposed_category).toBe("preference");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("falls back to deterministic extraction when the provider fails", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "zion-skank.md", content: SAMPLE_MARKDOWN },
      runtime(root)
    );

    const provider = new FailingExtractionProvider();
    const { drafts, diagnostics } = await suggestMemoriesFromSource(summary.id, {
      ...runtime(root),
      chatProvider: provider
    });

    expect(provider.called).toBe(true);
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((draft) => draft.source_type === "source")).toBe(true);
    // A genuine provider failure falls back to deterministic extraction.
    expect(diagnostics.mode).toBe("deterministic");
  });

  it("uses provider results without deterministic fallback when the provider succeeds", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "zion-skank.md", content: SAMPLE_MARKDOWN },
      runtime(root)
    );

    const provider = new FakeExtractionProvider([
      { content: "James holds a long-term Bitcoin thesis and treats it as the hardest money.", category: "preference", tags: ["bitcoin"] }
    ]);

    const { drafts, diagnostics } = await suggestMemoriesFromSource(summary.id, {
      ...runtime(root),
      chatProvider: provider
    });

    expect(diagnostics.mode).toBe("provider");
    expect(drafts).toHaveLength(1);
    // The provider's single result is used; the deterministic Seedance/watermark
    // sentences from the source are not mixed in.
    expect(drafts[0]?.proposed_content).toContain("Bitcoin");
  });

  it("returns the requested number of suggestions when enough strong material exists", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "zion-skank.md", content: SAMPLE_MARKDOWN },
      runtime(root)
    );

    const provider = new FakeExtractionProvider(TEN_DISTINCT_CANDIDATES);
    const { drafts, diagnostics } = await suggestMemoriesFromSource(summary.id, {
      ...runtime(root),
      chatProvider: provider,
      limit: 7
    });

    expect(drafts).toHaveLength(7);
    expect(diagnostics.requestedCount).toBe(7);
    expect(diagnostics.providerReturnedCount).toBe(10);
  });

  it("reviews the whole source in ordered batches for a large source and dedupes results", async () => {
    const root = makeProject();
    const paragraphs: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      paragraphs.push(`Section ${i}. ${"filler ".repeat(150).trim()}.`);
    }
    const summary = importSource(
      { filename: "big.md", content: paragraphs.join("\n\n") },
      runtime(root)
    );
    expect(summary.chunk_count).toBeGreaterThan(1);

    const provider = new RecordingExtractionProvider([
      { content: "James prefers Seedance shot-by-shot prompts for storyboard consistency.", category: "preference", tags: [] },
      { content: "James holds a long-term Bitcoin thesis and treats it as the hardest money.", category: "preference", tags: [] }
    ]);

    const { drafts, diagnostics } = await suggestMemoriesFromSource(summary.id, {
      ...runtime(root),
      chatProvider: provider,
      limit: 5
    });

    // The whole source is reviewed across more than one batch, in source order.
    expect(diagnostics.batchCount).toBeGreaterThan(1);
    expect(provider.callCount).toBe(diagnostics.batchCount);
    expect(diagnostics.chunksSentToProvider).toBe(summary.chunk_count);
    expect(provider.receivedChunkIndexes).toEqual([...Array(summary.chunk_count).keys()]);
    // The same two candidates returned per batch are deduped down to two.
    expect(diagnostics.mode).toBe("provider");
    expect(drafts).toHaveLength(2);
    expect(MAX_BATCH_CHARS).toBeGreaterThan(0);
  });

  it("does not re-suggest memories that are already approved or pending", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );

    const first = await suggestMemoriesFromSource(summary.id, runtime(root));
    expect(first.drafts.length).toBeGreaterThan(0);
    for (const draft of first.drafts) {
      approveDraft(draft.id, runtime(root));
    }
    const approvedCount = listApprovedMemories(runtime(root)).length;
    expect(approvedCount).toBeGreaterThan(0);

    // Re-running extraction on the same source must skip the now-approved memories.
    const second = await suggestMemoriesFromSource(summary.id, runtime(root));
    expect(second.drafts).toHaveLength(0);
    expect(second.diagnostics.duplicatesSkippedCount).toBeGreaterThan(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(approvedCount);
  });

  it("passes existing approved and pending memories to the provider", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "zion-skank.md", content: SAMPLE_MARKDOWN },
      runtime(root)
    );

    // Create pending drafts deterministically so existing-memory context is non-empty.
    const first = await suggestMemoriesFromSource(summary.id, runtime(root));
    expect(first.drafts.length).toBeGreaterThan(0);

    const provider = new FakeExtractionProvider([
      { content: "James keeps watermarks and logos off the final video frames.", category: "preference", tags: [] }
    ]);
    await suggestMemoriesFromSource(summary.id, { ...runtime(root), chatProvider: provider });

    expect(provider.lastInput?.existingMemories?.length).toBeGreaterThan(0);
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

describe("provider source extraction", () => {
  it("parses a JSON array of candidates and never surfaces the API key", async () => {
    let capturedBody: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      const text = JSON.stringify([
        {
          content: "James holds a long-term Bitcoin thesis and treats it as the hardest money.",
          category: "preference",
          tags: ["bitcoin", "finance"],
          rationale: "Stated as a durable belief.",
          chunkIndexes: [0]
        }
      ]);
      return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const provider = new AnthropicChatProvider({
      apiKey: "sk-secret-key",
      model: "claude-sonnet-4-6",
      fetchImpl
    });

    const candidates = await provider.extractSourceMemories({
      sourceId: 1,
      sourceTitle: "identity",
      chunks: [{ chunkIndex: 0, content: "I believe Bitcoin is the hardest money." }],
      limit: 7
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.content).toContain("Bitcoin thesis");
    expect(candidates[0]?.tags).toContain("bitcoin");
    // The key travels only in the header, never in the request body or returned data.
    expect(JSON.stringify(capturedBody)).not.toContain("sk-secret-key");
    expect(JSON.stringify(candidates)).not.toContain("sk-secret-key");
  });

  it("throws on unparseable extraction output so callers can fall back", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "not json at all" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;

    const provider = new AnthropicChatProvider({
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      fetchImpl
    });

    await expect(
      provider.extractSourceMemories({
        sourceId: 1,
        sourceTitle: "identity",
        chunks: [{ chunkIndex: 0, content: "text" }],
        limit: 5
      })
    ).rejects.toThrow(/source extraction/i);
  });
});

describe("sources UI memory suggestions", () => {
  it("reports the number of suggestions and renders editable review cards", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );

    const response = await handleUiRequest(
      new Request("http://127.0.0.1/sources/suggest", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sourceId: String(summary.id), limit: "5" })
      }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Suggested");
    expect(html).toContain("for review");
    // Review cards expose the full memory text in an editable textarea, not a clipped paragraph.
    expect(html).toContain('name="content"');
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
    expect(listPendingDrafts(runtime(root)).length).toBeGreaterThan(0);
  });

  it("reports that the whole source was reviewed and explains a short count", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );

    const response = await handleUiRequest(
      new Request("http://127.0.0.1/sources/suggest", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sourceId: String(summary.id), limit: "9" })
      }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    // The user is told the whole source was reviewed and why fewer than requested appeared.
    expect(html).toContain("Reviewed");
    expect(html).toContain("source excerpt");
    expect(html).toContain("Only");
  });

  it("approves an edited suggestion using the submitted memory text", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );
    const { drafts } = await suggestMemoriesFromSource(summary.id, runtime(root));
    const draftId = drafts[0]!.id;

    const response = await handleUiRequest(
      new Request("http://127.0.0.1/drafts/approve", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          draftId: String(draftId),
          content: "Edited durable memory that I approved by hand."
        })
      }),
      runtime(root)
    );

    expect(response.status).toBe(200);
    const approved = listApprovedMemories(runtime(root));
    expect(approved).toHaveLength(1);
    expect(approved[0]?.content).toBe("Edited durable memory that I approved by hand.");
  });
});

describe("sources UI inline suggestion review", () => {
  it("creates pending suggestions only, never approved memory, from /sources/suggest", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );

    const response = await handleUiRequest(
      new Request("http://127.0.0.1/sources/suggest", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sourceId: String(summary.id), limit: "5" })
      }),
      runtime(root)
    );

    expect(response.status).toBe(200);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
    expect(listPendingDrafts(runtime(root)).length).toBeGreaterThan(0);
  });

  it("renders the just-created suggestions inline on the Sources page", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );

    const response = await handleUiRequest(
      new Request("http://127.0.0.1/sources/suggest", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sourceId: String(summary.id), limit: "5" })
      }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Memory suggestions from this source");
    // Inline cards carry the return context so approve/dismiss stay on Sources.
    expect(html).toContain('name="returnTo" value="sources"');
    expect(html).toContain('name="batchIds"');
  });

  it("approves an inline suggestion with edited text via the shared approval path", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );
    const { drafts } = await suggestMemoriesFromSource(summary.id, runtime(root));
    const draftId = drafts[0]!.id;

    const response = await handleUiRequest(
      new Request("http://127.0.0.1/drafts/approve", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          draftId: String(draftId),
          content: "Inline-edited memory approved from Sources.",
          returnTo: "sources",
          sourceId: String(summary.id),
          batchIds: drafts.map((draft) => String(draft.id)).join(",")
        })
      }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    // Re-renders the Sources page, not the chat page.
    expect(html).toContain("Import a source");
    const approved = listApprovedMemories(runtime(root));
    expect(approved).toHaveLength(1);
    expect(approved[0]?.content).toBe("Inline-edited memory approved from Sources.");
    // The handled card is gone; remaining batch suggestions stay inline.
    expect(html).not.toContain(`name="draftId" value="${draftId}"`);
  });

  it("dismisses an inline suggestion without creating approved memory", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );
    const { drafts } = await suggestMemoriesFromSource(summary.id, runtime(root));
    const draftId = drafts[0]!.id;
    const before = listPendingDrafts(runtime(root)).length;

    const response = await handleUiRequest(
      new Request("http://127.0.0.1/drafts/reject", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          draftId: String(draftId),
          returnTo: "sources",
          sourceId: String(summary.id),
          batchIds: drafts.map((draft) => String(draft.id)).join(",")
        })
      }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Import a source");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
    expect(listPendingDrafts(runtime(root)).length).toBe(before - 1);
  });

  it("does not show inline source suggestions on the default Sources page", async () => {
    const root = makeProject();
    const summary = importSource(
      { filename: "identity.md", content: METADATA_HEAVY_MARKDOWN },
      runtime(root)
    );
    // Create pending suggestions, but then load the plain Sources page.
    await suggestMemoriesFromSource(summary.id, runtime(root));
    expect(listPendingDrafts(runtime(root)).length).toBeGreaterThan(0);

    const response = await handleUiRequest(
      new Request("http://127.0.0.1/sources"),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain("Memory suggestions from this source");
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
