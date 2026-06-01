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
  reflectOnApprovedMemory
} from "../src/hermes.js";
import { DEFAULT_UI_HOST, handleUiRequest, startUiServer } from "../src/ui.js";
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
    expect(html).toContain("HERmes");
    expect(html).toContain("Just start chatting. HERmes will suggest memories when something seems worth saving.");
    expect(fs.existsSync(path.join(root, ".hermes", "hermes.db"))).toBe(true);
  });

  it("uses human-facing memory language on the default chat page", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Review memory suggestions");
    expect(html).toContain("Save for review");
    expect(html).toContain(
      "HERmes can suggest memories from chat. Nothing becomes an approved memory until you approve it."
    );
    expect(html).not.toContain(">Create draft<");
    expect(html).not.toContain(">Save as draft<");
    expect(html).not.toContain("Review drafts");
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
    expect(html).not.toContain("HERmes posture");
    expect(html).not.toContain("Initialize Local Database");
    expect(html).toContain('href="/system"');
  });

  it("shows the conversation mode label and hides the prominent System button", async () => {
    const root = makeProject();

    const response = await handleUiRequest(getRequest("/"), runtime(root));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Mode: Local deterministic");
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
    expect(html).toContain("Approved memory.");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(1);
    expect(listApprovedMemories(runtime(root))[0]?.content).toContain("Approve this UI draft");
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
    expect(await rejectedSearch.text()).toContain('No approved memories matched "cobalt".');
    expect(await rejectedReflection.text()).toContain("No approved local memories matched this question.");
    expect(reflectOnApprovedMemory("What about cobalt?", runtime(root)).relevantMemoryIds).toEqual([]);
  });

  it("chat endpoint returns a HERmes response and persists messages", async () => {
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
    expect(html).toContain("HERmes");
    expect(html).toContain("Sources from your memory");
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
    expect(html).toContain("This seems worth remembering.");
    expect(html).toContain("Proposed memory");
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

    const page = await handleUiRequest(getRequest("/"), runtime(root));
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
    expect(savedHtml).not.toContain("This seems worth remembering.");
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
    const page = await handleUiRequest(getRequest("/"), runtime(root));
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
    expect(dismissedHtml).toContain("Memory suggestion dismissed.");
    expect(dismissedHtml).not.toContain("This seems worth remembering.");
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
    expect(html).toContain("Approved memories exported locally.");
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
