# Architecture

HERmes v0.1 is a local CLI wrapped around a small SQLite-backed service layer.

## Components

- `src/cli.ts` defines the Commander CLI.
- `src/hermes.ts` contains the memory workflow operations.
- `src/db.ts` owns database path resolution, schema creation, and SQLite access.
- `src/draftGeneration.ts` contains deterministic v0.1 draft proposal logic.
- `src/format.ts` formats CLI output.
- `src/llm/*` defines future provider interfaces and the v0.1 no-op provider.

## Data Flow

1. Intake receives explicit text or one explicit file path.
2. Deterministic proposal logic creates pending drafts.
3. Review displays pending drafts.
4. Approval writes an approved memory entry and audit events.
5. Search, reflection, listing, and export read approved memory only.

## Storage

Runtime data is stored under `.hermes/`. The default database is `.hermes/hermes.db`; the demo uses `.hermes/demo.db`.

Approved memories are append-only in v0.1. Corrections should later use `supersedes_id` and tombstone-style behavior rather than silent mutation.
