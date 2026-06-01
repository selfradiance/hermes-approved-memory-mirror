# Architecture

HERmes v0.2.4 is a local approved-memory mirror with a localhost-only web chat UI, a small SQLite-backed service layer, organic memory suggestions, and an advanced CLI. The browser UI is local-only; it is not an external web app and does not add automation capabilities.

## Components

- `src/cli.ts` defines the Commander CLI.
- `src/chat.ts` contains deterministic chat response, idea mode, organic memory suggestion, and chat persistence logic.
- `src/ui.ts` contains the loopback-only HTTP server and server-rendered local web chat/review UI.
- `src/hermes.ts` contains the memory workflow operations.
- `src/db.ts` owns database path resolution, schema creation, and SQLite access.
- `src/draftGeneration.ts` contains deterministic draft proposal logic.
- `src/format.ts` formats CLI output.
- `src/llm/*` defines future provider interfaces and the no-op provider.

## Data Flow

1. Intake receives explicit text or one explicit file path.
2. Deterministic proposal logic creates pending drafts.
3. Review displays pending drafts.
4. Approval writes an approved memory entry and audit events.
5. Search, reflection, listing, web chat, terminal chat, and export read approved memory only.
6. Chat can produce an organic memory suggestion from deterministic durable-statement rules.
7. Saving a suggestion for review writes a pending draft only.
8. Chat "Save for review" writes the latest exchange as a pending draft only.

Organic memory flow:

```text
chat message -> memory suggestion -> save for review -> approve memory -> approved memory
```

Direct requests such as "remember that..." skip the suggestion card and save the statement for review, not as an approved memory.

## User-Facing Language vs. Internal Storage

As of v0.2.4 the browser UI uses human memory language and hides developer/internal terms. The UI says "memory suggestion", "This seems worth remembering.", "Save for review", "Saved for review", "Review memory suggestions", "Approve memory", and "Dismiss". The default chat page no longer exposes "draft", database paths, or table names.

Underlying storage is unchanged. A memory suggestion saved for review is still persisted as a `pending` row in `memory_drafts`, and approval still writes `memory_entries`. "Save for review" maps to draft creation, "Approve memory" maps to draft approval, and "Dismiss" maps to draft rejection. Internal route paths (`/drafts`, `/drafts/approve`, `/drafts/reject`) and form fields keep their names; only the visible language changed. No LLM/API/provider integration exists yet.

## Local UI Server

`src/ui.ts` starts a Node HTTP server bound to loopback by default at `127.0.0.1:8787`. It refuses non-loopback hosts and rejects non-local/cross-site state-changing requests. The UI ensures the local SQLite schema exists on first request, so normal use does not require an initialization button.

The default page is intentionally chat-first: app name, chat history, message input, HERmes responses, subtle memory sources, organic memory suggestions, save-for-review, add-memory, and review of memory suggestions. Technical diagnostics, database path, table status, approved-memory search, deterministic reflection, and local JSON export live behind `/system`.

The server calls the existing service functions directly and does not introduce LLM/API calls, external connectors, MCP, browser automation, shell execution, scheduler, daemon, subagents, account access, or autonomous actions.

## Storage

Runtime data is stored under `.hermes/`. The default database is `.hermes/hermes.db`; the demo uses `.hermes/demo.db`.

Approved memories are append-only. Corrections should later use `supersedes_id` and tombstone-style behavior rather than silent mutation.

Chat sessions and messages are stored in `chat_sessions` and `chat_messages` in the same local SQLite database. HERmes messages record the approved memory IDs used for that response.

Dismissed organic suggestions are stored in `memory_suggestion_dismissals`, keyed to the local chat session, user message, and deterministic suggestion hash. This prevents the same suggestion from reappearing after the user dismisses or saves it.

The approved-memory invariant is unchanged: only explicit draft approval writes `memory_entries`. Intake, chat save, direct remember requests, organic suggestion save, and generated reflection create drafts or temporary output only.

Memory candidate detection is deterministic in v0.2.4. It looks for durable user statements such as preferences, goals, project/workflow statements, settled decisions, and "remember that..." requests. It avoids greetings, tiny vague messages, temporary statements, commands, and system/debug-like text. It does not inspect HERmes responses unless the user explicitly saves the full exchange.
