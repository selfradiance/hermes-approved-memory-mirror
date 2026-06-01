#!/usr/bin/env node
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createChatSession,
  dismissMemorySuggestion,
  getLatestMemorySuggestion,
  listChatMessages,
  listChatSessions,
  saveLatestChatExchangeDraft,
  saveSuggestedMemoryDraft,
  sendChatMessage
} from "./chat.js";
import {
  approveDraft,
  doctor,
  ensureHermesInitialized,
  exportApprovedMemories,
  initHermes,
  intakeText,
  listApprovedMemories,
  listPendingDrafts,
  reflectOnApprovedMemory,
  rejectDraft,
  searchApprovedMemories
} from "./hermes.js";
import { chatModeLabel } from "./llm/chatMode.js";
import { formatDoctor } from "./format.js";
import type {
  ChatMessage,
  ChatTurn,
  HermesRuntimeOptions,
  MemoryDraft,
  MemoryEntry,
  MemorySuggestion,
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
  memorySuggestion?: MemorySuggestion;
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
    ensureHermesInitialized(runtime);

    if (request.method === "GET" && url.pathname === "/") {
      return htmlResponse(renderPage(runtime));
    }

    if (request.method === "GET" && url.pathname === "/system") {
      return htmlResponse(renderSystemPage(runtime));
    }

    if (request.method === "POST" && url.pathname === "/chat/send") {
      const form = await readForm(request);
      const message = requiredFormValue(form, "message", "Chat message is required.");
      const sessionId = parseOptionalPositiveInteger(form.get("sessionId") ?? "");
      const chatTurn = await sendChatMessage(message, { ...runtime, sessionId });
      return htmlResponse(
        renderPage(runtime, {
          activeSessionId: chatTurn.session.id,
          chatTurn,
          notice: chatTurn.providerError
            ? {
                kind: "info",
                message: `Claude API was unavailable, so Approved Mind Mirror replied in local deterministic mode. (${chatTurn.providerError})`
              }
            : chatTurn.savedDraft
              ? {
                  kind: "success",
                  message: "Saved for review. Approve it when you’re ready."
                }
              : undefined
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/chat/save-draft") {
      const form = await readForm(request);
      const sessionId = parseDraftId(requiredFormValue(form, "sessionId", "Chat session id is required."));
      saveLatestChatExchangeDraft(sessionId, runtime);
      return htmlResponse(
        renderPage(runtime, {
          activeSessionId: sessionId,
          notice: {
            kind: "success",
            message: "Saved for review. Approve it when you’re ready."
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/chat/new") {
      const session = createChatSession(runtime, "Web chat");
      return htmlResponse(
        renderPage(runtime, {
          activeSessionId: session.id
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/memory-suggestions/save") {
      const form = await readForm(request);
      const sessionId = parsePositiveInteger(
        requiredFormValue(form, "sessionId", "Chat session id is required."),
        "Chat session id"
      );
      const messageId = parsePositiveInteger(
        requiredFormValue(form, "messageId", "Chat message id is required."),
        "Chat message id"
      );
      const suggestionKey = requiredFormValue(form, "suggestionKey", "Suggestion key is required.");
      const proposedContent = requiredFormValue(form, "proposedContent", "Suggested memory text is required.");
      saveSuggestedMemoryDraft(
        { proposedContent, sourceSessionId: sessionId, sourceMessageId: messageId, suggestionKey },
        runtime
      );
      return htmlResponse(
        renderPage(runtime, {
          activeSessionId: sessionId,
          notice: {
            kind: "success",
            message: "Saved for review. Approve it when you’re ready."
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/memory-suggestions/dismiss") {
      const form = await readForm(request);
      const sessionId = parsePositiveInteger(
        requiredFormValue(form, "sessionId", "Chat session id is required."),
        "Chat session id"
      );
      const messageId = parsePositiveInteger(
        requiredFormValue(form, "messageId", "Chat message id is required."),
        "Chat message id"
      );
      const suggestionKey = requiredFormValue(form, "suggestionKey", "Suggestion key is required.");
      dismissMemorySuggestion(sessionId, messageId, suggestionKey, runtime);
      return htmlResponse(
        renderPage(runtime, {
          activeSessionId: sessionId,
          notice: { kind: "info", message: "Memory suggestion dismissed." }
        })
      );
    }

    if (request.method === "GET" && url.pathname === "/memories") {
      const searchQuery = (url.searchParams.get("query") ?? "").trim();
      const searchResults = searchQuery ? searchApprovedMemories(searchQuery, runtime) : undefined;
      return htmlResponse(renderSystemPage(runtime, { searchQuery, searchResults }));
    }

    if (request.method === "POST" && url.pathname === "/init") {
      initHermes(runtime);
      return htmlResponse(
        renderPage(runtime, {
          notice: { kind: "success", message: "Local memory database initialized." }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/drafts") {
      const form = await readForm(request);
      const text = requiredFormValue(form, "text", "Note text is required.");
      intakeText(text, runtime);
      return htmlResponse(
        renderPage(runtime, {
          notice: {
            kind: "success",
            message: "Saved for review. Approve it when you’re ready."
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/drafts/approve") {
      const form = await readForm(request);
      const draftId = parseDraftId(requiredFormValue(form, "draftId", "Memory id is required."));
      approveDraft(draftId, runtime);
      return htmlResponse(
        renderPage(runtime, {
          notice: { kind: "success", message: "Approved memory. It’s now part of your approved memories." }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/drafts/reject") {
      const form = await readForm(request);
      const draftId = parseDraftId(requiredFormValue(form, "draftId", "Memory id is required."));
      rejectDraft(draftId, runtime);
      return htmlResponse(
        renderPage(runtime, {
          notice: { kind: "info", message: "Dismissed." }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/reflect") {
      const form = await readForm(request);
      const question = requiredFormValue(form, "question", "Reflection question is required.");
      const reflection = reflectOnApprovedMemory(question, runtime);
      return htmlResponse(renderSystemPage(runtime, { reflection }));
    }

    if (request.method === "POST" && url.pathname === "/export") {
      const exportPath = exportApprovedMemories(runtime);
      return htmlResponse(
        renderSystemPage(runtime, {
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Approved Mind Mirror</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17201e;
      --muted: #66736f;
      --line: #d9e1de;
      --paper: #f6f8f7;
      --panel: #ffffff;
      --soft: #eef6f3;
      --accent: #236b58;
      --accent-strong: #174d3f;
      --blue: #2a5d84;
      --warn: #8a5a17;
      --danger: #a43a32;
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
    .app-shell {
      width: min(880px, calc(100% - 32px));
      margin: 0 auto;
      padding: 22px 0 42px;
    }
    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 1.75rem;
      letter-spacing: 0;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .mode-label {
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 0.85rem;
      letter-spacing: 0.02em;
    }
    .app-footer {
      margin-top: 26px;
      text-align: center;
    }
    .app-footer a {
      color: var(--muted);
      font-size: 0.85rem;
      text-decoration: none;
    }
    .app-footer a:hover {
      color: var(--accent-strong);
      text-decoration: underline;
    }
    .top-actions,
    .actions,
    .chat-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .top-actions a,
    .link-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      color: var(--accent-strong);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 11px;
      text-decoration: none;
      background: #fbfcfb;
      font-size: 0.94rem;
    }
    .chat-card,
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    .chat-card {
      display: grid;
      gap: 16px;
      min-height: calc(100vh - 190px);
    }
    .chat-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
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
      align-content: start;
      min-height: 320px;
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
      background: var(--soft);
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
    .memory-sources summary {
      cursor: pointer;
      color: var(--accent-strong);
      font-weight: 700;
    }
    .memory-sources p,
    .memory-sources ul {
      margin: 0;
    }
    .memory-sources ul {
      padding-left: 18px;
    }
    .memory-suggestion {
      display: grid;
      gap: 10px;
      border: 1px solid #e3d3aa;
      background: #fffaf0;
      border-radius: 8px;
      padding: 13px;
    }
    .memory-suggestion h3 {
      margin: 0;
      font-size: 0.98rem;
      letter-spacing: 0;
    }
    .memory-suggestion textarea {
      min-height: 84px;
    }
    .suggestion-meta {
      color: var(--muted);
      font-size: 0.9rem;
      margin: 0;
    }
    .suggestion-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .chat-compose {
      display: grid;
      gap: 10px;
    }
    .chat-compose textarea {
      min-height: 92px;
    }
    .chat-toolbar {
      justify-content: space-between;
    }
    .memory-panels {
      display: grid;
      gap: 12px;
      margin-top: 14px;
    }
    details.panel > summary {
      cursor: pointer;
      font-weight: 750;
      color: var(--accent-strong);
    }
    details.panel > .panel-body {
      margin-top: 14px;
    }
    .onboarding {
      border: 1px solid #c8d9e7;
      background: #eef5fb;
      border-radius: 8px;
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .onboarding p {
      margin: 0;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    @media (max-width: 760px) {
      .app-header,
      .chat-head {
        display: grid;
      }
      .search-row {
        grid-template-columns: 1fr;
      }
      .top-actions a,
      .link-button,
      button {
        width: 100%;
        text-align: center;
      }
    }
  </style>
</head>
<body>
  <main class="app-shell">
    <header class="app-header">
      <div>
        <h1>Approved Mind Mirror</h1>
      </div>
      <nav class="top-actions" aria-label="App actions">
        <a href="#review-drafts">Review memories${model.pendingDrafts.length > 0 ? ` (${model.pendingDrafts.length})` : ""}</a>
        <a href="#add-memory">Add memory</a>
      </nav>
    </header>

    <p class="mode-label" aria-label="Conversation mode">Mode: ${escapeHtml(model.modeLabel)}</p>

    ${state.notice ? renderNotice(state.notice) : ""}

    <section class="chat-card" id="chat">
      <div class="chat-head">
        <form method="post" action="/chat/new">
          <button class="secondary" type="submit"${model.canReadMemory ? "" : " disabled"}>New Chat</button>
        </form>
      </div>
      ${
        model.approvedMemories.length === 0
          ? `<div class="onboarding">
              <p>Just start chatting. Approved Mind Mirror will suggest memories when something seems worth saving.</p>
              <a class="link-button" href="#add-memory">Add memory</a>
            </div>`
          : ""
      }
      ${renderChat(model)}
    </section>

    <div class="memory-panels">
      <details class="panel" id="add-memory"${model.approvedMemories.length === 0 ? " open" : ""}>
        <summary>Add memory</summary>
        <div class="panel-body">
          <form class="stack" method="post" action="/drafts">
            <label>
              Paste a note
              <textarea name="text" required placeholder="Paste something to remember after you approve it."></textarea>
            </label>
            <div class="actions">
              <button type="submit">Save for review</button>
            </div>
          </form>
        </div>
      </details>

      <details class="panel" id="review-drafts"${model.pendingDrafts.length > 0 ? " open" : ""}>
        <summary>Review memory suggestions${model.pendingDrafts.length > 0 ? ` (${model.pendingDrafts.length})` : ""}</summary>
        <div class="panel-body">
          ${renderDrafts(model.pendingDrafts)}
        </div>
      </details>
    </div>

    <footer class="app-footer">
      <a href="/system">Diagnostics</a>
    </footer>
  </main>
  <script>
    (function () {
      var form = document.querySelector("form.chat-compose");
      if (!form) {
        return;
      }
      var textarea = form.querySelector('textarea[name="message"]');
      if (!textarea) {
        return;
      }
      var submitting = false;
      form.addEventListener("submit", function () {
        submitting = true;
      });
      textarea.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" || event.shiftKey) {
          return;
        }
        event.preventDefault();
        if (submitting || !textarea.value.trim()) {
          return;
        }
        submitting = true;
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          form.submit();
        }
      });
    })();
  </script>
</body>
</html>`;
}

function renderSystemPage(runtime: HermesRuntimeOptions, state: RenderState = {}): string {
  const model = readUiModel(runtime, state);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Approved Mind Mirror System</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17201e;
      --muted: #66736f;
      --line: #d9e1de;
      --paper: #f6f8f7;
      --panel: #ffffff;
      --accent: #236b58;
      --accent-strong: #174d3f;
      --danger: #a43a32;
      --blue: #2a5d84;
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
    .wrap {
      width: min(960px, calc(100% - 32px));
      margin: 0 auto;
      padding: 24px 0 42px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 18px;
    }
    h1,
    h2 {
      margin: 0;
      letter-spacing: 0;
    }
    h1 {
      font-size: 1.55rem;
    }
    h2 {
      font-size: 1.08rem;
    }
    a {
      color: var(--accent-strong);
    }
    .back-link,
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      border-radius: 6px;
      padding: 8px 11px;
      font: inherit;
      font-weight: 700;
    }
    .back-link {
      border: 1px solid var(--line);
      background: #fbfcfb;
      text-decoration: none;
    }
    button {
      border: 0;
      color: #fff;
      background: var(--accent);
      cursor: pointer;
    }
    button.secondary {
      color: var(--accent-strong);
      border: 1px solid var(--line);
      background: #fbfcfb;
    }
    button.danger {
      background: var(--danger);
    }
    main,
    .stack {
      display: grid;
      gap: 14px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    .hint,
    .meta,
    .empty {
      color: var(--muted);
    }
    .hint {
      margin: 4px 0 0;
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
    .search-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
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
      min-height: 120px;
      resize: vertical;
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
      margin: 0 0 6px;
      font-weight: 750;
    }
    .content {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
    }
    @media (max-width: 760px) {
      header,
      .search-row {
        display: grid;
        grid-template-columns: 1fr;
      }
      button,
      .back-link {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>System</h1>
        <p class="hint">Diagnostics and advanced local tools.</p>
      </div>
      <a class="back-link" href="/">Back to chat</a>
    </header>
    <main>
      ${state.notice ? renderNotice(state.notice) : ""}
      <section>
        <h2>Memory</h2>
        <p class="hint">Your memories stay local. Only approved memories are used. No outside actions.</p>
        <p>Approved memories: ${model.approvedMemories.length} · Memory suggestions waiting: ${
          model.pendingDrafts.length
        }</p>
      </section>

      <section>
        <h2>Review memory suggestions</h2>
        <div class="stack" style="margin-top: 12px;">
          ${renderDrafts(model.pendingDrafts)}
        </div>
      </section>

      <section>
        <h2>Search Memories</h2>
        <form class="search-row" method="get" action="/memories" style="margin-top: 12px;">
          <label>
            Search approved memory
            <input type="search" name="query" value="${escapeAttribute(
              model.searchQuery
            )}" placeholder="Search text, tags, category, or source">
          </label>
          <button type="submit">Search</button>
        </form>
        <div class="stack" style="margin-top: 16px;">
          ${renderMemoryResults(model)}
        </div>
      </section>

      <section>
        <h2>Reflect</h2>
        <form class="stack" method="post" action="/reflect" style="margin-top: 12px;">
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

      <section>
        <h2>Export</h2>
        <p class="hint">Writes approved memory JSON locally under .hermes/export. Nothing is uploaded.</p>
        <form method="post" action="/export" style="margin-top: 12px;">
          <button type="submit">Export JSON</button>
        </form>
        ${state.exportPath ? `<p class="notice info" style="margin-top: 14px;">Export path: ${escapeHtml(state.exportPath)}</p>` : ""}
      </section>

      <section>
        <h2>Technical Diagnostics</h2>
        <p class="hint">Useful for debugging local setup.</p>
        <pre style="margin-top: 12px;">${escapeHtml(formatDoctor(model.report))}</pre>
      </section>
    </main>
  </div>
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
  const latestMemorySuggestion =
    state.memorySuggestion ??
    state.chatTurn?.memorySuggestion ??
    (canReadMemory && activeSessionId ? getLatestMemorySuggestion(activeSessionId, runtime) : undefined);
  const searchQuery = state.searchQuery ?? "";
  const modeLabel = state.chatTurn?.providerLabel ?? chatModeLabel();

  return {
    report,
    canReadMemory,
    modeLabel,
    pendingDrafts,
    approvedMemories,
    chatSessions,
    activeSessionId,
    chatMessages,
    latestHermesMessage,
    latestMemorySources,
    latestMemorySuggestion,
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
      ${model.chatMessages.map((message) => renderChatMessage(message, model.approvedMemories)).join("")}
    </div>

    ${model.latestMemorySuggestion ? renderMemorySuggestion(model.latestMemorySuggestion) : ""}

    <form class="chat-compose" method="post" action="/chat/send">
      ${sessionInput}
      <label>
        <span class="sr-only">Message</span>
        <textarea name="message" required${disabled} placeholder="Message…"></textarea>
      </label>
      <div class="chat-toolbar">
        <div class="actions">
          <button type="submit"${disabled}>Send</button>
        </div>
        <p class="hint">${
          model.canReadMemory
            ? "Saving an exchange only saves it for review."
            : "Approved Mind Mirror could not open your local memory store."
        }</p>
      </div>
    </form>

    <div class="chat-toolbar">
      <form method="post" action="/chat/save-draft">
        ${sessionInput}
        <button class="secondary" type="submit"${
          model.activeSessionId && model.latestHermesMessage ? "" : " disabled"
        }>Save for review</button>
      </form>
      ${renderLatestMemorySources(model.latestHermesMessage, model.latestMemorySources)}
    </div>
  </div>`;
}

function renderChatMessage(message: ChatMessage, approvedMemories: MemoryEntry[]): string {
  const speaker = message.role === "user" ? "You" : "Approved Mind Mirror";
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
    return `<div class="memory-sources"><p>Sources from your memory: none yet.</p></div>`;
  }
  return renderMemorySources(sources, "No approved memories were used for the latest response.");
}

function renderMemorySuggestion(suggestion: MemorySuggestion): string {
  const sourceReady = suggestion.sourceSessionId !== null && suggestion.sourceMessageId !== null;
  const hiddenFields = sourceReady
    ? [
        `<input type="hidden" name="sessionId" value="${suggestion.sourceSessionId}">`,
        `<input type="hidden" name="messageId" value="${suggestion.sourceMessageId}">`,
        `<input type="hidden" name="suggestionKey" value="${escapeAttribute(suggestion.suggestionKey)}">`
      ].join("")
    : "";
  const tags = suggestion.suggestedTags.length > 0 ? suggestion.suggestedTags.join(", ") : "none";

  return `<section class="memory-suggestion" aria-label="Memory suggestion">
    <div>
      <h3>This seems worth remembering.</h3>
      <p class="suggestion-meta">Suggested as ${escapeHtml(
        suggestion.suggestedCategory
      )} · Tags: ${escapeHtml(tags)} · From this chat</p>
    </div>
    <form class="stack" method="post" action="/memory-suggestions/save">
      ${hiddenFields}
      <label>
        Proposed memory
        <textarea name="proposedContent" required>${escapeHtml(suggestion.proposedContent)}</textarea>
      </label>
      <div class="suggestion-actions">
        <button type="submit"${sourceReady ? "" : " disabled"}>Save for review</button>
        <button class="secondary" type="button" onclick="this.closest('form').querySelector('textarea').focus()">Edit</button>
      </div>
    </form>
    <form method="post" action="/memory-suggestions/dismiss">
      ${hiddenFields}
      <button class="secondary" type="submit"${sourceReady ? "" : " disabled"}>Dismiss</button>
    </form>
  </section>`;
}

function renderMemorySources(sources: UiMemorySource[], emptyText: string): string {
  if (sources.length === 0) {
    return `<div class="memory-sources"><p>${escapeHtml(emptyText)}</p></div>`;
  }

  return `<details class="memory-sources">
    <summary>Sources from your memory</summary>
    <ul>
      ${sources.map((source) => `<li>[${source.id}] ${escapeHtml(source.snippet)}</li>`).join("")}
    </ul>
  </details>`;
}

function renderNotice(notice: Notice): string {
  return `<div class="notice ${notice.kind === "error" ? "error" : notice.kind === "info" ? "info" : ""}" role="status">${escapeHtml(
    notice.message
  )}</div>`;
}

function renderDrafts(drafts: MemoryDraft[]): string {
  if (drafts.length === 0) {
    return `<p class="empty">No memory suggestions waiting.</p>`;
  }

  return `<div class="stack">${drafts.map(renderDraft).join("")}</div>`;
}

function renderDraft(draft: MemoryDraft): string {
  return `<article class="item">
    <p class="item-title"><span>Memory suggestion</span></p>
    <p class="meta">Suggested as ${escapeHtml(draft.proposed_category)} · Tags: ${escapeHtml(
      formatTags(draft.proposed_tags_json)
    )}</p>
    <p class="content">${escapeHtml(draft.proposed_content)}</p>
    <div class="actions" style="margin-top: 12px;">
      <form method="post" action="/drafts/approve">
        <input type="hidden" name="draftId" value="${draft.id}">
        <button type="submit">Approve memory</button>
      </form>
      <form method="post" action="/drafts/reject">
        <input type="hidden" name="draftId" value="${draft.id}">
        <button class="danger" type="submit">Dismiss</button>
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
  return parsePositiveInteger(value, "Draft id");
}

function parseOptionalPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return parsePositiveInteger(trimmed, "Value");
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
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
      process.stdout.write(`Approved Mind Mirror Local Web Chat: ${url}\n`);
      process.stdout.write("Local-only. Only approved memories are used for chat/list/search/reflect.\n");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
