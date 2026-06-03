# Architecture

ContextCrate (internal/codename HERmes) is a local context generator for LLM-ready context packs. It has a localhost-only web chat UI, a small SQLite-backed service layer, approval-first context suggestions, a source library, an LLM context-pack export flow, a chat provider layer with an optional Claude API mode, and an advanced CLI. The browser UI is local-only; it is not an external web app and does not add automation capabilities.

Obsidian or other notes remain the broad memory / second-brain layer. ContextCrate is the narrower handoff layer: selected notes and sources become reviewable suggestions, explicit approval turns them into approved context, and selected approved context can be exported as copy-paste-ready packs for ChatGPT, Claude, Codex, Gemini, and other LLMs. It is not an autonomous agent and does not act externally.

## Components

- `src/cli.ts` defines the Commander CLI.
- `src/chat.ts` contains deterministic chat response, idea mode, organic context suggestion, chat persistence logic, the `DeterministicChatProvider`, and `resolveChatProvider`.
- `src/ui.ts` contains the loopback-only HTTP server and server-rendered local web chat/review UI.
- `src/hermes.ts` contains the memory workflow operations.
- `src/sources.ts` contains the source library: import (deterministic chunking, content hash, size limit), listing, search, source-grounded context suggestions (deterministic extraction plus optional provider-assisted extraction with deterministic fallback), and chat retrieval of relevant source excerpts.
- `src/db.ts` owns database path resolution, schema creation, and SQLite access.
- `src/draftGeneration.ts` contains deterministic draft proposal logic.
- `src/format.ts` formats CLI output.
- `src/llm/chatMode.ts` resolves the chat mode from environment variables (the only place the API key is read).
- `src/llm/anthropicChatProvider.ts` is the optional Anthropic Claude API chat provider.
- `src/llm/types.ts` and `src/llm/noopProvider.ts` hold the separate memory-proposal/reflection provider scaffolding.

## Layered design

