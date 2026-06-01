# Architecture

HERmes v0.2.2 is a local approved-memory mirror with a localhost-only web chat UI, a small SQLite-backed service layer, and an advanced CLI. The browser UI is local-only; it is not an external web app and does not add automation capabilities.

## Components

- `src/cli.ts` defines the Commander CLI.
- `src/chat.ts` contains deterministic chat response, idea mode, and chat persistence logic.
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
6. Chat "Save as draft" writes the latest exchange as a pending draft only.

## Local UI Server

`src/ui.ts` starts a Node HTTP server bound to loopback by default at `127.0.0.1:8787`. It refuses non-loopback hosts and rejects non-local/cross-site state-changing requests. The UI ensures the local SQLite schema exists on first request, so normal use does not require an initialization button.

The default page is intentionally chat-first: app name, chat history, message input, HERmes responses, subtle memory sources, save-as-draft, add-memory, and review-drafts. Technical diagnostics, database path, table status, approved-memory search, deterministic reflection, and local JSON export live behind `/system`.

The server calls the existing service functions directly and does not introduce LLM/API calls, external connectors, MCP, browser automation, shell execution, scheduler, daemon, subagents, account access, or autonomous actions.

## Storage

Runtime data is stored under `.hermes/`. The default database is `.hermes/hermes.db`; the demo uses `.hermes/demo.db`.

Approved memories are append-only. Corrections should later use `supersedes_id` and tombstone-style behavior rather than silent mutation.

Chat sessions and messages are stored in `chat_sessions` and `chat_messages` in the same local SQLite database. HERmes messages record the approved memory IDs used for that response.

The approved-memory invariant is unchanged: only explicit draft approval writes `memory_entries`. Intake, chat save, and generated reflection create drafts or temporary output only.
