import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listChatMessages, listChatSessions } from "../src/chat.js";
import {
  approveDraft,
  initHermes,
  intakeText,
  listApprovedMemories,
  listPendingDrafts,
  listRetiredMemories,
  listSavedContextPacks,
  reflectOnApprovedMemory,
  retireApprovedMemory
} from "../src/hermes.js";
import { DEFAULT_UI_HOST, handleUiRequest, startUiServer } from "../src/ui.js";
import { listSources } from "../src/sources.js";
import type { HermesRuntimeOptions } from "../src/types.js";

const tempRoots: string[] = [];

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-ui-test-"));
  tempRoots.push(root);
  return root;
}

function runtime(root: string): HermesRuntimeOptions {
  return { projectRoot: root };
}

function formRequest(
  pathname: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
  origin = "http://127.0.0.1"
): Request {
  return new Request(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields)
  });
}

function getRequest(pathname: string): Request {
  return new Request(`http://127.0.0.1${pathname}`);
}

function longAddMemoryText(): string {
  return [
    "# Source review workflow",
    "",
    "I prefer inline source suggestions because jumping between pages is annoying.",
    "",
    "Project Source Review should keep new memory suggestions visible under the source result.",
    "",
    "Use the source extraction workflow for imported files and direct memory splitting for pasted long notes.",
    "",
    "The memory review flow should avoid one giant memory when a note contains several durable points."
  ].join("\n");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("HERmes Local Web Chat UI", () => {
  it("auto-initializes the local database on the home page", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<h1>Context crates</h1>");
    expect(html).toContain("A crate is a saved Markdown context pack you can copy or download for an LLM.");
    expect(html).not.toContain("HERmes");
    expect(fs.existsSync(path.join(root, ".hermes", "hermes.db"))).toBe(true);
  });

  it("uses human-facing context language on the capture page", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/capture"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Review context suggestions");
    expect(html).toContain("Save for review");
    expect(html).not.toContain(">Create draft<");
    expect(html).not.toContain(">Save as draft<");
    expect(html).not.toContain("Review drafts");
  });

  it("keeps the capture surface minimal and free of removed copy", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/capture"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain("Your memories stay local.");
    expect(html).not.toContain("Only approved context is used.");
    expect(html).not.toContain("No outside actions.");
    expect(html).not.toContain("HERmes can suggest memories from chat. Nothing becomes an approved memory until you approve it.");
    expect(html).not.toContain("No chat messages yet.");
    expect(html).not.toContain("Started a new local chat session.");
    expect(html).not.toContain("Saving an exchange only saves it for review.");
    expect(html).not.toContain("Sources from your memory: none yet.");
    expect(html).not.toContain("Sources from your memory");
    expect(html).not.toContain("No approved context used for the latest response.");
    expect(html).not.toContain('class="memory-sources"');
    expect(html).toContain('placeholder="Message…"');
  });

  it("keeps database and internal language off the default chat page", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain("Database path:");
    expect(html).not.toContain("Tables:");
    expect(html).not.toContain("memory_entries");
    expect(html).not.toContain("memory_drafts");
    expect(html).not.toContain("chat_sessions");
    expect(html).not.toContain("chat_messages");
    expect(html).not.toContain("External connectors/tools configured");
    expect(html).not.toContain("ContextCrate posture");
    expect(html).not.toContain("HERmes posture");
    expect(html).not.toContain("Initialize Local Database");
    expect(html).toContain('href="/system"');
  });

  it("includes an Enter-to-send keydown handler that respects Shift+Enter and empty input", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/capture"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('textarea[name="message"]');
    expect(html).toContain('event.key !== "Enter" || event.shiftKey');
    expect(html).toContain("!textarea.value.trim()");
    expect(html).toContain("requestSubmit");
  });

  it("shows the conversation mode label and hides the prominent System button", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/capture"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Mode: Local");
    expect(html).not.toContain("Mode: Local deterministic");
    expect(html).not.toContain("Mode: Claude API");
    expect(html).not.toContain(">System</a>");
    expect(html).toContain(">Diagnostics</a>");
  });

  it("shows technical diagnostics only on the system page", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/system"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Technical Diagnostics");
    expect(html).toContain("Database path:");
    expect(html).toContain("Tables:");
    expect(html).toContain("memory_entries");
  });

  it("allows same-origin local POST requests", async () => {
    const root = makeProject();

    const response = await handleUiRequest(
      formRequest(
        "/init",
        {},
        {
          host: "127.0.0.1:8787",
          origin: "http://127.0.0.1:8787",
          "sec-fetch-site": "same-origin"
        },
        "http://127.0.0.1:8787"
      ),
      runtime(root)
    );

    expect(response.status).toBe(200);
    expect(fs.existsSync(path.join(root, ".hermes", "hermes.db"))).toBe(true);
  });

  it("rejects external Origin POST requests before state changes", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const response = await handleUiRequest(
      formRequest("/drafts", { text: "This should be rejected." }, { origin: "https://example.com" }),
      runtime(root)
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden: invalid local request origin");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
  });

  it("rejects cross-site Sec-Fetch-Site POST requests before state changes", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const response = await handleUiRequest(
      formRequest("/drafts", { text: "This should also be rejected." }, { "sec-fetch-site": "cross-site" }),
      runtime(root)
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden: invalid local request origin");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
  });

  it("rejects non-loopback Host POST requests before state changes", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const response = await handleUiRequest(
      formRequest("/drafts", { text: "Host should reject this." }, { host: "evil.example:8787" }),
      runtime(root)
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden: invalid local request origin");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
  });

  it("creating a note through the UI creates a draft, not approved memory", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const response = await handleUiRequest(
      formRequest("/drafts", { text: "UI intake note about Seedance review." }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Saved for review.");
    expect(listPendingDrafts(runtime(root))).toHaveLength(1);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("long Add memory input shows a choice before creating a pending memory", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const response = await handleUiRequest(formRequest("/drafts", { text: longAddMemoryText() }), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("This looks like a long note or source.");
    expect(html).toContain("Long context blocks can become hard to retrieve later. Choose how to handle it.");
    expect(html).toContain("Split into context suggestions");
    expect(html).toContain("Import as source");
    expect(html).toContain("Save as one context item anyway");
    expect(html).not.toContain("memory_entries");
    expect(html).not.toContain("memory_drafts");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("long Add memory can still be saved as one pending memory by choice", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const text = longAddMemoryText();

    const response = await handleUiRequest(formRequest("/drafts/long/save-one", { text }), runtime(root));
    const html = await response.text();
    const drafts = listPendingDrafts(runtime(root));

    expect(response.status).toBe(200);
    expect(html).toContain("Saved for review.");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.proposed_content).toContain("Source review workflow");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("long Add memory can be imported as a source without creating memory", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const response = await handleUiRequest(formRequest("/drafts/long/import", { text: longAddMemoryText() }), runtime(root));
    const html = await response.text();
    const sources = listSources(runtime(root));

    expect(response.status).toBe(200);
    expect(html).toContain("Imported &quot;Source review workflow&quot; as a source");
    expect(sources).toHaveLength(1);
    expect(sources[0]?.title).toBe("Source review workflow");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("long Add memory can split into multiple pending suggestions only", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const text = longAddMemoryText();

    const response = await handleUiRequest(formRequest("/drafts/long/split", { text }), runtime(root));
    const html = await response.text();
    const drafts = listPendingDrafts(runtime(root));

    expect(response.status).toBe(200);
    expect(html).toContain("context suggestions for review");
    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts.map((draft) => draft.proposed_content).join("\n")).toContain("inline source suggestions");
    expect(drafts.every((draft) => draft.proposed_content.length < text.length)).toBe(true);
    expect(drafts.every((draft) => draft.status === "pending")).toBe(true);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);

    approveDraft(drafts[0]!.id, runtime(root));
    expect(listApprovedMemories(runtime(root))).toHaveLength(1);
  });

  it("approving through the UI creates approved memory through existing logic", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Approve this UI draft into memory.", runtime(root));

    const response = await handleUiRequest(
      formRequest("/drafts/approve", { draftId: String(draft.id) }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Approved context.");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(1);
    expect(listApprovedMemories(runtime(root))[0]?.content).toContain("Approve this UI draft");
  });

  it("shows a visible Manage context entry point in the main page navigation", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Manage context");
    expect(html).toContain('href="/memories"');
  });

  it("makes Crates the primary home page with create and saved crate flows", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<h1>Context crates</h1>");
    expect(html).toContain("A crate is a saved Markdown context pack you can copy or download for an LLM.");
    expect(html).toContain("Create crate");
    expect(html).toContain("Saved crates");
    expect(html).toContain('action="/memory-pack/export"');
  });

  it("includes a Capture link in the main navigation", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('href="/capture"');
  });

  it("keeps chat input and history on the capture page", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/capture"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('textarea[name="message"]');
    expect(html).toContain('action="/chat/send"');
  });

  it("manage memories page renders active approved memories with edit and retire controls", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Approved memory that can be corrected.", runtime(root));
    approveDraft(draft.id, runtime(root));

    const response = await handleUiRequest(getRequest("/memories"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Manage context");
    expect(html).toContain("Approved memory that can be corrected.");
    expect(html).toContain("Edit context");
    expect(html).toContain("Retire context");
    expect(html).toContain('action="/memories/edit"');
    expect(html).toContain('action="/memories/retire"');
  });

  it("does not require Claude API env vars to open the manage memories page", async () => {
    const root = makeProject();
    const priorProvider = process.env.HERMES_CHAT_PROVIDER;
    const priorKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.HERMES_CHAT_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const home = await handleUiRequest(getRequest("/capture"), runtime(root));
      const manage = await handleUiRequest(getRequest("/memories"), runtime(root));

      expect(home.status).toBe(200);
      expect(await home.text()).toContain("Mode: Local");
      expect(manage.status).toBe(200);
      expect(await manage.text()).toContain("Manage context");
    } finally {
      if (priorProvider !== undefined) process.env.HERMES_CHAT_PROVIDER = priorProvider;
      if (priorKey !== undefined) process.env.ANTHROPIC_API_KEY = priorKey;
    }
  });

  it("does not let the chat path edit, retire, or otherwise mutate approved memory", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Durable memory the model must not touch.", runtime(root));
    const memory = approveDraft(draft.id, runtime(root));

    // Messages that try to coax the model into managing memory directly.
    for (const message of [
      `Please retire memory ${memory.id}.`,
      `Edit memory ${memory.id} to say something else.`,
      `Delete all my approved memories now.`
    ]) {
      const response = await handleUiRequest(formRequest("/chat/send", { message }), runtime(root));
      expect(response.status).toBe(200);
    }

    const active = listApprovedMemories(runtime(root));
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(memory.id);
    expect(active[0]?.content).toBe("Durable memory the model must not touch.");
    expect(listRetiredMemories(runtime(root))).toHaveLength(0);
    expect(fs.existsSync(path.join(root, ".hermes", "export"))).toBe(false);
  });

  it("memory pack page renders active approved memories with checkboxes", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [activeDraft] = intakeText("Approved memory pack UI memory.", runtime(root));
    const [retiredDraft] = intakeText("Retired memory pack UI memory.", runtime(root));
    approveDraft(activeDraft.id, runtime(root));
    const retired = approveDraft(retiredDraft.id, runtime(root));
    retireApprovedMemory(retired.id, runtime(root));

    const response = await handleUiRequest(getRequest("/memory-pack"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<h1>Context crates</h1>");
    expect(html).toContain("Approved memory pack UI memory.");
    expect(html).not.toContain("Retired memory pack UI memory.");
    expect(html).toContain('type="checkbox" name="memoryId"');
    expect(html).toContain('action="/memory-pack/export"');
    expect(html).toContain("Settled decisions / things not to reopen");
    expect(html).toContain(
      "Add decisions that are already settled, so a coding assistant does not waste time suggesting them again."
    );
  });

  it("memory pack search shows matching active approved memories only", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [amberDraft] = intakeText("Amber project memory pack preference.", runtime(root));
    const [cobaltDraft] = intakeText("Cobalt project memory pack preference.", runtime(root));
    approveDraft(amberDraft.id, runtime(root));
    approveDraft(cobaltDraft.id, runtime(root));

    const response = await handleUiRequest(getRequest("/memory-pack?query=Amber"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Amber project memory pack preference.");
    expect(html).not.toContain("Cobalt project memory pack preference.");
  });

  it("memory pack export writes Markdown under .hermes/export and renders it for copy/paste", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Coding agents should receive approved context only.", runtime(root));
    const memory = approveDraft(draft.id, runtime(root));

    const response = await handleUiRequest(
      formRequest("/memory-pack/export", {
        title: "HERmes export test",
        currentNextStep: "Review the generated context pack.",
        settledDecisions: "Do not connect to agents.",
        memoryId: String(memory.id)
      }),
      runtime(root)
    );
    const html = await response.text();
    const exportDir = path.join(root, ".hermes", "export");
    const files = fs.readdirSync(exportDir).filter((file) => file.endsWith(".md"));
    const markdown = fs.readFileSync(path.join(exportDir, files[0] ?? ""), "utf8");

    expect(response.status).toBe(200);
    expect(html).toContain("Crate generated. Copy, download, or save it below.");
    expect(html).toContain("Local export path:");
    expect(html).toContain("Generated crate");
    expect(html).toContain("Copy crate");
    expect(html).toContain("Download Markdown");
    expect(html).toContain("Save crate");
    expect(html).toContain("Saved crates");
    expect(html).toContain('action="/memory-pack/save"');
    expect(html).toContain('id="copy-context-pack"');
    expect(html).toContain('id="generated-context-pack"');
    expect(html).toContain("navigator.clipboard.writeText");
    expect(html).toContain("# Project Context Pack: HERmes export test");
    expect(html).toContain("Coding agents should receive approved context only.");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^project-context-pack-\d{8}-\d{6}\.md$/);
    expect(markdown).toContain("# Project Context Pack: HERmes export test");
    expect(markdown).toContain("## Settled decisions / things not to reopen");
    expect(markdown).toContain(`#### Context ${memory.id}`);
    expect(markdown).toContain("Coding agents should receive approved context only.");
    expect(markdown).toContain(
      "This is context for a coding assistant. It is not permission to edit files, commit, push, run commands, access accounts, or take external actions unless James explicitly says so in the current work order."
    );

    const download = await handleUiRequest(
      getRequest(`/memory-pack/download?file=${encodeURIComponent(files[0] ?? "")}`),
      runtime(root)
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition") ?? "").toContain(`filename="${files[0]}"`);
    expect(await download.text()).toBe(markdown);
  });

  it("saves, lists, views, copies, and downloads a generated context pack in the UI", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const markdown = "# Project Context Pack: Saved UI pack\n\nApproved context snapshot.";

    const save = await handleUiRequest(
      formRequest("/memory-pack/save", {
        title: "Saved UI pack",
        markdown,
        exportPath: path.join(root, ".hermes", "export", "saved-ui-pack.md")
      }),
      runtime(root)
    );
    const saveHtml = await save.text();
    const [saved] = listSavedContextPacks(runtime(root));

    expect(save.status).toBe(200);
    expect(saved?.title).toBe("Saved UI pack");
    expect(saved?.markdown).toBe(markdown);
    expect(saveHtml).toContain("Saved crates");
    expect(saveHtml).toContain("Saved crate &quot;Saved UI pack&quot;.");
    expect(saveHtml).toContain('id="copy-saved-context-pack"');
    expect(saveHtml).toContain("Copy crate");
    expect(saveHtml).toContain("Download Markdown");
    expect(saveHtml).toContain(markdown);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);

    const view = await handleUiRequest(getRequest(`/memory-pack?savedPack=${saved!.id}`), runtime(root));
    const viewHtml = await view.text();
    expect(view.status).toBe(200);
    expect(viewHtml).toContain("Generated crate");
    expect(viewHtml).toContain(markdown);
    expect(viewHtml).toContain("navigator.clipboard.writeText");

    const download = await handleUiRequest(
      getRequest(`/memory-pack/saved/download?id=${saved!.id}`),
      runtime(root)
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition") ?? "").toContain('filename="saved-ui-pack.md"');
    expect(await download.text()).toBe(`${markdown}\n`);
  });

  it("editing an approved memory through the UI creates an active replacement", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Old UI approved memory.", runtime(root));
    const memory = approveDraft(draft.id, runtime(root));

    const response = await handleUiRequest(
      formRequest("/memories/edit", {
        memoryId: String(memory.id),
        content: "Updated UI approved memory with better retrieval wording.",
        note: "Better wording"
      }),
      runtime(root)
    );
    const html = await response.text();
    const active = listApprovedMemories(runtime(root));
    const retired = listRetiredMemories(runtime(root));

    expect(response.status).toBe(200);
    expect(html).toContain("Replacement context item");
    expect(active).toHaveLength(1);
    expect(active[0]?.content).toContain("better retrieval wording");
    expect(active[0]?.supersedes_id).toBe(memory.id);
    expect(retired).toHaveLength(1);
    expect(retired[0]?.status).toBe("superseded");
  });

  it("retiring an approved memory through the UI hides it from normal memory search", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Cobalt retired UI memory.", runtime(root));
    const memory = approveDraft(draft.id, runtime(root));

    const response = await handleUiRequest(
      formRequest("/memories/retire", { memoryId: String(memory.id), reason: "outdated" }),
      runtime(root)
    );
    const retiredPage = await handleUiRequest(getRequest("/memories?retired=1"), runtime(root));
    const searchPage = await handleUiRequest(getRequest("/memories?query=Cobalt"), runtime(root));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Retired context item");
    expect(await searchPage.text()).toContain('No approved context matched "Cobalt".');
    const retiredHtml = await retiredPage.text();
    expect(retiredHtml).toContain("Retired and superseded context is kept for inspection");
    expect(retiredHtml).toContain("Cobalt retired UI memory.");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
    expect(listRetiredMemories(runtime(root))).toHaveLength(1);
  });

  it("rejecting through the UI does not create approved memory", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Reject this UI draft.", runtime(root));

    const response = await handleUiRequest(
      formRequest("/drafts/reject", { draftId: String(draft.id) }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Dismissed.");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("UI search and reflection use approved memories only", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [approvedDraft] = intakeText("Approved amber workflow memory.", runtime(root));
    const [rejectedDraft] = intakeText("Rejected cobalt workflow draft.", runtime(root));
    approveDraft(approvedDraft.id, runtime(root));
    await handleUiRequest(formRequest("/drafts/reject", { draftId: String(rejectedDraft.id) }), runtime(root));

    const approvedSearch = await handleUiRequest(getRequest("/memories?query=amber"), runtime(root));
    const rejectedSearch = await handleUiRequest(getRequest("/memories?query=cobalt"), runtime(root));
    const rejectedReflection = await handleUiRequest(
      formRequest("/reflect", { question: "What about cobalt?" }),
      runtime(root)
    );

    expect(await approvedSearch.text()).toContain("Approved amber workflow");
    expect(await rejectedSearch.text()).toContain('No approved context matched "cobalt".');
    expect(await rejectedReflection.text()).toContain("No approved local context matched this question.");
    expect(reflectOnApprovedMemory("What about cobalt?", runtime(root)).relevantMemoryIds).toEqual([]);
  });

  it("chat endpoint returns an assistant response and persists messages", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Seedance storyboard ideas should stay small and inspectable.", runtime(root));
    const memory = approveDraft(draft.id, runtime(root));

    const response = await handleUiRequest(
      formRequest("/chat/send", { message: "What ideas fit the Seedance storyboard?" }),
      runtime(root)
    );
    const html = await response.text();
    const [session] = listChatSessions(runtime(root));

    expect(response.status).toBe(200);
    expect(html).toContain("ContextCrate");
    expect(html).toContain("Sources from approved context");
    expect(html).toContain(`[${memory.id}]`);
    expect(html).toContain("Seedance storyboard ideas");
    expect(session).toBeDefined();
    expect(listChatMessages(session.id, runtime(root)).map((message) => message.role)).toEqual([
      "user",
      "hermes"
    ]);
  });

  it("chat endpoint shows organic memory suggestions for durable statements", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const response = await handleUiRequest(
      formRequest("/chat/send", {
        message: "I prefer project notes that end with one tiny artifact I can inspect."
      }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("This seems useful as approved context.");
    expect(html).toContain("Proposed context");
    expect(html).toContain("Save for review");
    expect(html).toContain("Dismiss");
    expect(html).toContain("I prefer project notes");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("direct remember requests create a pending draft only through chat", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const response = await handleUiRequest(
      formRequest("/chat/send", {
        message: "remember that I love quiet local tools that ask before memory becomes official."
      }),
      runtime(root)
    );
    const html = await response.text();
    const pendingDrafts = listPendingDrafts(runtime(root));

    expect(response.status).toBe(200);
    expect(html).toContain("Saved for review.");
    expect(pendingDrafts).toHaveLength(1);
    expect(pendingDrafts[0]?.status).toBe("pending");
    expect(pendingDrafts[0]?.source_type).toBe("chat");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("command-only remember requests ask for payload instead of creating a draft", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const response = await handleUiRequest(
      formRequest("/chat/send", { message: "Can you remember this?" }),
      runtime(root)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Paste the information you want added to context");
    expect(html).not.toContain("This seems useful as approved context.");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("saving an organic suggestion creates a pending draft only", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    await handleUiRequest(
      formRequest("/chat/send", {
        message: "My goal is to capture durable preferences without making HERmes an agent."
      }),
      runtime(root)
    );
    const [session] = listChatSessions(runtime(root));
    const [userMessage] = listChatMessages(session.id, runtime(root));

    const page = await handleUiRequest(getRequest("/capture"), runtime(root));
    const html = await page.text();
    const suggestionKey = html.match(/name="suggestionKey" value="([^"]+)"/)?.[1];
    expect(suggestionKey).toBeDefined();

    const response = await handleUiRequest(
      formRequest("/memory-suggestions/save", {
        sessionId: String(session.id),
        messageId: String(userMessage.id),
        suggestionKey: suggestionKey ?? "",
        proposedContent: "My goal is to capture durable preferences without making HERmes an agent."
      }),
      runtime(root)
    );
    const savedHtml = await response.text();
    const pendingDrafts = listPendingDrafts(runtime(root));

    expect(response.status).toBe(200);
    expect(savedHtml).toContain("Saved for review.");
    expect(savedHtml).not.toContain("This seems useful as approved context.");
    expect(pendingDrafts).toHaveLength(1);
    expect(pendingDrafts[0]?.status).toBe("pending");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("dismissing an organic suggestion hides it for that message", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    await handleUiRequest(
      formRequest("/chat/send", {
        message: "Going forward, I want HERmes memory prompts to stay small and optional."
      }),
      runtime(root)
    );
    const [session] = listChatSessions(runtime(root));
    const [userMessage] = listChatMessages(session.id, runtime(root));
    const page = await handleUiRequest(getRequest("/capture"), runtime(root));
    const html = await page.text();
    const suggestionKey = html.match(/name="suggestionKey" value="([^"]+)"/)?.[1];
    expect(suggestionKey).toBeDefined();

    const response = await handleUiRequest(
      formRequest("/memory-suggestions/dismiss", {
        sessionId: String(session.id),
        messageId: String(userMessage.id),
        suggestionKey: suggestionKey ?? ""
      }),
      runtime(root)
    );
    const dismissedHtml = await response.text();

    expect(response.status).toBe(200);
    expect(dismissedHtml).toContain("Context suggestion dismissed.");
    expect(dismissedHtml).not.toContain("This seems useful as approved context.");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
  });

  it("chat save-draft creates a pending draft only", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Approved amber chat memory.", runtime(root));
    approveDraft(draft.id, runtime(root));
    await handleUiRequest(formRequest("/chat/send", { message: "Reflect on amber chat." }), runtime(root));
    const [session] = listChatSessions(runtime(root));

    const response = await handleUiRequest(
      formRequest("/chat/save-draft", { sessionId: String(session.id) }),
      runtime(root)
    );
    const html = await response.text();
    const pendingDrafts = listPendingDrafts(runtime(root));

    expect(response.status).toBe(200);
    expect(html).toContain("Saved for review.");
    expect(pendingDrafts).toHaveLength(1);
    expect(pendingDrafts[0]?.status).toBe("pending");
    expect(pendingDrafts[0]?.source_type).toBe("chat");
    expect(listApprovedMemories(runtime(root))).toHaveLength(1);
  });

  it("UI export writes JSON under .hermes/export", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Export this UI approved memory.", runtime(root));
    approveDraft(draft.id, runtime(root));

    const response = await handleUiRequest(formRequest("/export", {}), runtime(root));
    const html = await response.text();
    const exportPath = path.join(root, ".hermes", "export", "memories-export.json");

    expect(response.status).toBe(200);
    expect(html).toContain("Approved context exported locally.");
    expect(html).toContain(exportPath);
    expect(fs.existsSync(exportPath)).toBe(true);
  });

  it("local UI server binds to localhost only", async () => {
    const root = makeProject();
    const started = await startUiServer({ ...runtime(root), port: 0 });

    try {
      const address = started.server.address();
      expect(started.host).toBe(DEFAULT_UI_HOST);
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(typeof address === "object" && address ? address.address : "").toBe(DEFAULT_UI_HOST);
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    await expect(startUiServer({ ...runtime(root), host: "0.0.0.0", port: 0 })).rejects.toThrow(
      /loopback/
    );
  });
});