1. **Local approved context store** — SQLite under `.hermes/`, owned by `src/db.ts`. Approved context lives in the historical `memory_entries` table. Imported documents live in `sources`/`source_chunks` and are raw, not approved.
2. **Retrieval layer** — `retrieveRelevantApprovedMemories` in `src/hermes.ts` selects approved context relevant to a chat message. `retrieveRelevantSourceChunks` in `src/sources.ts` selects relevant raw source excerpts using the same term-overlap approach (no embeddings).
3. **Provider layer** — the `ChatProvider` interface. It receives the user message, recent chat context, retrieved approved context, and relevant source excerpts, and returns response text plus an optional proposed context suggestion. Providers are given no tools. The provider prompt distinguishes durable approved context from raw, possibly incomplete source excerpts.
4. **Deterministic fallback** — `DeterministicChatProvider` is the default and is used whenever API mode is not configured or an API call fails. Its text is identical to the prior offline behavior.
5. **Optional API provider** — `AnthropicChatProvider` is used only when `HERMES_CHAT_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are present.
6. **Approval boundary** — only explicit human approval (`approveDraft`) writes `memory_entries`. No provider can cross this boundary.

The model may read retrieved approved context and chat context and may generate response/suggestion text (in API mode). State-changing agency is forbidden: no provider can approve context, execute tools, browse, access accounts, schedule work, or write approved context directly.

## Provider configuration layer

`src/llm/chatMode.ts` holds a small provider registry (`CHAT_PROVIDERS`) plus `resolveChatModeConfig`. Each entry is a `ChatProviderDescriptor` with a stable internal `id`, a short non-technical `displayName`, whether it `requiresApiKey`, and the `apiKeyEnvVar` that supplies the key. The UI and CLI read provider display names through `providerDisplayName` / `chatModeLabel` instead of hardcoding strings, so the minimal chat surface shows a subtle "Mode: Local" or "Mode: Claude" label.

- `deterministic` → display name **Local** (default, fully offline).
- `anthropic` → display name **Claude** (optional API, selected via `HERMES_CHAT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`).

Adding a future provider means adding a descriptor to the registry, an id to `ChatProviderId`, and a `ChatProvider` implementation selected in `resolveChatProvider`; no UI or business-logic change is needed for the label. API keys are read from environment variables only for the single model call: they are never stored in SQLite, surfaced in the UI, logged, or included in errors/exports. Regardless of provider, the interface stays the same: providers receive only selected approved context, current chat context, and selected source excerpts, get no tools, and cannot approve or write context.

## Data Flow

1. Intake receives explicit text or one explicit file path.
2. Deterministic proposal logic creates pending drafts.
3. Review displays pending drafts.
4. Approval writes an approved context entry and audit events.
5. Search, reflection, listing, web chat, terminal chat, JSON export, and LLM Context Pack export read active approved context only.
6. Chat can produce an organic context suggestion from deterministic durable-statement rules.
7. Saving a suggestion for review writes a pending draft only.
8. Chat "Save for review" writes the latest exchange as a pending draft only.

Organic memory flow:

```text
chat message -> context suggestion -> save for review -> approve context -> approved context
```

Direct requests such as "remember that..." skip the suggestion card and save the statement for review, not as approved context. Short payloads become one pending suggestion. Longer multi-paragraph or bulleted remember-this payloads use a chat-local extraction path that creates several concise pending suggestions from the pasted material, with provider-assisted extraction when available and deterministic fallback if the provider fails. Command phrases such as "Can you remember all this?" are instruction text only and are filtered before any draft can be created.

Direct Add context intake is intentionally context-shape aware. Short notes still create one pending draft immediately. Long, multi-paragraph, markdown-like, or source-like notes render a choice screen before any write: split into pending context suggestions, import as a source, or save as one pending context item anyway. This is guidance, not a safety block; explicit approval is still required before any context is approved.

Approved memory correction flow (v0.4.7):

```text
approved context -> explicit edit -> replacement approved context + superseded old context
approved context -> explicit retire -> tombstoned context excluded from normal retrieval
```

Edits and retirements are local, explicit human actions. Editing creates a new approved row that points to the prior row via `supersedes_id`, then marks the prior row superseded/retired from normal use. Retiring marks the row as a tombstone rather than hard-deleting it. Retired and superseded context remains inspectable on the Manage context page (`/memories?retired=1`) and in `memory_events`, but is excluded from normal chat retrieval, search, reflection, and export by default. There is no hard delete by default and no automatic cleanup or staleness detection.

As of v0.4.8 these controls are exposed on a dedicated **Manage context** page (`GET /memories`, rendered by `renderManageMemoriesPage`), reachable from a clearly visible "Manage context" link in the main chat page's top navigation. The page lists active approved context with inline Edit and Retire controls, offers approved-context search, and links to the retired/superseded view. `POST /memories/edit` and `POST /memories/retire` re-render this page. Earlier (v0.4.7) the same controls were only rendered on the Diagnostics/System page, reachable solely via the small footer link, which made them effectively undiscoverable during dogfooding; the System page now links to Manage context instead of duplicating the edit/retire surface. No backend, retrieval, or approval behavior changed.

LLM Context Pack Export flow:

```text
active approved context -> explicit selection -> Markdown pack under .hermes/export -> copy/paste into LLM or coding assistant
```

`exportProjectMemoryPack` in `src/hermes.ts` is a local export helper, not an integration layer. It validates the selected ids against active approved context only, rejects retired/superseded/missing ids, groups selected context deterministically, writes a Markdown file under `.hermes/export/`, and records a local export event. Output paths supplied by the CLI must resolve under `.hermes/export/` and end in `.md`.

The UI page (`GET /memory-pack`, rendered by `renderMemoryPackPage`) is reachable from the main navigation as **LLM context pack**. It lets James search active approved context, choose checkboxes, provide a project title, optional current next step, and optional **Settled decisions / things not to reopen** notes, then posts to `POST /memory-pack/export` through the same local UI POST guard as the rest of the app. The helper text says: "Add decisions that are already settled, so a coding assistant does not waste time suggesting them again." After export it renders the generated Markdown directly on the page as **Generated context pack**, with **Copy context pack** as the primary action and **Download Markdown** as the secondary file path.

The CLI wrapper (`hermes memory-pack --query "..." --title "..." --settled-decisions "..." --out .hermes/export/foo.md`) selects active approved context by query, or by explicit `--ids`, and delegates to the same helper. The subcommand name remains `memory-pack` for compatibility. It does not connect to agents and does not write into any repo.

The Markdown pack is intended as copy/paste context for ChatGPT, Claude, Codex, Gemini, Claude Code, and similar tools. It states that it was exported from human-approved context, includes selected approved-context ids/categories/tags/content/timestamps, and ends with an action-boundary footer: it is not permission to edit files, commit, push, run commands, access accounts, or take external actions unless James explicitly says so in the current work order. The approval invariant is unchanged: only explicit human approval writes approved context.

Source library flow (v0.4.0):

```text
source import -> source library (sources/source_chunks) -> source excerpts -> context suggestions (save for review) -> approve context -> approved context
```

Sources may be imported, renamed, deleted, searched, viewed, and used to propose context suggestions, and relevant excerpts may be retrieved into chat context. None of these paths write `memory_entries`. Renaming changes only the source title. Deleting a source removes the raw `sources` row and its `source_chunks`, but approved context already created from it remains in `memory_entries`; pending drafts are not automatically cleaned up. The approval boundary is unchanged: only explicit `approveDraft` creates approved context. The model may read selected source excerpts and approved context to generate a response; it may not approve context, execute tools, browse, access accounts, schedule work, or write approved context directly. File import reads only the file the user explicitly selects (read client-side in the browser and posted as text); it never crawls or reads arbitrary filesystem paths, and a per-file size limit (~1 MB of text) applies.

### Source memory extraction (v0.4.2)

`suggestMemoriesFromSource` is the **full-source extraction workflow** that turns raw source chunks into save-for-review suggestions. It reviews the whole source (all chunks, in `chunk_index` order) rather than a chat-style top-N retrieval, resolves a candidate count (default 7, clamped 1–10), gathers the user's existing approved + pending memory texts for de-duplication, and produces `SourceMemoryCandidate`s (content, category, tags, optional rationale, optional chunk indexes) through two routes. It returns a `SourceSuggestionResult` (`{ drafts, diagnostics }`).

- **Deterministic extraction** (`extractDeterministicSourceMemories`) is the default and the always-available fallback. It splits chunk text into statements, drops document metadata (markdown/all-caps headings, `Title:`/`Purpose:`/`Created:`/filename lines, and short `Label: value` fragments such as "Dynamics: Not tribal."), keeps only complete standalone sentences (capitalized start, terminal punctuation, minimum length/word count) that match durable-context signals, dedupes, and ranks by signal strength.
- **Provider-assisted extraction** is used only when a chat provider exposing `extractSourceMemories` is configured (`HERMES_CHAT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`, or an injected provider in tests). Chunks are grouped into ordered batches under a char budget (`MAX_BATCH_CHARS`): a small source is one batch (whole source in a single call); a large source is processed map-reduce style — one call per batch, then candidates are combined, validated, de-duplicated, ranked, and trimmed to the requested count. `AnthropicChatProvider.extractSourceMemories` sends the batch excerpts as text with `SOURCE_EXTRACTION_PROMPT` (JSON-array-only contract), passes the existing-memory list so the model avoids repeats, uses a larger output token budget than chat, and parses the response defensively.

Fallback is precise: a **genuine provider failure** (network/HTTP/parse error thrown by any batch) falls back to deterministic extraction; a **successful-but-empty** provider result does not fall back (it is an honest "nothing strong found"). After either route, `finalizeCandidates` validates each candidate (complete-ish standalone content, minimum length, not metadata/heading-only), removes near-duplicates of one another and of existing approved/pending memories (normalized exact, substring, and token-Jaccard ≥ 0.8), ranks by durable-signal strength preserving source order on ties, and slices to the requested count.

Each surviving candidate becomes a pending draft via `createDraftFromProposal` with `source_type = "source"`. The provider receives text only, gets no tools, and cannot approve or write context. The approval boundary is unchanged: only explicit `approveDraft` writes `memory_entries`, and the review UI lets a human edit a suggestion (`updateDraftProposedContent`) before approving it. The API key is read from the environment for the single model call only and is never stored, logged, rendered, or exported.

`suggestMemoriesFromSource` also returns `SourceExtractionDiagnostics` (source id/title, chunk count, total chars, chunks sent, approx chars sent, batch count, requested count, provider-returned count, duplicates skipped, final saved-for-review count, and `mode`). The UI uses these counts to report honestly that the whole source was reviewed and to explain when fewer than the requested number were found. Setting `HERMES_DEBUG_EXTRACTION` writes the same counts-only object to stderr; it never includes source body content or the API key. Chat continues to use `retrieveRelevantSourceChunks` (term-overlap retrieval), which is intentionally separate from this full-source path.

## User-Facing Language vs. Internal Storage

As of the ContextCrate framing pass, the browser UI uses context-generator language and hides developer/internal terms. The UI says "ContextCrate", "context suggestion", "This seems useful as approved context.", "Save for review", "Saved for review", "Review context suggestions", "Approve context", "Manage context", and "LLM context pack". The default chat page no longer exposes "draft", database paths, or table names.

Underlying storage is unchanged. A context suggestion saved for review is still persisted as a `pending` row in `memory_drafts`, and approval still writes `memory_entries`. "Save for review" maps to draft creation, "Approve context" maps to draft approval, and "Dismiss" maps to draft rejection. Internal route paths (`/drafts`, `/drafts/approve`, `/drafts/reject`), database tables, env vars, package names, and form fields keep their existing names; only the visible language changed.

As of v0.3.0 the chat provider layer adds an optional Claude API mode. A subtle "Mode:" label on the chat page reflects the active provider, and the prominent "System" header button is replaced by a small footer "Diagnostics" link to `/system`. When the API is enabled, generated text and proposed suggestions still flow through the same human approval boundary.

As of v0.4.3 the Sources page shows the suggestions just created by the latest "Suggest context from this source" request inline, directly under the result notice, so the user can edit, approve, or dismiss each one without navigating to Review context. The inline cards reuse `renderDraft` and the existing `/drafts/approve` and `/drafts/reject` routes; a hidden `returnTo=sources` field (plus `sourceId` and a `batchIds` list) carries enough state to re-render the Sources page with the handled suggestion removed. Inline cards appear only for the latest batch's still-pending ids, so unrelated global pending drafts are not surfaced here. The approval boundary is unchanged: only explicit `approveDraft` writes `memory_entries`.

## Local UI Server

`src/ui.ts` starts a Node HTTP server bound to loopback by default at `127.0.0.1:8787`. It refuses non-loopback hosts and rejects non-local/cross-site state-changing requests. The UI ensures the local SQLite schema exists on first request, so normal use does not require an initialization button.

The default page is intentionally chat-first: app name, a subtle conversation-mode label, chat history, message input, assistant responses, approved-context sources, organic context suggestions, save-for-review, Add context, and Review context suggestions. The top navigation links to **Sources**, **Manage context** (`/memories`), and **LLM context pack** (`/memory-pack`), the everyday context surfaces. Approved-context search, edit, and retire live on the Manage context page. Source rename/delete controls live on the Sources page. LLM Context Pack Export lives on its own page, renders generated Markdown for copy/paste, and also writes Markdown under `.hermes/export/`. Technical diagnostics, database path, table status, deterministic reflection, and local JSON export live behind `/system`, reached only via a small footer "Diagnostics" link. The page opens in Local mode with no API key required; Claude mode is optional and only affects chat-response wording when configured.

The server calls the existing service functions directly. It introduces no external connectors, MCP, browser automation, shell execution, scheduler, daemon, subagents, account access, or autonomous actions. The only optional outbound network call is the configured Claude API model endpoint, used purely for chat text generation when API mode is enabled; the model still receives no tools and cannot approve context.

## Storage

Runtime data is stored under `.hermes/`. The default database is `.hermes/hermes.db`; the demo uses `.hermes/demo.db`.

Approved memories are not silently overwritten. Corrections use explicit supersession: a replacement approved row points back with `supersedes_id`, while the prior row is marked superseded with `retired_at`/`retired_reason`. Retirements mark rows as tombstones (internal status `deleted`) with `retired_at`/`retired_reason`; they are not hard-deleted by default.

Chat sessions and messages are stored in `chat_sessions` and `chat_messages` in the same local SQLite database. Assistant messages record the approved context IDs used for that response.

Dismissed organic suggestions are stored in `memory_suggestion_dismissals`, keyed to the local chat session, user message, and deterministic suggestion hash. This prevents the same suggestion from reappearing after the user dismisses or saves it.

The approval-first invariant is unchanged: only explicit draft approval writes new approved context from suggestions, and only explicit human edit/retire actions change approved context state. Intake, chat save, direct remember requests, organic suggestion save, and generated reflection create drafts or temporary output only. Models/providers cannot approve, edit, retire, delete, or supersede context.

Memory candidate detection in local deterministic mode is rule-based. It looks for durable user statements such as preferences, goals, project/workflow statements, settled decisions, and "remember that..." requests. Remember/save request phrases are parsed as instructions: command-only requests produce no memory draft, while requests with a blank-line, colon, dash, or pasted-block payload use the payload as the memory material. Short durable payloads become one pending suggestion; long pasted payloads are split into durable standalone candidates, deduped against approved and pending memories, ranked, and saved as multiple pending suggestions when strong material exists. It avoids greetings, tiny vague messages, temporary statements, commands, and system/debug-like text. It does not inspect assistant responses unless the user explicitly saves the full exchange. In optional Claude API mode the model may additionally return a `MEMORY_SUGGESTION:` line that becomes a save-for-review suggestion, and long remembered payloads may reuse the provider extraction interface over chat-pasted text; provider suggestions that merely repeat a remember/save command phrase are filtered before any draft can be created. All suggestions remain subject to the same human approval boundary.
