#!/usr/bin/env node
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createChatSession,
  listChatMessages,
  listChatSessions,
  saveLatestChatExchangeDraft,
  sendChatMessage
} from "./chat.js";
import {
  approveDraft,
  doctor,
  exportApprovedMemories,
  initHermes,
  intakeText,
  listApprovedMemories,
  listPendingDrafts,
  reflectOnApprovedMemory,
  rejectDraft,
  searchApprovedMemories
} from "./hermes.js";
import { formatDoctor } from "./format.js";
import type {
  ChatMessage,
  ChatTurn,
  HermesRuntimeOptions,
  MemoryDraft,
  MemoryEntry,
  ReflectionReport,
  SearchResult
} from "./types.js";

export const DEFAULT_UI_HOST = "127.0.0.1";
export const DEFAULT_UI_PORT = 8787;

type NoticeKind = "success" | "error" | "info";

interface Notice {
  kind: NoticeKind;
  message: string;
}

interface RenderState {
  notice?: Notice;
  activeSessionId?: number;
  chatTurn?: ChatTurn;
  searchQuery?: string;
  searchResults?: SearchResult[];
  reflection?: ReflectionReport;
  exportPath?: string;
}

export interface UiServerOptions extends HermesRuntimeOptions {
  host?: string;
  port?: number;
}

interface StartedUiServer {
  server: Server;
  host: string;
  port: number;
  url: string;
}

interface UiMemorySource {
  id: number;
  snippet: string;
}

const POST_CONTENT_TYPE = "application/x-www-form-urlencoded";
const FORBIDDEN_LOCAL_REQUEST = "Forbidden: invalid local request origin";

