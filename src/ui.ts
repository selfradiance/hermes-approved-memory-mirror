#!/usr/bin/env node
import fs from "node:fs";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createChatSession,
  dismissMemorySuggestion,
  extractRememberedPayloadSuggestions,
  getLatestMemorySuggestion,
  listChatMessages,
  listChatSessions,
  saveLatestChatExchangeDraft,
  saveSuggestedMemoryDraft,
  sendChatMessage
} from "./chat.js";
import {
  approveDraft,
  createDraftFromText,
  doctor,
  editApprovedMemory,
  ensureHermesInitialized,
  exportApprovedMemories,
  exportProjectMemoryPack,
  getSavedContextPack,
  initHermes,
  intakeText,
  listApprovedMemories,
  listPendingDrafts,
  listRetiredMemories,
  listSavedContextPacks,
  reflectOnApprovedMemory,
  rejectDraft,
  retireApprovedMemory,
  searchApprovedMemories,
  saveContextPack,
  updateDraftProposedContent
} from "./hermes.js";
import {
  deleteSource,
  getSource,
  getSourceChunks,
  importSource,
  listSources,
  renameSource,
  retrieveRelevantSourceChunks,
  searchSourceChunks,
  suggestMemoriesFromSource
} from "./sources.js";
import { resolveHermesPaths } from "./db.js";
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
  SearchResult,
  SavedContextPack,
  SourceChunk,
  SourceChunkResult,
  SourceSummary
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
  selectedSourceId?: number;
  sourceSearchQuery?: string;
  sourceSearchResults?: SourceChunkResult[];
  suggestedDraftIds?: number[];
  longMemoryText?: string;
  showRetiredMemories?: boolean;
  memoryPackMarkdown?: string;
  memoryPackSelectedIds?: number[];
  memoryPackTitle?: string;
  memoryPackCurrentNextStep?: string;
  memoryPackSettledDecisions?: string;
  selectedSavedContextPackId?: number;
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
const LONG_DIRECT_MEMORY_CHARS = 1500;
const LONG_DIRECT_MEMORY_PARAGRAPHS = 3;
const LONG_DIRECT_MEMORY_BULLETS = 4;
const LONG_DIRECT_MEMORY_LINES = 24;

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
          notice: chatTurn.memoryRequestNeedsPayload
            ? {
                kind: "info",
                message: "Paste the information you want added to context, and I’ll save it for review."
              }
            : chatTurn.rememberedPayloadNoSuggestions
              ? {
                  kind: "info",
                  message:
                    "I didn’t find any strong standalone context items in that block. You can paste a shorter note or phrase one item directly."
                }
              : chatTurn.savedDrafts && chatTurn.savedDrafts.length > 0
                ? {
                    kind: "success",
                    message: `Saved ${chatTurn.savedDrafts.length} context suggestions for review.`
                  }
            : chatTurn.providerError
            ? {
                kind: "info",
                message: `Claude API was unavailable, so ContextCrate replied in local deterministic mode. (${chatTurn.providerError})`
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
      const proposedContent = requiredFormValue(form, "proposedContent", "Suggested context text is required.");
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
          notice: { kind: "info", message: "Context suggestion dismissed." }
        })
      );
    }

    if (request.method === "GET" && url.pathname === "/memories") {
      const searchQuery = (url.searchParams.get("query") ?? "").trim();
      const showRetiredMemories = url.searchParams.get("retired") === "1";
      const searchResults = searchQuery ? searchApprovedMemories(searchQuery, runtime) : undefined;
      return htmlResponse(renderManageMemoriesPage(runtime, { searchQuery, searchResults, showRetiredMemories }));
    }

    if (request.method === "GET" && url.pathname === "/memory-pack") {
      const searchQuery = (url.searchParams.get("query") ?? "").trim();
      const searchResults = searchQuery ? searchApprovedMemories(searchQuery, runtime) : undefined;
      const selectedSavedContextPackId = parseOptionalPositiveInteger(url.searchParams.get("savedPack") ?? "");
      return htmlResponse(
        renderMemoryPackPage(runtime, { searchQuery, searchResults, selectedSavedContextPackId })
      );
    }

    if (request.method === "GET" && url.pathname === "/memory-pack/download") {
      return markdownDownloadResponse(runtime, url.searchParams.get("file") ?? "");
    }

    if (request.method === "GET" && url.pathname === "/memory-pack/saved/download") {
      const packId = parsePositiveInteger(url.searchParams.get("id") ?? "", "Saved context pack id");
      return savedContextPackDownloadResponse(runtime, packId);
    }

    if (request.method === "POST" && url.pathname === "/memory-pack/export") {
      const form = await readForm(request);
      const title = requiredFormValue(form, "title", "Project title is required.");
      const currentNextStep = optionalFormValue(form, "currentNextStep");
      const settledDecisions = optionalFormValue(form, "settledDecisions");
      const memoryIds = form.getAll("memoryId").map((value) => parsePositiveInteger(value, "Context id"));
      const result = exportProjectMemoryPack(
        {
          title,
          currentNextStep,
          settledDecisions,
          memoryIds
        },
        runtime
      );
      return htmlResponse(
        renderMemoryPackPage(runtime, {
          notice: { kind: "success", message: "LLM context pack exported locally." },
          exportPath: result.exportPath,
          memoryPackMarkdown: result.markdown,
          memoryPackSelectedIds: result.memoryIds,
          memoryPackTitle: title,
          memoryPackCurrentNextStep: currentNextStep,
          memoryPackSettledDecisions: settledDecisions
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/memory-pack/save") {
      const form = await readForm(request);
      const title = requiredFormValue(form, "title", "Context pack title is required.");
      const markdown = requiredFormValue(form, "markdown", "Generated context pack is required.");
      const exportPath = optionalFormValue(form, "exportPath");
      const saved = saveContextPack({ title, markdown, exportPath }, runtime);
      return htmlResponse(
        renderMemoryPackPage(runtime, {
          selectedSavedContextPackId: saved.id,
          notice: { kind: "success", message: `Saved context pack "${saved.title}".` }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/init") {
      initHermes(runtime);
      return htmlResponse(
        renderPage(runtime, {
          notice: { kind: "success", message: "Local context store initialized." }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/drafts") {
      const form = await readForm(request);
      const text = requiredFormValue(form, "text", "Note text is required.");
      if (isLongDirectMemoryInput(text)) {
        return htmlResponse(renderPage(runtime, { longMemoryText: text }));
      }
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

    if (request.method === "POST" && url.pathname === "/drafts/long/split") {
      const form = await readForm(request);
      const text = requiredFormValue(form, "text", "Note text is required.");
      const suggestions = await extractRememberedPayloadSuggestions(text, undefined, runtime);
      if (suggestions.length === 0) {
        return htmlResponse(
          renderPage(runtime, {
            longMemoryText: text,
            notice: {
              kind: "info",
              message:
                    "I didn’t find any strong standalone context items in that note. You can import it as a source or save it as one context item anyway."
            }
          })
        );
      }

      const drafts = suggestions.map((suggestion) =>
        createDraftFromText(suggestion, "manual_text", "web add memory split", runtime)
      );
      return htmlResponse(
        renderPage(runtime, {
          notice: {
            kind: "success",
            message: `Saved ${drafts.length} context suggestion${
              drafts.length === 1 ? "" : "s"
            } for review. Approve or edit each one when you’re ready.`
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/drafts/long/import") {
      const form = await readForm(request);
      const text = requiredFormValue(form, "text", "Note text is required.");
      const title = titleFromPastedMemory(text);
      const source = importSource({ filename: "pasted-note.md", content: text, title }, runtime);
      return htmlResponse(
        renderSourcesPage(runtime, {
          selectedSourceId: source.id,
          notice: {
            kind: "success",
            message: `Imported "${source.title}" as a source with ${source.chunk_count} excerpt${
              source.chunk_count === 1 ? "" : "s"
            }. It is not approved context.`
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/drafts/long/save-one") {
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
      const draftId = parseDraftId(requiredFormValue(form, "draftId", "Context suggestion id is required."));
      const editedContent = (form.get("content") ?? "").trim();
      if (editedContent) {
        updateDraftProposedContent(draftId, editedContent, runtime);
      }
      approveDraft(draftId, runtime);
      const notice: Notice = {
        kind: "success",
        message: "Approved context. It’s now part of your approved context."
      };
      const sourcesReturn = sourcesReturnState(form, draftId);
      if (sourcesReturn) {
        return htmlResponse(renderSourcesPage(runtime, { ...sourcesReturn, notice }));
      }
      return htmlResponse(renderPage(runtime, { notice }));
    }

    if (request.method === "POST" && url.pathname === "/drafts/reject") {
      const form = await readForm(request);
      const draftId = parseDraftId(requiredFormValue(form, "draftId", "Context suggestion id is required."));
      rejectDraft(draftId, runtime);
      const notice: Notice = { kind: "info", message: "Dismissed." };
      const sourcesReturn = sourcesReturnState(form, draftId);
      if (sourcesReturn) {
        return htmlResponse(renderSourcesPage(runtime, { ...sourcesReturn, notice }));
      }
      return htmlResponse(renderPage(runtime, { notice }));
    }

    if (request.method === "POST" && url.pathname === "/memories/edit") {
      const form = await readForm(request);
      const memoryId = parsePositiveInteger(
        requiredFormValue(form, "memoryId", "Context id is required."),
        "Context id"
      );
      const content = requiredFormValue(form, "content", "Context text is required.");
      const note = optionalFormValue(form, "note");
      const replacement = editApprovedMemory(memoryId, content, { ...runtime, note });
      return htmlResponse(
        renderManageMemoriesPage(runtime, {
          notice: {
            kind: "success",
            message: `Updated context item ${memoryId}. Replacement context item ${replacement.id} is now active.`
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/memories/retire") {
      const form = await readForm(request);
      const memoryId = parsePositiveInteger(
        requiredFormValue(form, "memoryId", "Context id is required."),
        "Context id"
      );
      const reason = optionalFormValue(form, "reason");
      retireApprovedMemory(memoryId, { ...runtime, reason });
      return htmlResponse(
        renderManageMemoriesPage(runtime, {
          notice: { kind: "info", message: `Retired context item ${memoryId}. It will no longer be used by default.` }
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
          notice: { kind: "success", message: "Approved context exported locally." }
        })
      );
    }

    if (request.method === "GET" && url.pathname === "/sources") {
      const selectedSourceId = parseOptionalPositiveInteger(url.searchParams.get("source") ?? "");
      const sourceSearchQuery = (url.searchParams.get("query") ?? "").trim();
      const sourceSearchResults = sourceSearchQuery
        ? searchSourceChunks(sourceSearchQuery, runtime)
        : undefined;
      return htmlResponse(
        renderSourcesPage(runtime, { selectedSourceId, sourceSearchQuery, sourceSearchResults })
      );
    }

    if (request.method === "POST" && url.pathname === "/sources/import") {
      const form = await readForm(request);
      const pastedContent = (form.get("pastedContent") ?? "").trim();
      const importMode = (form.get("importMode") ?? "").trim();
      const titleValue = (form.get("title") ?? "").trim();
      const source =
        importMode === "paste" || pastedContent
          ? importSource(
              {
                filename: filenameForPastedSource(titleValue || titleFromPastedMemory(pastedContent)),
                content: requiredTextValue(pastedContent, "Paste Markdown or text to import a source."),
                title: titleValue || titleFromPastedMemory(pastedContent)
              },
              runtime
            )
          : importSource(
              {
                filename: requiredFormValue(form, "filename", "Choose a file or paste text below."),
                content: form.get("content") ?? "",
                title: titleValue || undefined
              },
              runtime
            );
      return htmlResponse(
        renderSourcesPage(runtime, {
          selectedSourceId: source.id,
          notice: {
            kind: "success",
            message: `Imported "${source.title}" as a source with ${source.chunk_count} excerpt${
              source.chunk_count === 1 ? "" : "s"
            }. It is not approved context.`
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/sources/rename") {
      const form = await readForm(request);
      const sourceId = parsePositiveInteger(
        requiredFormValue(form, "sourceId", "Source id is required."),
        "Source id"
      );
      const title = requiredFormValue(form, "title", "Source title is required.");
      const source = renameSource(sourceId, title, runtime);
      return htmlResponse(
        renderSourcesPage(runtime, {
          selectedSourceId: source.id,
          notice: { kind: "success", message: `Renamed source "${source.title}".` }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/sources/delete") {
      const form = await readForm(request);
      const sourceId = parsePositiveInteger(
        requiredFormValue(form, "sourceId", "Source id is required."),
        "Source id"
      );
      deleteSource(sourceId, runtime);
      return htmlResponse(
        renderSourcesPage(runtime, {
          notice: {
            kind: "info",
            message:
              "Deleted source. This removed the imported raw source and excerpts. Approved context already created from it will remain."
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/sources/suggest") {
      const form = await readForm(request);
      const sourceId = parsePositiveInteger(
        requiredFormValue(form, "sourceId", "Source id is required."),
        "Source id"
      );
      const limit = parseOptionalPositiveInteger(form.get("limit") ?? "");
      const { drafts, diagnostics } = await suggestMemoriesFromSource(sourceId, { ...runtime, limit });
      return htmlResponse(
        renderSourcesPage(runtime, {
          selectedSourceId: sourceId,
          suggestedDraftIds: drafts.map((draft) => draft.id),
          notice: {
            kind: drafts.length > 0 ? "success" : "info",
            message: buildSuggestionNotice(drafts.length, diagnostics.sourceChunkCount, diagnostics.requestedCount)
          }
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
  <title>ContextCrate</title>
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
    textarea.draft-edit {
      min-height: 84px;
      max-height: 240px;
      overflow-y: auto;
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
        <h1>ContextCrate</h1>
      </div>
      <nav class="top-actions" aria-label="App actions">
        <a href="/sources">Sources</a>
        <a href="/memories">Manage context</a>
        <a href="/memory-pack">LLM context pack</a>
        <a href="#review-drafts">Review context${model.pendingDrafts.length > 0 ? ` (${model.pendingDrafts.length})` : ""}</a>
        <a href="#add-memory">Add context</a>
      </nav>
    </header>

    <p class="mode-label" aria-label="Conversation mode">Mode: ${escapeHtml(model.modeLabel)}</p>

    ${state.notice ? renderNotice(state.notice) : ""}

    ${
      state.longMemoryText
        ? renderLongMemoryChoice(state.longMemoryText)
        : `<section class="chat-card" id="chat">
      <div class="chat-head">
        <form method="post" action="/chat/new">
          <button class="secondary" type="submit"${model.canReadMemory ? "" : " disabled"}>New Chat</button>
        </form>
      </div>
      ${
        model.approvedMemories.length === 0
          ? `<div class="onboarding">
              <p>Just start chatting. ContextCrate will suggest context when something seems worth saving.</p>
              <a class="link-button" href="#add-memory">Add context</a>
            </div>`
          : ""
      }
      ${renderChat(model)}
    </section>

    <div class="memory-panels">
      <details class="panel" id="add-memory"${model.approvedMemories.length === 0 ? " open" : ""}>
        <summary>Add context</summary>
        <div class="panel-body">
          <form class="stack" method="post" action="/drafts">
            <label>
              Paste a note
              <textarea name="text" required placeholder="Paste notes or context to review before approval."></textarea>
            </label>
            <div class="actions">
              <button type="submit">Save for review</button>
            </div>
          </form>
        </div>
      </details>

      <details class="panel" id="review-drafts"${model.pendingDrafts.length > 0 ? " open" : ""}>
        <summary>Review context suggestions${model.pendingDrafts.length > 0 ? ` (${model.pendingDrafts.length})` : ""}</summary>
        <div class="panel-body">
          ${renderDrafts(model.pendingDrafts)}
        </div>
      </details>
    </div>`
    }

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
  <title>ContextCrate System</title>
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
    textarea.draft-edit {
      min-height: 84px;
      max-height: 240px;
      overflow-y: auto;
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
        <h2>Context</h2>
        <p class="hint">Your approved context stays local. Only approved context is used. No outside actions.</p>
        <p>Approved context items: ${model.approvedMemories.length} · Context suggestions waiting: ${
          model.pendingDrafts.length
        } · Retired context items: ${model.retiredMemories.length}</p>
        <p><a href="/memories">Manage context</a> to search, edit, or retire approved context. <a href="/memories?retired=1">Show retired context</a>.</p>
      </section>

      <section>
        <h2>Review context suggestions</h2>
        <div class="stack" style="margin-top: 12px;">
          ${renderDrafts(model.pendingDrafts)}
        </div>
      </section>

      <section>
        <h2>Reflect</h2>
        <form class="stack" method="post" action="/reflect" style="margin-top: 12px;">
          <label>
            Question
            <input type="text" name="question" required placeholder="What context should I use for this pattern?">
          </label>
          <div class="actions">
            <button type="submit">Reflect</button>
          </div>
        </form>
        ${state.reflection ? renderReflection(state.reflection) : ""}
      </section>

      <section>
        <h2>Export</h2>
        <p class="hint">Writes approved context JSON locally under .hermes/export. Nothing is uploaded.</p>
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

function renderManageMemoriesPage(runtime: HermesRuntimeOptions, state: RenderState = {}): string {
  const model = readUiModel(runtime, state);
  const viewingRetired = model.showRetiredMemories;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ContextCrate - Manage context</title>
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
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.45;
    }
    .wrap { width: min(960px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 42px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 18px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 1.55rem; }
    h2 { font-size: 1.08rem; }
    a { color: var(--accent-strong); }
    .back-link, button {
      display: inline-flex; align-items: center; justify-content: center; min-height: 38px;
      border-radius: 6px; padding: 8px 11px; font: inherit; font-weight: 700;
    }
    .back-link { border: 1px solid var(--line); background: #fbfcfb; text-decoration: none; }
    button { border: 0; color: #fff; background: var(--accent); cursor: pointer; }
    button.danger { background: var(--danger); }
    main, .stack { display: grid; gap: 14px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    .hint, .meta, .empty { color: var(--muted); }
    .hint { margin: 4px 0 0; }
    .view-links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
    .notice { border-radius: 8px; padding: 12px 14px; border: 1px solid var(--line); background: #eef8f4; color: var(--accent-strong); }
    .notice.error { background: #fff2f1; color: var(--danger); border-color: #e8c6c2; }
    .notice.info { background: #eef5fb; color: var(--blue); border-color: #c8d9e7; }
    .search-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; }
    label { display: grid; gap: 7px; font-weight: 650; }
    textarea, input[type="search"], input[type="text"], select {
      width: 100%; border: 1px solid var(--line); border-radius: 7px; padding: 11px 12px;
      color: var(--ink); background: #fff; font: inherit;
    }
    textarea { min-height: 120px; resize: vertical; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .item { border-top: 1px solid var(--line); padding-top: 14px; }
    .item:first-child { border-top: 0; padding-top: 0; }
    .item-title { margin: 0 0 6px; font-weight: 750; }
    .content { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
    .pill { display: inline-block; font-size: 0.78rem; font-weight: 700; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
    textarea.draft-edit { min-height: 84px; max-height: 240px; overflow-y: auto; }
    @media (max-width: 760px) {
      header, .search-row { display: grid; grid-template-columns: 1fr; }
      button, .back-link { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Manage context</h1>
        <p class="hint">Edit or retire the context you have approved. Your approved context stays local and explicit.</p>
      </div>
      <a class="back-link" href="/">Back to chat</a>
    </header>
    <main>
      ${state.notice ? renderNotice(state.notice) : ""}
      <section>
        <h2>${viewingRetired ? "Retired &amp; superseded context" : "Active approved context"}</h2>
        <p class="hint">Active approved context: ${model.approvedMemories.length} · Retired or superseded: ${model.retiredMemories.length}</p>
        <p class="hint">Editing creates a new approved context item and retires the old version. Retiring keeps the context for inspection but removes it from chat, search, reflection, and export. Nothing is ever hard-deleted automatically.</p>
        <div class="view-links">
          <a href="/memories">Active context</a>
          <a href="/memories?retired=1">Retired &amp; superseded</a>
        </div>
      </section>

      ${
        viewingRetired
          ? ""
          : `<section>
        <h2>Search your context</h2>
        <form class="search-row" method="get" action="/memories" style="margin-top: 12px;">
          <label>
            Search approved context
            <input type="search" name="query" value="${escapeAttribute(
              model.searchQuery
            )}" placeholder="Search text, tags, category, or source">
          </label>
          <button type="submit">Search</button>
        </form>
      </section>`
      }

      <section>
        <h2>${viewingRetired ? "Retired &amp; superseded" : model.searchQuery ? "Search results" : "Your approved context"}</h2>
        <div class="stack" style="margin-top: 12px;">
          ${renderMemoryResults(model)}
        </div>
      </section>
    </main>
  </div>
</body>
</html>`;
}

function renderMemoryPackPage(runtime: HermesRuntimeOptions, state: RenderState = {}): string {
  const model = readUiModel(runtime, state);
  const matchingMemories = model.searchQuery
    ? (model.searchResults ?? []).map(({ memory }) => memory)
    : model.approvedMemories;
  const selectedIds = state.memoryPackSelectedIds ?? [];
  const selectedSavedPack =
    state.selectedSavedContextPackId !== undefined
      ? getSavedContextPack(state.selectedSavedContextPackId, runtime)
      : undefined;
  const downloadFileName = state.exportPath ? path.basename(state.exportPath) : undefined;
  const downloadHref = downloadFileName
    ? `/memory-pack/download?file=${encodeURIComponent(downloadFileName)}`
    : undefined;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ContextCrate - LLM context pack</title>
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
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.45;
    }
    .wrap { width: min(960px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 42px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 18px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 1.55rem; }
    h2 { font-size: 1.08rem; }
    a { color: var(--accent-strong); }
    .back-link, .link-button, button {
      display: inline-flex; align-items: center; justify-content: center; min-height: 38px;
      border-radius: 6px; padding: 8px 11px; font: inherit; font-weight: 700;
    }
    .back-link, .link-button { border: 1px solid var(--line); background: #fbfcfb; text-decoration: none; }
    button { border: 0; color: #fff; background: var(--accent); cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    main, .stack { display: grid; gap: 14px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    .hint, .meta, .empty { color: var(--muted); }
    .hint { margin: 4px 0 0; }
    .notice { border-radius: 8px; padding: 12px 14px; border: 1px solid var(--line); background: #eef8f4; color: var(--accent-strong); }
    .notice.error { background: #fff2f1; color: var(--danger); border-color: #e8c6c2; }
    .notice.info { background: #eef5fb; color: var(--blue); border-color: #c8d9e7; }
    .search-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; }
    label { display: grid; gap: 7px; font-weight: 650; }
    textarea, input[type="search"], input[type="text"] {
      width: 100%; border: 1px solid var(--line); border-radius: 7px; padding: 11px 12px;
      color: var(--ink); background: #fff; font: inherit;
    }
    textarea { min-height: 96px; resize: vertical; }
    textarea.preview { min-height: 360px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92rem; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .hidden-field { display: none; }
    .memory-choice-list { display: grid; gap: 10px; }
    .memory-choice {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      border-top: 1px solid var(--line);
      padding-top: 12px;
      font-weight: 400;
    }
    .memory-choice:first-child { border-top: 0; padding-top: 0; }
    .memory-choice input { margin-top: 5px; }
    .item { border-top: 1px solid var(--line); padding-top: 12px; }
    .item:first-child { border-top: 0; padding-top: 0; }
    .item-title { display: block; margin: 0 0 5px; font-weight: 750; }
    .content { display: block; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 6px; }
    @media (max-width: 760px) {
      header, .search-row { display: grid; grid-template-columns: 1fr; }
      button, .back-link, .link-button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>LLM context pack</h1>
        <p class="hint">Create a copy-paste-ready context pack from selected approved context.</p>
      </div>
      <a class="back-link" href="/">Back to chat</a>
    </header>
    <main>
      ${state.notice ? renderNotice(state.notice) : ""}
      ${
        state.exportPath && state.memoryPackMarkdown
          ? `<section>
        <h2>Generated context pack</h2>
        <p class="hint">Copy this Markdown into Codex, Claude, ChatGPT, Gemini, or another LLM.</p>
        <div class="actions" style="margin-top: 12px;">
          <button type="button" id="copy-context-pack" data-copy-target="generated-context-pack">Copy context pack</button>
          ${downloadHref ? `<a class="link-button" href="${escapeAttribute(downloadHref)}">Download Markdown</a>` : ""}
          <form method="post" action="/memory-pack/save">
            <input type="hidden" name="title" value="${escapeAttribute(state.memoryPackTitle ?? "LLM context pack")}">
            <input type="hidden" name="exportPath" value="${escapeAttribute(state.exportPath)}">
            <textarea class="hidden-field" name="markdown">${escapeHtml(state.memoryPackMarkdown)}</textarea>
            <button class="secondary" type="submit">Save context pack</button>
          </form>
        </div>
        <p class="notice info" style="margin-top: 12px;">Local export path: ${escapeHtml(state.exportPath)}</p>
        <label style="margin-top: 14px;">
          Generated context pack
          <textarea class="preview" id="generated-context-pack" readonly>${escapeHtml(state.memoryPackMarkdown)}</textarea>
        </label>
      </section>`
          : ""
      }

      <section>
        <h2>Saved context packs</h2>
        <p class="hint">Saved context packs are reusable Markdown export snapshots. Saving one does not create approved context or approve pending suggestions.</p>
        ${
          selectedSavedPack
            ? `<div style="margin-top: 14px;">
          ${renderSavedContextPackCopyArea(selectedSavedPack)}
        </div>`
            : state.selectedSavedContextPackId !== undefined
              ? `<p class="empty" style="margin-top: 14px;">Saved context pack ${state.selectedSavedContextPackId} was not found.</p>`
              : ""
        }
        <div class="stack" style="margin-top: 14px;">
          ${renderSavedContextPackList(model.savedContextPacks)}
        </div>
      </section>

      <section>
        <h2>Find approved context</h2>
        <form class="search-row" method="get" action="/memory-pack" style="margin-top: 12px;">
          <label>
            Search approved context
            <input type="search" name="query" value="${escapeAttribute(
              model.searchQuery
            )}" placeholder="Search text, tags, category, or source">
          </label>
          <button type="submit">Search</button>
        </form>
      </section>

      <section>
        <h2>Build context pack</h2>
        <p class="hint">Only active approved context is available here. The export stays under .hermes/export and does not connect to coding assistants or external services.</p>
        <form class="stack" method="post" action="/memory-pack/export" style="margin-top: 14px;">
          <label>
            Project name
            <input type="text" name="title" required value="${escapeAttribute(
              state.memoryPackTitle ?? ""
            )}" placeholder="Project or work order name">
          </label>
          <label>
            Current next step (optional)
            <textarea name="currentNextStep" placeholder="What should the coding assistant focus on next?">${escapeHtml(
              state.memoryPackCurrentNextStep ?? ""
            )}</textarea>
          </label>
          <label>
            Settled decisions / things not to reopen (optional)
            <span class="hint">Add decisions that are already settled, so a coding assistant does not waste time suggesting them again.</span>
            <textarea name="settledDecisions" placeholder="Settled decisions">${escapeHtml(
              state.memoryPackSettledDecisions ?? ""
            )}</textarea>
          </label>
          <div>
            <p class="item-title">${model.searchQuery ? "Matching active approved context" : "Active approved context"}</p>
            <div class="memory-choice-list" style="margin-top: 10px;">
              ${renderMemoryPackChoices(matchingMemories, selectedIds, model.searchQuery)}
            </div>
          </div>
          <div class="actions">
            <button type="submit"${matchingMemories.length === 0 ? " disabled" : ""}>Generate LLM context pack</button>
          </div>
        </form>
      </section>
    </main>
  </div>
  <script>
    (function () {
      var buttons = document.querySelectorAll("[data-copy-target]");
      buttons.forEach(function (button) {
        button.addEventListener("click", async function () {
          var targetId = button.getAttribute("data-copy-target");
          var pack = targetId ? document.getElementById(targetId) : null;
          if (!pack) { return; }
          if (!navigator.clipboard) {
            pack.focus();
            pack.select();
            button.textContent = "Select and copy";
            return;
          }
          await navigator.clipboard.writeText(pack.value);
          button.textContent = "Copied";
        });
      });
    })();
  </script>
</body>
</html>`;
}

function renderSavedContextPackCopyArea(pack: SavedContextPack): string {
  const textareaId = `saved-context-pack-${pack.id}`;
  return `<article class="item">
    <p class="item-title">${escapeHtml(pack.title)}</p>
    <p class="meta">Saved: ${escapeHtml(pack.created_at)}${pack.filename ? ` · File: ${escapeHtml(pack.filename)}` : ""}</p>
    <div class="actions" style="margin-top: 10px;">
      <button type="button" id="copy-saved-context-pack" data-copy-target="${textareaId}">Copy context pack</button>
      <a class="link-button" href="/memory-pack/saved/download?id=${pack.id}">Download Markdown</a>
    </div>
    <label style="margin-top: 14px;">
      Generated context pack
      <textarea class="preview" id="${textareaId}" readonly>${escapeHtml(pack.markdown)}</textarea>
    </label>
  </article>`;
}

function renderSavedContextPackList(packs: SavedContextPack[]): string {
  if (packs.length === 0) {
    return `<p class="empty">No saved context packs yet.</p>`;
  }

  return packs
    .map(
      (pack) => `<article class="item">
      <p class="item-title">${escapeHtml(pack.title)}</p>
      <p class="meta">Saved: ${escapeHtml(pack.created_at)}${pack.filename ? ` · File: ${escapeHtml(pack.filename)}` : ""}</p>
      <div class="actions" style="margin-top: 10px;">
        <a class="link-button" href="/memory-pack?savedPack=${pack.id}">View saved pack</a>
        <a class="link-button" href="/memory-pack/saved/download?id=${pack.id}">Download Markdown</a>
      </div>
    </article>`
    )
    .join("");
}

function renderSourcesPage(runtime: HermesRuntimeOptions, state: RenderState = {}): string {
  const model = readUiModel(runtime, state);
  const sources = model.canReadMemory ? listSources(runtime) : [];
  const selectedSource =
    state.selectedSourceId !== undefined ? getSource(state.selectedSourceId, runtime) : undefined;
  const selectedChunks =
    selectedSource !== undefined ? getSourceChunks(selectedSource.id, runtime) : [];
  const sourceSearchQuery = state.sourceSearchQuery ?? "";

  // Only the suggestions just created by the latest source request appear inline,
  // and only while they remain pending (handled cards drop out automatically).
  const suggestedDraftIds = state.suggestedDraftIds ?? [];
  const inlineSuggestions =
    model.canReadMemory && suggestedDraftIds.length > 0
      ? model.pendingDrafts.filter((draft) => suggestedDraftIds.includes(draft.id))
      : [];
  const inlineReturnContext: DraftReturnContext | undefined =
    state.selectedSourceId !== undefined
      ? { sourceId: state.selectedSourceId, batchIds: inlineSuggestions.map((draft) => draft.id) }
      : undefined;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ContextCrate Sources</title>
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
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.45;
    }
    .wrap { width: min(960px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 42px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 18px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 1.55rem; }
    h2 { font-size: 1.08rem; }
    a { color: var(--accent-strong); }
    .back-link, button {
      display: inline-flex; align-items: center; justify-content: center; min-height: 38px;
      border-radius: 6px; padding: 8px 11px; font: inherit; font-weight: 700;
    }
    .back-link { border: 1px solid var(--line); background: #fbfcfb; text-decoration: none; }
    button { border: 0; color: #fff; background: var(--accent); cursor: pointer; }
    button.secondary { color: var(--accent-strong); border: 1px solid var(--line); background: #fbfcfb; }
    button.danger { background: var(--danger); }
    main, .stack { display: grid; gap: 14px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    .hint, .meta, .empty { color: var(--muted); }
    .hint { margin: 4px 0 0; }
    .notice { border-radius: 8px; padding: 12px 14px; border: 1px solid var(--line); background: #eef8f4; color: var(--accent-strong); }
    .notice.error { background: #fff2f1; color: var(--danger); border-color: #e8c6c2; }
    .notice.info { background: #eef5fb; color: var(--blue); border-color: #c8d9e7; }
    .search-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; }
    label { display: grid; gap: 7px; font-weight: 650; }
    textarea, input[type="search"], input[type="text"], input[type="file"], input[type="number"] {
      width: 100%; border: 1px solid var(--line); border-radius: 7px; padding: 11px 12px;
      color: var(--ink); background: #fff; font: inherit;
    }
    textarea { min-height: 180px; resize: vertical; }
    .suggest-form { display: grid; gap: 8px; }
    .suggest-count { max-width: 280px; }
    .suggest-count input[type="number"] { width: 96px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .source-management { display: grid; gap: 10px; margin-top: 12px; }
    .source-control {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 10px;
      background: #fbfcfb;
    }
    .source-control summary { cursor: pointer; font-weight: 750; color: var(--accent-strong); }
    .source-control.danger-zone summary { color: var(--danger); }
    .source-control form { margin-top: 10px; }
    .item { border-top: 1px solid var(--line); padding-top: 14px; }
    .item:first-child { border-top: 0; padding-top: 0; }
    .item-title { margin: 0 0 6px; font-weight: 750; }
    .content { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
    .excerpt { border: 1px solid var(--line); border-radius: 7px; padding: 12px; background: #fbfcfb; }
    @media (max-width: 760px) {
      header, .search-row { display: grid; grid-template-columns: 1fr; }
      button, .back-link { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Sources</h1>
        <p class="hint">Imported documents you can search and turn into context suggestions. Sources are not approved context.</p>
      </div>
      <a class="back-link" href="/">Back to chat</a>
    </header>
    <main>
      ${state.notice ? renderNotice(state.notice) : ""}

      ${
        inlineSuggestions.length > 0
          ? `<section aria-label="Context suggestions from this source">
        <h2>Context suggestions from this source</h2>
        <p class="hint">Review each one here. Approving adds it to your approved context; dismissing discards it. Nothing is approved automatically.</p>
        <div class="stack" style="margin-top: 14px;">
          ${inlineSuggestions.map((draft) => renderDraft(draft, inlineReturnContext)).join("")}
        </div>
      </section>`
          : ""
      }

      <section>
        <h2>Import a source</h2>
        <p class="hint">Choose a file or paste text below. Markdown (.md, .markdown) and plain text (.txt) are supported, up to about 1 MB of text.</p>
        <p class="hint">Sources are raw material. They are not approved context until you create and approve suggestions.</p>
        ${
          model.canReadMemory
            ? `<form class="stack" method="post" action="/sources/import" id="import-form" style="margin-top: 12px;">
                <label>
                  Source title
                  <input type="text" name="title" id="source-title" placeholder="A short name for this source">
                </label>
                <label>
                  Choose a file
                  <input type="file" id="source-file" accept=".md,.markdown,.txt,text/markdown,text/plain">
                </label>
                <input type="hidden" name="filename" id="source-filename">
                <input type="hidden" name="content" id="source-content">
                <label>
                  Paste Markdown or text
                  <textarea name="pastedContent" id="source-pasted-content" placeholder="Paste Markdown or text to import as a raw source."></textarea>
                </label>
                <div class="actions">
                  <button type="submit" name="importMode" value="file">Import source</button>
                  <button class="secondary" type="submit" name="importMode" value="paste">Import pasted source</button>
                </div>
              </form>`
            : `<p class="empty">Your local context store could not be opened, so importing is unavailable.</p>`
        }
      </section>

      <section>
        <h2>Search source excerpts</h2>
        <form class="search-row" method="get" action="/sources" style="margin-top: 12px;">
          <label>
            Search imported sources
            <input type="search" name="query" value="${escapeAttribute(sourceSearchQuery)}" placeholder="Search text inside your sources">
          </label>
          <button type="submit">Search</button>
        </form>
        <div class="stack" style="margin-top: 16px;">
          ${renderSourceSearchResults(sourceSearchQuery, state.sourceSearchResults)}
        </div>
      </section>

      <section>
        <h2>Your sources</h2>
        <div class="stack" style="margin-top: 12px;">
          ${renderSourceList(sources)}
        </div>
      </section>

      ${selectedSource ? renderSelectedSource(selectedSource, selectedChunks) : ""}
    </main>
  </div>
  <script>
    (function () {
      var form = document.getElementById("import-form");
      if (!form) { return; }
      var fileInput = document.getElementById("source-file");
      var filenameField = document.getElementById("source-filename");
      var contentField = document.getElementById("source-content");
      var pastedField = document.getElementById("source-pasted-content");
      form.addEventListener("submit", function (event) {
        var submitter = event.submitter;
        var mode = submitter && submitter.getAttribute("value");
        if (mode === "paste" || (pastedField && pastedField.value.trim())) {
          if (!pastedField || !pastedField.value.trim()) {
            event.preventDefault();
            alert("Paste Markdown or text to import a source.");
          }
          if (filenameField) { filenameField.value = ""; }
          if (contentField) { contentField.value = ""; }
          return;
        }
        var file = fileInput && fileInput.files && fileInput.files[0];
        if (!file) {
          event.preventDefault();
          alert("Choose a file or paste text below.");
          return;
        }
        if (contentField.value) { return; }
        event.preventDefault();
        var reader = new FileReader();
        reader.onload = function () {
          filenameField.value = file.name;
          contentField.value = String(reader.result || "");
          if (typeof form.requestSubmit === "function") { form.requestSubmit(); } else { form.submit(); }
        };
        reader.readAsText(file);
      });
    })();
  </script>
</body>
</html>`;
}

function renderSourceList(sources: SourceSummary[]): string {
  if (sources.length === 0) {
    return `<p class="empty">No sources imported yet.</p>`;
  }

  return sources
    .map(
      (source) => `<article class="item">
      <p class="item-title">${escapeHtml(source.title)}</p>
      <p class="meta">File: ${escapeHtml(source.original_filename)} · Imported: ${escapeHtml(
        source.imported_at
      )} · Excerpts: ${source.chunk_count}</p>
      <div class="actions" style="margin-top: 10px;">
        <a class="back-link" href="/sources?source=${source.id}">View excerpts</a>
        <form class="suggest-form" method="post" action="/sources/suggest">
          <input type="hidden" name="sourceId" value="${source.id}">
          <label class="suggest-count">Number of context suggestions
            <input type="number" name="limit" min="1" max="10" value="7">
          </label>
          <button class="secondary" type="submit">Suggest context from this source</button>
        </form>
      </div>
      <div class="source-management">
        <details class="source-control">
          <summary>Rename source</summary>
          <form class="stack" method="post" action="/sources/rename">
            <input type="hidden" name="sourceId" value="${source.id}">
            <label>
              Source title
              <input type="text" name="title" required value="${escapeAttribute(source.title)}">
            </label>
            <div class="actions">
              <button type="submit">Rename source</button>
            </div>
          </form>
        </details>
        <details class="source-control danger-zone">
          <summary>Delete source</summary>
          <p class="item-title" style="margin-top: 10px;">Delete this source?</p>
          <p class="hint">This removes the imported raw source and excerpts. Approved context already created from it will remain.</p>
          <form method="post" action="/sources/delete">
            <input type="hidden" name="sourceId" value="${source.id}">
            <button class="danger" type="submit">Delete source</button>
          </form>
        </details>
      </div>
    </article>`
    )
    .join("");
}

function renderSelectedSource(source: SourceSummary, chunks: SourceChunk[]): string {
  return `<section>
    <h2>${escapeHtml(source.title)}</h2>
    <p class="hint">File: ${escapeHtml(source.original_filename)} · ${chunks.length} excerpt${
      chunks.length === 1 ? "" : "s"
    }. Excerpts are raw source text, not approved context.</p>
    <div class="stack" style="margin-top: 14px;">
      ${
        chunks.length === 0
          ? `<p class="empty">This source has no excerpts.</p>`
          : chunks
              .map(
                (chunk) => `<div class="excerpt">
            <p class="meta">Excerpt ${chunk.chunk_index + 1}</p>
            <p class="content">${escapeHtml(chunk.content)}</p>
          </div>`
              )
              .join("")
      }
    </div>
  </section>`;
}

function renderSourceSearchResults(
  query: string,
  results: SourceChunkResult[] | undefined
): string {
  if (!query) {
    return `<p class="empty">Enter a search to look inside your imported sources.</p>`;
  }

  const found = results ?? [];
  if (found.length === 0) {
    return `<p class="empty">No source excerpts matched "${escapeHtml(query)}".</p>`;
  }

  return found
    .map(
      ({ chunk, sourceTitle, snippet }) => `<article class="item">
      <p class="item-title">${escapeHtml(sourceTitle)} · excerpt ${chunk.chunk_index + 1}</p>
      <p class="content">${escapeHtml(snippet)}</p>
    </article>`
    )
    .join("");
}

function readUiModel(runtime: HermesRuntimeOptions, state: RenderState) {
  const report = doctor(runtime);
  const canReadMemory = report.dbExists && Object.values(report.tables).every(Boolean);
  const pendingDrafts = canReadMemory ? listPendingDrafts(runtime) : [];
  const approvedMemories = canReadMemory ? listApprovedMemories(runtime) : [];
  const retiredMemories = canReadMemory ? listRetiredMemories(runtime) : [];
  const savedContextPacks = canReadMemory ? listSavedContextPacks(runtime) : [];
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
  const latestUserMessage = [...chatMessages].reverse().find((message) => message.role === "user");
  const latestSourceExcerpts =
    canReadMemory && latestUserMessage
      ? retrieveRelevantSourceChunks(latestUserMessage.content, { ...runtime, limit: 3 })
      : [];
  const searchQuery = state.searchQuery ?? "";
  const modeLabel = state.chatTurn?.providerLabel ?? chatModeLabel();
  const showRetiredMemories = Boolean(state.showRetiredMemories);

  return {
    report,
    canReadMemory,
    modeLabel,
    pendingDrafts,
    approvedMemories,
    retiredMemories,
    savedContextPacks,
    chatSessions,
    activeSessionId,
    chatMessages,
    latestHermesMessage,
    latestMemorySources,
    latestMemorySuggestion,
    latestSourceExcerpts,
    searchQuery,
    searchResults: state.searchResults,
    showRetiredMemories
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
        ${
          model.canReadMemory
            ? ""
            : `<p class="hint">ContextCrate could not open your local context store.</p>`
        }
      </div>
    </form>

    <div class="chat-toolbar">
      <form method="post" action="/chat/save-draft">
        ${sessionInput}
        <button class="secondary" type="submit"${
          model.activeSessionId && model.latestHermesMessage ? "" : " disabled"
        }>Save for review</button>
      </form>
      ${renderLatestMemorySources(model.latestMemorySources)}
      ${renderSourceExcerpts(model.latestSourceExcerpts)}
    </div>
  </div>`;
}

function renderSourceExcerpts(excerpts: SourceChunkResult[]): string {
  if (excerpts.length === 0) {
    return "";
  }

  return `<details class="memory-sources source-excerpts">
    <summary>Source excerpts</summary>
    <p>Raw passages from imported sources. These are reference only, not approved context.</p>
    <ul>
      ${excerpts
        .map(
          ({ chunk, sourceTitle, snippet }) =>
            `<li>${escapeHtml(sourceTitle)} (excerpt ${chunk.chunk_index + 1}): ${escapeHtml(snippet)}</li>`
        )
        .join("")}
    </ul>
  </details>`;
}

function renderChatMessage(message: ChatMessage, approvedMemories: MemoryEntry[]): string {
  const speaker = message.role === "user" ? "You" : "ContextCrate";
  const content = message.role === "hermes" ? stripMemoriesUsedSection(message.content) : message.content;
  const sources =
    message.role === "hermes"
      ? renderMemorySources(memorySourcesForMessage(message, approvedMemories), "No approved context used for this response.")
      : "";

  return `<article class="chat-message ${message.role}">
    <p class="speaker">${speaker}</p>
    <p class="message-body">${escapeHtml(content)}</p>
    ${sources}
  </article>`;
}

function renderLatestMemorySources(sources: UiMemorySource[]): string {
  if (sources.length === 0) {
    return "";
  }
  return renderMemorySources(sources, "");
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

  return `<section class="memory-suggestion" aria-label="Context suggestion">
    <div>
      <h3>This seems useful as approved context.</h3>
      <p class="suggestion-meta">Suggested as ${escapeHtml(
        suggestion.suggestedCategory
      )} · Tags: ${escapeHtml(tags)} · From this chat</p>
    </div>
    <form class="stack" method="post" action="/memory-suggestions/save">
      ${hiddenFields}
      <label>
        Proposed context
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
    <summary>Sources from approved context</summary>
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

function renderLongMemoryChoice(text: string): string {
  return `<section class="chat-card" id="add-memory-choice">
    <div class="stack">
      <div>
        <h2>This looks like a long note or source.</h2>
        <p class="hint">Long context blocks can become hard to retrieve later. Choose how to handle it.</p>
      </div>
      <details>
        <summary>Preview pasted note</summary>
        <pre>${escapeHtml(snippet(text, 1600))}</pre>
      </details>
      <div class="actions" aria-label="Long context choices">
        <form method="post" action="/drafts/long/split">
          ${renderHiddenLongMemoryText(text)}
          <button type="submit">Split into context suggestions</button>
        </form>
        <form method="post" action="/drafts/long/import">
          ${renderHiddenLongMemoryText(text)}
          <button class="secondary" type="submit">Import as source</button>
        </form>
        <form method="post" action="/drafts/long/save-one">
          ${renderHiddenLongMemoryText(text)}
          <button class="secondary" type="submit">Save as one context item anyway</button>
        </form>
      </div>
      <p class="hint">Anything saved as context still waits for your approval before it becomes part of your approved context.</p>
      <a class="link-button" href="/">Back to chat</a>
    </div>
  </section>`;
}

function renderHiddenLongMemoryText(text: string): string {
  return `<textarea name="text" hidden>${escapeHtml(text)}</textarea>`;
}

function renderDrafts(drafts: MemoryDraft[]): string {
  if (drafts.length === 0) {
    return `<p class="empty">No context suggestions waiting.</p>`;
  }

  return `<div class="stack">${drafts.map((draft) => renderDraft(draft)).join("")}</div>`;
}

// When a card is reviewed inline on the Sources page, the approve/dismiss forms
// carry enough context for the shared routes to re-render Sources and keep the
// rest of this batch of suggestions visible.
interface DraftReturnContext {
  sourceId: number;
  batchIds: number[];
}

function renderDraft(draft: MemoryDraft, returnContext?: DraftReturnContext): string {
  const sourceLine =
    draft.source_type === "source"
      ? `<p class="meta">From ${escapeHtml(draft.source_label)}</p>`
      : "";
  const returnFields = returnContext
    ? `<input type="hidden" name="returnTo" value="sources">
      <input type="hidden" name="sourceId" value="${returnContext.sourceId}">
      <input type="hidden" name="batchIds" value="${returnContext.batchIds.join(",")}">`
    : "";
  return `<article class="item">
    <p class="item-title"><span>Context suggestion</span></p>
    <p class="meta">Suggested as ${escapeHtml(draft.proposed_category)} · Tags: ${escapeHtml(
      formatTags(draft.proposed_tags_json)
    )}</p>
    ${sourceLine}
    <form class="stack" method="post" action="/drafts/approve" style="margin-top: 10px;">
      <input type="hidden" name="draftId" value="${draft.id}">
      ${returnFields}
      <label>
        Context text
        <textarea class="draft-edit" name="content" rows="4">${escapeHtml(draft.proposed_content)}</textarea>
      </label>
      <div class="actions">
        <button type="submit">Approve context</button>
      </div>
    </form>
    <form method="post" action="/drafts/reject" style="margin-top: 8px;">
      <input type="hidden" name="draftId" value="${draft.id}">
      ${returnFields}
      <button class="danger" type="submit">Dismiss</button>
    </form>
  </article>`;
}

function renderMemoryPackChoices(memories: MemoryEntry[], selectedIds: number[], query: string): string {
  if (memories.length === 0) {
    return `<p class="empty">${
      query
        ? `No active approved context matched "${escapeHtml(query)}".`
        : "No active approved context is available."
    }</p>`;
  }

  return memories
    .map((memory) => {
      const checked = selectedIds.includes(memory.id) ? " checked" : "";
      return `<label class="memory-choice">
        <input type="checkbox" name="memoryId" value="${memory.id}"${checked}>
        <span>
          <span class="item-title">[${memory.id}] ${escapeHtml(memory.category)}</span>
          <span class="meta">Created: ${escapeHtml(memory.created_at)} · Tags: ${escapeHtml(
            formatTags(memory.tags_json)
          )}</span>
          <span class="content">${escapeHtml(compactText(memory.content, 320))}</span>
        </span>
      </label>`;
    })
    .join("");
}

function renderMemoryResults(model: ReturnType<typeof readUiModel>): string {
  if (model.showRetiredMemories) {
    return renderRetiredMemories(model.retiredMemories, model.approvedMemories);
  }

  if (model.searchQuery) {
    const results = model.searchResults ?? [];
    if (results.length === 0) {
      return `<p class="empty">No approved context matched "${escapeHtml(model.searchQuery)}".</p>`;
    }
    return results.map(({ memory, snippet }) => renderMemory(memory, snippet)).join("");
  }

  if (model.approvedMemories.length === 0) {
    return `<p class="empty">No approved context.</p>`;
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
    <details style="margin-top: 10px;">
      <summary>Edit context</summary>
      <p class="hint">Editing creates a new approved context item and retires this version from normal use.</p>
      <form class="stack" method="post" action="/memories/edit" style="margin-top: 10px;">
        <input type="hidden" name="memoryId" value="${memory.id}">
        <label>
          Context text
          <textarea class="draft-edit" name="content" rows="4" required>${escapeHtml(memory.content)}</textarea>
        </label>
        <label>
          Note (optional)
          <input type="text" name="note" placeholder="What changed?">
        </label>
        <div class="actions">
          <button type="submit">Save edited context</button>
        </div>
      </form>
    </details>
    <form class="actions" method="post" action="/memories/retire" style="margin-top: 10px;">
      <input type="hidden" name="memoryId" value="${memory.id}">
      <label>
        Retire reason
        <select name="reason">
          <option value="">No reason</option>
          <option value="outdated">Outdated</option>
          <option value="wrong">Wrong</option>
          <option value="duplicate">Duplicate</option>
          <option value="too broad">Too broad</option>
          <option value="no longer relevant">No longer relevant</option>
          <option value="other">Other</option>
        </select>
      </label>
      <button class="danger" type="submit">Retire context</button>
    </form>
  </article>`;
}

function renderRetiredMemories(retiredMemories: MemoryEntry[], activeMemories: MemoryEntry[]): string {
  if (retiredMemories.length === 0) {
    return `<div class="stack">
      <p class="empty">No retired context.</p>
      <p><a href="/memories">Show active context</a></p>
    </div>`;
  }

  return `<div class="stack">
    <p class="hint">Retired and superseded context is kept for inspection, but is not used by chat, search, reflection, or export by default.</p>
    <p><a href="/memories">Show active context</a></p>
    ${retiredMemories.map((memory) => renderRetiredMemory(memory, activeMemories)).join("")}
  </div>`;
}

function renderRetiredMemory(memory: MemoryEntry, activeMemories: MemoryEntry[]): string {
  const replacement = activeMemories.find((candidate) => candidate.supersedes_id === memory.id);
  return `<article class="item">
    <p class="item-title"><span>[${memory.id}] ${escapeHtml(memory.category)}</span> <span class="pill">${escapeHtml(
      memory.status
    )}</span></p>
    <p class="meta">Created: ${escapeHtml(memory.created_at)} · Retired: ${escapeHtml(
      memory.retired_at ?? memory.deleted_at ?? "unknown"
    )} · Reason: ${escapeHtml(memory.retired_reason ?? "(none)")}</p>
    ${
      replacement
        ? `<p class="meta">Replacement context item: [${replacement.id}]</p>`
        : memory.supersedes_id
          ? `<p class="meta">Supersedes context item: [${memory.supersedes_id}]</p>`
          : ""
    }
    <p class="content">${escapeHtml(memory.content)}</p>
  </article>`;
}

function renderReflection(report: ReflectionReport): string {
  return `<div class="stack" style="margin-top: 16px;">
    <p class="notice info">Deterministic reflection from approved context only.</p>
    <pre>${escapeHtml(
      [
        `Question: ${report.question}`,
        `Relevant context ids: ${report.relevantMemoryIds.length > 0 ? report.relevantMemoryIds.join(", ") : "none"}`,
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
    snippet: compactText(memoriesById.get(id)?.content ?? "Context is not available in the approved list.", 140)
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
  return content.split(/\n\n(?:Context used|Memories used):\n/)[0] ?? content;
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

function markdownDownloadResponse(runtime: HermesRuntimeOptions, requestedFile: string): Response {
  const fileName = requestedFile.trim();
  if (!/^[A-Za-z0-9._-]+\.md$/.test(fileName)) {
    throw new Error("Markdown export file is required.");
  }
  const paths = resolveHermesPaths(runtime);
  const exportDir = path.resolve(paths.exportDir);
  const filePath = path.resolve(exportDir, fileName);
  if (!filePath.startsWith(`${exportDir}${path.sep}`)) {
    throw new Error("Markdown export file is required.");
  }
  if (!fs.existsSync(filePath)) {
    throw new Error("Markdown export file was not found.");
  }
  const markdown = fs.readFileSync(filePath, "utf8");
  return new Response(markdown, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store"
    }
  });
}

function savedContextPackDownloadResponse(runtime: HermesRuntimeOptions, packId: number): Response {
  const pack = getSavedContextPack(packId, runtime);
  if (!pack) {
    throw new Error(`Saved context pack ${packId} was not found.`);
  }
  const fileName = filenameForSavedContextPack(pack);
  return new Response(`${pack.markdown}\n`, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store"
    }
  });
}

function filenameForSavedContextPack(pack: SavedContextPack): string {
  if (pack.filename && /^[A-Za-z0-9._-]+\.md$/.test(pack.filename)) {
    return pack.filename;
  }
  const slug = pack.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "saved-context-pack"}-${pack.id}.md`;
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

function requiredTextValue(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function optionalFormValue(form: URLSearchParams, key: string): string | undefined {
  const value = (form.get(key) ?? "").trim();
  return value || undefined;
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

// Inline source-review cards post here too. When they do, return the state needed
// to re-render the Sources page with the rest of the just-created batch (minus the
// suggestion that was just handled), instead of the main chat page.
function sourcesReturnState(
  form: URLSearchParams,
  handledDraftId: number
): { selectedSourceId?: number; suggestedDraftIds: number[] } | undefined {
  if ((form.get("returnTo") ?? "") !== "sources") {
    return undefined;
  }
  const selectedSourceId = parseOptionalPositiveInteger(form.get("sourceId") ?? "");
  const remaining = parseIdList(form.get("batchIds") ?? "").filter((id) => id !== handledDraftId);
  return { selectedSourceId, suggestedDraftIds: remaining };
}

function parseIdList(value: string): number[] {
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
}

// Honest feedback: the whole source was reviewed, and the count is explained
// rather than silently returning fewer than requested.
function buildSuggestionNotice(suggestionCount: number, chunkCount: number, requestedCount: number): string {
  const reviewed = `Reviewed ${chunkCount} source excerpt${chunkCount === 1 ? "" : "s"}.`;
  if (suggestionCount === 0) {
    return `${reviewed} No new durable, standalone suggestions were found in this source.`;
  }
  const noun = `memor${suggestionCount === 1 ? "y" : "ies"}`;
  if (suggestionCount < requestedCount) {
    const verb = suggestionCount === 1 ? "was" : "were";
    return `${reviewed} Suggested ${suggestionCount} ${noun} for review. Only ${suggestionCount} strong new suggestion${
      suggestionCount === 1 ? "" : "s"
    } ${verb} found. Approve or edit each one when you’re ready.`;
  }
  return `${reviewed} Suggested ${suggestionCount} ${noun} for review. Approve or edit each one when you’re ready.`;
}

function isLongDirectMemoryInput(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const paragraphs = normalized.split(/\n\s*\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const lines = normalized.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const bulletLines = lines.filter((line) => /^(?:[-*+]\s+|\d+[.)]\s+)/.test(line)).length;
  const headingLines = lines.filter((line) => /^#{1,6}\s+\S/.test(line)).length;

  return (
    normalized.length > LONG_DIRECT_MEMORY_CHARS ||
    paragraphs.length >= LONG_DIRECT_MEMORY_PARAGRAPHS ||
    bulletLines >= LONG_DIRECT_MEMORY_BULLETS ||
    headingLines > 0 ||
    lines.length >= LONG_DIRECT_MEMORY_LINES
  );
}

function titleFromPastedMemory(text: string): string {
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines
    .map((line) => /^#{1,6}\s+(.+)$/.exec(line)?.[1]?.trim())
    .find((value): value is string => Boolean(value));
  if (heading) {
    return trimTitle(heading);
  }

  const firstReadableLine = lines.find((line) => line.length >= 4 && line.length <= 100);
  if (firstReadableLine) {
    return trimTitle(firstReadableLine.replace(/^[-*+]\s+/, ""));
  }

  return `Pasted note - ${formatLocalTimestamp(new Date())}`;
}

function filenameForPastedSource(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "pasted-source"}.md`;
}

function trimTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 100 ? `${normalized.slice(0, 97)}...` : normalized;
}

function formatLocalTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function snippet(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
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
      process.stdout.write(`ContextCrate Local Web Chat: ${url}\n`);
      process.stdout.write("Local-only. Only approved context is used for chat/list/search/reflect.\n");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
