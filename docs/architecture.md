# Architecture

HERmes v0.2 is a local CLI wrapped around a small SQLite-backed service layer. The chat interface is a deterministic terminal mirror, not an agent or automation surface.

## Components

- `src/cli.ts` defines the Commander CLI.
- `src/chat.ts` contains deterministic chat response, idea mode, and chat persistence logic.
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
5. Search, reflection, listing, chat, and export read approved memory only.
6. Chat `/save-draft` writes the latest exchange as a pending draft only.

## Storage

Runtime data is stored under `.hermes/`. The default database is `.hermes/hermes.db`; the demo uses `.hermes/demo.db`.

Approved memories are append-only. Corrections should later use `supersedes_id` and tombstone-style behavior rather than silent mutation.

Chat sessions and messages are stored in `chat_sessions` and `chat_messages` in the same local SQLite database. HERmes messages record the approved memory IDs used for that response.