export async function handleUiRequest(
  request: Request,
  runtime: HermesRuntimeOptions = {}
): Promise<Response> {
  const url = new URL(request.url);
  const guard = guardLocalUiRequest(request, url);
  if (guard) {
    return guard;
  }

  try {
    if (request.method === "GET" && url.pathname === "/") {
      return htmlResponse(renderPage(runtime));
    }

    if (request.method === "POST" && url.pathname === "/chat/send") {
      const form = await readForm(request);
      const message = requiredFormValue(form, "message", "Chat message is required.");
      const sessionId = parseOptionalPositiveInteger(form.get("sessionId") ?? "");
      const chatTurn = sendChatMessage(message, { ...runtime, sessionId });
      return htmlResponse(renderPage(runtime, { activeSessionId: chatTurn.session.id, chatTurn }));
    }

    if (request.method === "POST" && url.pathname === "/chat/save-draft") {
      const form = await readForm(request);
      const sessionId = parseDraftId(requiredFormValue(form, "sessionId", "Chat session id is required."));
      const draft = saveLatestChatExchangeDraft(sessionId, runtime);
      return htmlResponse(
        renderPage(runtime, {
          activeSessionId: sessionId,
          notice: {
            kind: "success",
            message: `Created pending draft ${draft.id}. Review and approve it separately if it should become memory.`
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/chat/new") {
      const session = createChatSession(runtime, "Web chat");
      return htmlResponse(
        renderPage(runtime, {
          activeSessionId: session.id,
          notice: { kind: "info", message: "Started a new local chat session." }
        })
      );
    }

    if (request.method === "GET" && url.pathname === "/memories") {
      const searchQuery = (url.searchParams.get("query") ?? "").trim();
      const searchResults = searchQuery ? searchApprovedMemories(searchQuery, runtime) : undefined;
      return htmlResponse(renderPage(runtime, { searchQuery, searchResults }));
    }

    if (request.method === "POST" && url.pathname === "/init") {
      initHermes(runtime);
      return htmlResponse(
        renderPage(runtime, {
          notice: { kind: "success", message: "Local HERmes database initialized." }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/drafts") {
      const form = await readForm(request);
      const text = requiredFormValue(form, "text", "Note text is required.");
      const drafts = intakeText(text, runtime);
      return htmlResponse(
        renderPage(runtime, {
          notice: {
            kind: "success",
            message: `Created pending draft${drafts.length === 1 ? "" : "s"}: ${drafts
              .map((draft) => draft.id)
              .join(", ")}.`
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/drafts/approve") {
      const form = await readForm(request);
      const draftId = parseDraftId(requiredFormValue(form, "draftId", "Draft id is required."));
      const memory = approveDraft(draftId, runtime);
      return htmlResponse(
        renderPage(runtime, {
          notice: { kind: "success", message: `Approved draft ${draftId} as memory ${memory.id}.` }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/drafts/reject") {
      const form = await readForm(request);
      const draftId = parseDraftId(requiredFormValue(form, "draftId", "Draft id is required."));
      rejectDraft(draftId, runtime);
      return htmlResponse(
        renderPage(runtime, {
          notice: { kind: "success", message: `Rejected draft ${draftId}.` }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/reflect") {
      const form = await readForm(request);
      const question = requiredFormValue(form, "question", "Reflection question is required.");
      const reflection = reflectOnApprovedMemory(question, runtime);
      return htmlResponse(renderPage(runtime, { reflection }));
    }

    if (request.method === "POST" && url.pathname === "/export") {
      const exportPath = exportApprovedMemories(runtime);
      return htmlResponse(
        renderPage(runtime, {
          exportPath,
          notice: { kind: "success", message: "Approved memories exported locally." }
        })
      );
    }

    return htmlResponse(renderPage(runtime, { notice: { kind: "error", message: "Page not found." } }), 404);
  } catch (error) {
    return htmlResponse(
      renderPage(runtime, {
        notice: { kind: "error", message: error instanceof Error ? error.message : String(error) }
      }),
      400
    );
  }
}

export async function startUiServer(options: UiServerOptions = {}): Promise<StartedUiServer> {
  const host = options.host ?? DEFAULT_UI_HOST;
  assertLoopbackHost(host);
  const port = options.port ?? DEFAULT_UI_PORT;

  const server = http.createServer((request, response) => {
    void routeNodeRequest(request, response, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${formatHostForUrl(host)}:${actualPort}`;
  return { server, host, port: actualPort, url };
}

function renderPage(runtime: HermesRuntimeOptions, state: RenderState = {}): string {
  const model = readUiModel(runtime, state);
  const statusClass = model.report.dbExists ? "status-ok" : "status-warn";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HERmes Local Web Chat</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #18211f;
      --muted: #5f6b67;
      --line: #d7dfdc;
      --paper: #f7f9f7;
      --panel: #ffffff;
      --accent: #216b57;
      --accent-strong: #174b3e;
      --warn: #8a5a17;
      --danger: #a43a32;
      --blue: #245c85;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.45;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .wrap {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding: 22px 0;
    }
    h1 {
      margin: 0;
      font-size: 1.6rem;
      letter-spacing: 0;
    }
    .subtitle {
      margin: 4px 0 0;
      color: var(--muted);
      max-width: 720px;
    }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    nav a {
      color: var(--accent-strong);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 10px;
      text-decoration: none;
      background: #fbfcfb;
      font-size: 0.94rem;
    }
    main {
      display: grid;
      gap: 22px;
      padding: 24px 0 42px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
    }
    .section-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    h2 {
      margin: 0;
      font-size: 1.1rem;
      letter-spacing: 0;
    }
    .hint {
      color: var(--muted);
      margin: 4px 0 0;
      font-size: 0.95rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .stack {
      display: grid;
      gap: 12px;
    }
    .notice {
      border-radius: 8px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      background: #eef8f4;
      color: var(--accent-strong);
    }
    .notice.error {
      background: #fff2f1;
      color: var(--danger);
      border-color: #e8c6c2;
    }
    .notice.info {
      background: #eef5fb;
      color: var(--blue);
      border-color: #c8d9e7;
    }
    .status-line {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 0 0 12px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      border-radius: 999px;
      padding: 5px 10px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #fbfcfb;
      font-size: 0.9rem;
    }
    .status-ok {
      color: var(--accent-strong);
      border-color: #b7d7cc;
      background: #eff8f4;
    }
    .status-warn {
      color: var(--warn);
      border-color: #e6d1a8;
      background: #fff8e8;
    }
    label {
      display: grid;
      gap: 7px;
      font-weight: 650;
    }
    textarea,
    input[type="search"],
    input[type="text"] {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 11px 12px;
      color: var(--ink);
      background: #fff;
      font: inherit;
    }
    textarea {
      min-height: 150px;
      resize: vertical;
    }
    button {
      border: 0;
      border-radius: 7px;
      padding: 10px 13px;
      color: #fff;
      background: var(--accent);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover {
      background: var(--accent-strong);
    }
    button.secondary {
      color: var(--accent-strong);
      border: 1px solid var(--line);
      background: #fbfcfb;
    }
    button.secondary:hover {
      background: #eef8f4;
    }
    button.danger {
      background: var(--danger);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .item {
      border-top: 1px solid var(--line);
      padding-top: 14px;
    }
    .item:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .item-title {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: baseline;
      margin: 0 0 6px;
      font-weight: 750;
    }
    .meta {
      color: var(--muted);
      font-size: 0.92rem;
      margin: 0 0 8px;
    }
    .content {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
    }
    pre {
      overflow-x: auto;
      margin: 0;
      padding: 12px;
      border-radius: 7px;
      border: 1px solid var(--line);
      background: #fbfcfb;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .search-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
    }
    .empty {
      color: var(--muted);
      margin: 0;
    }
    .chat-shell {
      display: grid;
      gap: 14px;
    }
    .chat-thread {
      display: grid;
      gap: 12px;
      min-height: 280px;
      max-height: 58vh;
      overflow-y: auto;
      padding: 6px 2px;
    }
    .chat-message {
      width: min(760px, 100%);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 13px 14px;
      background: #fbfcfb;
    }
    .chat-message.user {
      justify-self: end;
      background: #eef8f4;
      border-color: #b7d7cc;
    }
    .chat-message.hermes {
      justify-self: start;
      background: #ffffff;
    }
    .speaker {
      margin: 0 0 7px;
      color: var(--muted);
      font-weight: 750;
      font-size: 0.86rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .message-body {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .memory-sources {
      display: grid;
      gap: 6px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 0.93rem;
    }
    .memory-sources p {
      margin: 0;
    }
    .chat-compose {
      display: grid;
      gap: 10px;
    }
    .chat-compose textarea {
      min-height: 92px;
    }
    .chat-toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    @media (max-width: 760px) {
      .topbar,
      .section-head {
        display: grid;
      }
      .grid,
      .search-row {
        grid-template-columns: 1fr;
      }
      nav a,
      button {
        width: 100%;
        text-align: center;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap topbar">
      <div>
        <h1>HERmes Local Web Chat</h1>
        <p class="subtitle">A private local chat and review interface over approved memory. No external calls, no tools, no autonomous actions.</p>
      </div>
      <nav aria-label="Sections">
        <a href="#chat">Chat</a>
        <a href="#status">Status</a>
        <a href="#review">Review</a>
        <a href="#add-note">Add Note</a>
        <a href="#memories">Memories</a>
        <a href="#reflect">Reflect</a>
        <a href="#export">Export</a>
      </nav>
    </div>
  </header>
  <main class="wrap">
    ${state.notice ? renderNotice(state.notice) : ""}
    <section id="chat">
      <div class="section-head">
        <div>
          <h2>Chat</h2>
          <p class="hint">A local deterministic idea mirror. Responses use approved memory only and never approve memory automatically.</p>
        </div>
        <form method="post" action="/chat/new">
          <button class="secondary" type="submit"${model.canReadMemory ? "" : " disabled"}>New Chat</button>
        </form>
      </div>
      ${renderChat(model)}
    </section>

    <section id="status">
      <div class="section-head">
        <div>
          <h2>Status</h2>
          <p class="hint">Only approved memories are used for list/search/reflect/chat.</p>
        </div>
        <form method="post" action="/init">
          <button class="secondary" type="submit">Initialize Local Database</button>
        </form>
      </div>
      <div class="status-line">
        <span class="pill ${statusClass}">Database ${model.report.dbExists ? "ready" : "not initialized"}</span>
        <span class="pill">Pending drafts: ${model.report.pendingDraftCount}</span>
        <span class="pill">Approved memories: ${model.report.approvedMemoryCount}</span>
        <span class="pill">Local-only</span>
        <span class="pill">No LLM/API/connectors</span>
      </div>
      <pre>${escapeHtml(formatDoctor(model.report))}</pre>
    </section>

    <section id="add-note">
      <div class="section-head">
        <div>
          <h2>Add Note</h2>
          <p class="hint">Creates a pending draft. It does not approve memory automatically.</p>
        </div>
      </div>
      <form class="stack" method="post" action="/drafts">
        <label>
          Note text
          <textarea name="text" required placeholder="Paste or type a note for HERmes to turn into a draft."></textarea>
        </label>
        <div class="actions">
          <button type="submit">Create Draft</button>
        </div>
      </form>
    </section>

    <section id="review">
      <div class="section-head">
        <div>
          <h2>Review Drafts</h2>
          <p class="hint">Approval creates memory. Rejection does not create memory.</p>
        </div>
      </div>
      ${renderDrafts(model.pendingDrafts)}
    </section>

    <section id="memories">
      <div class="section-head">
        <div>
          <h2>Approved Memories</h2>
          <p class="hint">Empty search shows approved memories. Rejected drafts are not shown as memories.</p>
        </div>
      </div>
      <form class="search-row" method="get" action="/memories">
        <label>
          Search approved memory
          <input type="search" name="query" value="${escapeAttribute(model.searchQuery)}" placeholder="Search text, tags, category, or source">
        </label>
        <button type="submit">Search</button>
      </form>
      <div class="stack" style="margin-top: 16px;">
        ${renderMemoryResults(model)}
      </div>
    </section>

    <section id="reflect">
      <div class="section-head">
        <div>
          <h2>Reflect</h2>
          <p class="hint">Deterministic reflection from approved memories only. No LLM wording.</p>
        </div>
      </div>
      <form class="stack" method="post" action="/reflect">
        <label>
          Question
          <input type="text" name="question" required placeholder="What should I remember about this pattern?">
        </label>
        <div class="actions">
          <button type="submit">Reflect</button>
        </div>
      </form>
      ${state.reflection ? renderReflection(state.reflection) : ""}
    </section>

    <section id="export">
      <div class="section-head">
        <div>
          <h2>Export</h2>
          <p class="hint">Writes approved memory JSON locally under .hermes/export. Nothing is uploaded.</p>
        </div>
      </div>
      <form method="post" action="/export">
        <button type="submit">Export JSON</button>
      </form>
      ${state.exportPath ? `<p class="notice info" style="margin-top: 14px;">Export path: ${escapeHtml(state.exportPath)}</p>` : ""}
    </section>
  </main>
</body>
</html>`;
}

function readUiModel(runtime: HermesRuntimeOptions, state: RenderState) {
  const report = doctor(runtime);
  const canReadMemory = report.dbExists && Object.values(report.tables).every(Boolean);
  const pendingDrafts = canReadMemory ? listPendingDrafts(runtime) : [];
  const approvedMemories = canReadMemory ? listApprovedMemories(runtime) : [];
  const chatSessions = canReadMemory ? listChatSessions(runtime) : [];
  const activeSessionId = state.chatTurn?.session.id ?? state.activeSessionId ?? chatSessions.at(-1)?.id;
  const chatMessages =
    canReadMemory && activeSessionId ? listChatMessages(activeSessionId, runtime) : [];
  const latestHermesMessage = findLatestHermesMessage(chatMessages);
  const latestMemorySources = state.chatTurn
    ? state.chatTurn.response.memoriesUsed.map(({ memory, snippet }) => ({ id: memory.id, snippet }))
    : latestHermesMessage
      ? memorySourcesForMessage(latestHermesMessage, approvedMemories)
      : [];
  const searchQuery = state.searchQuery ?? "";

  return {
    report,
    canReadMemory,
    pendingDrafts,
    approvedMemories,
    chatSessions,
    activeSessionId,
    chatMessages,
    latestHermesMessage,
    latestMemorySources,
    searchQuery,
    searchResults: state.searchResults
  };
}

function renderChat(model: ReturnType<typeof readUiModel>): string {
  const sessionInput = model.activeSessionId
    ? `<input type="hidden" name="sessionId" value="${model.activeSessionId}">`
    : "";
  const disabled = model.canReadMemory ? "" : " disabled";

  return `<div class="chat-shell">
    <div class="chat-thread" aria-live="polite">
      ${
        model.chatMessages.length > 0
          ? model.chatMessages.map((message) => renderChatMessage(message, model.approvedMemories)).join("")
          : `<p class="empty">No chat messages yet. Start with an idea, question, or "what does this make you think of?"</p>`
      }
    </div>

    <form class="chat-compose" method="post" action="/chat/send">
      ${sessionInput}
      <label>
        Message
        <textarea name="message" required${disabled} placeholder="Ask HERmes to mirror an idea, connect it to memory, or generate directions."></textarea>
      </label>
      <div class="chat-toolbar">
        <div class="actions">
          <button type="submit"${disabled}>Send</button>
        </div>
        <p class="hint">${
          model.canReadMemory
            ? "Chat is saved locally in SQLite. Saving an exchange creates a draft only."
            : "Initialize the local database before chatting."
        }</p>
      </div>
    </form>

    <div class="chat-toolbar">
      <form method="post" action="/chat/save-draft">
        ${sessionInput}
        <button class="secondary" type="submit"${
          model.activeSessionId && model.latestHermesMessage ? "" : " disabled"
        }>Save as draft</button>
      </form>
      ${renderLatestMemorySources(model.latestHermesMessage, model.latestMemorySources)}
    </div>
  </div>`;
}

function renderChatMessage(message: ChatMessage, approvedMemories: MemoryEntry[]): string {
  const speaker = message.role === "user" ? "You" : "HERmes";
  const content = message.role === "hermes" ? stripMemoriesUsedSection(message.content) : message.content;
  const sources =
    message.role === "hermes"
      ? renderMemorySources(memorySourcesForMessage(message, approvedMemories), "No approved memories used for this response.")
      : "";

  return `<article class="chat-message ${message.role}">
    <p class="speaker">${speaker}</p>
    <p class="message-body">${escapeHtml(content)}</p>
    ${sources}
  </article>`;
}

function renderLatestMemorySources(
  latestHermesMessage: ChatMessage | undefined,
  sources: UiMemorySource[]
): string {
  if (!latestHermesMessage) {
    return `<div class="memory-sources"><p>Latest memories used: no HERmes response yet.</p></div>`;
  }
  return renderMemorySources(sources, "Latest memories used: none.");
}

function renderMemorySources(sources: UiMemorySource[], emptyText: string): string {
  if (sources.length === 0) {
    return `<div class="memory-sources"><p>${escapeHtml(emptyText)}</p></div>`;
  }

  return `<div class="memory-sources">
    <p>Memories used:</p>
    ${sources.map((source) => `<p>- [${source.id}] ${escapeHtml(source.snippet)}</p>`).join("")}
  </div>`;
}

function renderNotice(notice: Notice): string {
  return `<div class="notice ${notice.kind === "error" ? "error" : notice.kind === "info" ? "info" : ""}" role="status">${escapeHtml(
    notice.message
  )}</div>`;
}

function renderDrafts(drafts: MemoryDraft[]): string {
  if (drafts.length === 0) {
    return `<p class="empty">No pending drafts.</p>`;
  }

  return `<div class="stack">${drafts.map(renderDraft).join("")}</div>`;
}

function renderDraft(draft: MemoryDraft): string {
  return `<article class="item">
    <p class="item-title"><span>[${draft.id}] ${escapeHtml(draft.proposed_category)}</span></p>
    <p class="meta">Tags: ${escapeHtml(formatTags(draft.proposed_tags_json))} · Confidence: ${escapeHtml(
      draft.proposed_confidence
    )} · Source: ${escapeHtml(draft.source_type)} ${escapeHtml(draft.source_label)}</p>
    <p class="content">${escapeHtml(draft.proposed_content)}</p>
    <div class="actions" style="margin-top: 12px;">
      <form method="post" action="/drafts/approve">
        <input type="hidden" name="draftId" value="${draft.id}">
        <button type="submit">Approve</button>
      </form>
      <form method="post" action="/drafts/reject">
        <input type="hidden" name="draftId" value="${draft.id}">
        <button class="danger" type="submit">Reject</button>
      </form>
    </div>
  </article>`;
}

function renderMemoryResults(model: ReturnType<typeof readUiModel>): string {
  if (model.searchQuery) {
    const results = model.searchResults ?? [];
    if (results.length === 0) {
      return `<p class="empty">No approved memories matched "${escapeHtml(model.searchQuery)}".</p>`;
    }
    return results.map(({ memory, snippet }) => renderMemory(memory, snippet)).join("");
  }

  if (model.approvedMemories.length === 0) {
    return `<p class="empty">No approved memories.</p>`;
  }
  return model.approvedMemories.map((memory) => renderMemory(memory)).join("");
}

function renderMemory(memory: MemoryEntry, snippet?: string): string {
  return `<article class="item">
    <p class="item-title"><span>[${memory.id}] ${escapeHtml(memory.category)}</span></p>
    <p class="meta">Created: ${escapeHtml(memory.created_at)} · Tags: ${escapeHtml(formatTags(memory.tags_json))} · Confidence: ${escapeHtml(
      memory.confidence
    )}</p>
    <p class="meta">Source: ${escapeHtml(memory.source_type)} ${escapeHtml(memory.source_label)}</p>
    <p class="content">${escapeHtml(snippet ?? memory.content)}</p>
  </article>`;
}

function renderReflection(report: ReflectionReport): string {
  return `<div class="stack" style="margin-top: 16px;">
    <p class="notice info">Deterministic reflection from approved memories only.</p>
    <pre>${escapeHtml(
      [
        `Question: ${report.question}`,
        `Relevant memory ids: ${report.relevantMemoryIds.length > 0 ? report.relevantMemoryIds.join(", ") : "none"}`,
        "Relevant snippets:",
        ...(report.relevantSnippets.length > 0
          ? report.relevantSnippets.map(({ id, snippet }) => `- [${id}] ${snippet}`)
          : ["- none"]),
        "Pattern summary:",
        ...report.patternSummary.map((line) => `- ${line}`),
        report.basisNote
      ].join("\n")
    )}</pre>
  </div>`;
}

function findLatestHermesMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages
    .filter((message) => message.role === "hermes")
    .sort((a, b) => b.id - a.id)[0];
}

function memorySourcesForMessage(message: ChatMessage, approvedMemories: MemoryEntry[]): UiMemorySource[] {
  const memoriesById = new Map(approvedMemories.map((memory) => [memory.id, memory]));
  return parseMemoryIds(message.memory_ids_json).map((id) => ({
    id,
    snippet: compactText(memoriesById.get(id)?.content ?? "Memory is not available in the approved list.", 140)
  }));
}

function parseMemoryIds(memoryIdsJson: string): number[] {
  try {
    const parsed = JSON.parse(memoryIdsJson);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id): id is number => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  }
}

function stripMemoriesUsedSection(content: string): string {
  return content.split(/\n\nMemories used:\n/)[0] ?? content;
}

function compactText(content: string, maxLength: number): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

async function routeNodeRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  runtime: HermesRuntimeOptions
): Promise<void> {
  const request = await toFetchRequest(incoming);
  const response = await handleUiRequest(request, runtime);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(await response.text());
}

async function toFetchRequest(incoming: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const part of value) {
        headers.append(name, part);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const origin = `http://${headers.get("host") ?? `${DEFAULT_UI_HOST}:${DEFAULT_UI_PORT}`}`;
  const url = new URL(incoming.url ?? "/", origin);
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

  return new Request(url, {
    method: incoming.method ?? "GET",
    headers,
    body
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes(POST_CONTENT_TYPE)) {
    return new URLSearchParams();
  }
  return new URLSearchParams(await request.text());
}

function requiredFormValue(form: URLSearchParams, key: string, message: string): string {
  const value = (form.get(key) ?? "").trim();
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function parseDraftId(value: string): number {
  const draftId = Number.parseInt(value, 10);
  if (!Number.isInteger(draftId) || draftId <= 0) {
    throw new Error("Draft id must be a positive integer.");
  }
  return draftId;
}

function parseOptionalPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return parseDraftId(trimmed);
}

function formatTags(tagsJson: string): string {
  try {
    const tags = JSON.parse(tagsJson);
    if (Array.isArray(tags) && tags.length > 0) {
      return tags.join(", ");
    }
  } catch {
    return "(invalid tags json)";
  }
  return "(none)";
}

function assertLoopbackHost(host: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("HERmes UI must bind to localhost or another loopback address.");
  }
}

function guardLocalUiRequest(request: Request, url: URL): Response | undefined {
  if (!isLoopbackHost(url.hostname)) {
    return forbiddenResponse();
  }

  const hostHeader = request.headers.get("host");
  if (hostHeader && !hostHeaderMatchesUrl(hostHeader, url)) {
    return forbiddenResponse();
  }

  if (request.method !== "POST") {
    return undefined;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes(POST_CONTENT_TYPE)) {
    return forbiddenResponse();
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") {
    return forbiddenResponse();
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return undefined;
  }

  try {
    const originUrl = new URL(origin);
    if (originUrl.origin !== url.origin || !isLoopbackHost(originUrl.hostname)) {
      return forbiddenResponse();
    }
  } catch {
    return forbiddenResponse();
  }

  return undefined;
}

function hostHeaderMatchesUrl(hostHeader: string, url: URL): boolean {
  const normalizedHost = normalizeHostHeader(hostHeader);
  if (!normalizedHost || !isLoopbackHost(normalizedHost.hostname)) {
    return false;
  }
  return (
    canonicalHostname(normalizedHost.hostname) === canonicalHostname(url.hostname) &&
    normalizedHost.port === url.port
  );
}

function normalizeHostHeader(hostHeader: string): { hostname: string; port: string } | undefined {
  const trimmed = hostHeader.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(`http://${trimmed}`);
    return { hostname: parsed.hostname, port: parsed.port };
  } catch {
    if (trimmed === "::1") {
      return { hostname: "::1", port: "" };
    }
    const rawIpv6WithPort = trimmed.match(/^(::1):(\d+)$/);
    if (rawIpv6WithPort) {
      return { hostname: "::1", port: rawIpv6WithPort[2] ?? "" };
    }
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const canonical = canonicalHostname(hostname);
  return canonical === "127.0.0.1" || canonical === "localhost" || canonical === "::1";
}

function canonicalHostname(hostname: string): string {
  return hostname === "[::1]" ? "::1" : hostname;
}

function formatHostForUrl(host: string): string {
  return host === "::1" ? "[::1]" : host;
}

function forbiddenResponse(): Response {
  return new Response(FORBIDDEN_LOCAL_REQUEST, {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function escapeHtml(value: string | number | boolean): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("HERMES_UI_PORT must be a valid TCP port.");
  }
  return port;
}

function runtimeFromEnvironment(): UiServerOptions {
  return {
    host: process.env.HERMES_UI_HOST ?? DEFAULT_UI_HOST,
    port: parsePort(process.env.HERMES_UI_PORT),
    dbFileName: process.env.HERMES_DB_FILE
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === invokedPath) {
  startUiServer(runtimeFromEnvironment())
    .then(({ url }) => {
      process.stdout.write(`HERmes Local Web Chat: ${url}\n`);
      process.stdout.write("Local-only. Only approved memories are used for chat/list/search/reflect.\n");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
