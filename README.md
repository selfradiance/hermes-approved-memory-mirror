# HERmes — Approved Memory Mirror

HERmes is a tiny local TypeScript/Node memory mirror for James. It has a CLI and a localhost-only Local Review UI for adding notes, reviewing proposed memory drafts, approving or rejecting them, searching approved memory, and generating deterministic reflection output from approved memory.

HERmes stores only human-approved memories. Intake creates drafts. Drafts are not memory.

## What It Is Not

HERmes is not an autonomous agent. It does not act on the outside world, execute tools, run shell commands from the app, crawl files, connect to services, schedule background work, collect telemetry, or call an LLM.

## Safety Boundaries

- Local CLI plus localhost-only Local Review UI; no public web app or cloud service.
- SQLite only; runtime data stays under `.hermes/`.
- No external connectors, MCP, browser automation, background daemon, scheduler, subagents, telemetry, analytics, or external network calls.
- No email, calendar, contacts, messaging, social, banking, exchange, wallet, GitHub, or YouTube access.
- No shell execution or generated-code execution from the app.
- File intake reads one explicitly supplied file only.
- Approved memories are never hard-deleted.
- LLM output, if added later, must create drafts only. Human approval remains mandatory.

## Install

```bash
npm install
npm run build
```

During development you can run the CLI with:

```bash
npx tsx src/cli.ts doctor
```

After building:

```bash
node dist/cli.js doctor
```

## Local Review UI

To use HERmes without memorizing terminal commands:

```bash
npm install
npm run ui
```

Open the local URL printed in the terminal, usually:

```text
http://127.0.0.1:8787
```

The Local Review UI is local-only and binds to loopback, not `0.0.0.0`. It does not add LLM/API calls, connectors, accounts, telemetry, cloud sync, or autonomous actions.

In the UI:

1. Open the local page.
2. Initialize the local database if needed.
3. Add a note to create a pending draft.
4. Review and approve or reject the draft.
5. Search approved memories or ask a reflection question.
6. Export approved memory JSON locally.

Only approved memories are used for list/search/reflect.

## Core Commands

```bash
npx tsx src/cli.ts init
npx tsx src/cli.ts intake --text "James prefers concise project notes."
npx tsx src/cli.ts intake --file examples/zion-skank-workflow-note.md
npx tsx src/cli.ts review
npx tsx src/cli.ts approve 1
npx tsx src/cli.ts reject 2 --note "Not useful."
npx tsx src/cli.ts list
npx tsx src/cli.ts search "Seedance"
npx tsx src/cli.ts reflect "What video workflow should I reuse for Zion Skank?"
npx tsx src/cli.ts export --json
npx tsx src/cli.ts doctor
```

## Demo

```bash
npm run demo
```

The demo uses `.hermes/demo.db`, imports `examples/zion-skank-workflow-note.md`, approves the first draft, searches for `Seedance`, reflects on the Zion Skank workflow, and exports approved memory to `.hermes/export/memories-export.json`.

Release notes for v0.1.0 are in [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md).

## Data Model

`memory_drafts` stores proposed memories created by intake. Drafts have `pending`, `approved`, or `rejected` status.

`memory_entries` stores approved memory only. Each approved memory has a source, timestamp, category, tags, confidence, status, and audit event. Entries are not hard-deleted.

`memory_events` stores audit events for draft creation, approval, rejection, memory creation, and export.

## Human Approval Flow

1. `intake` creates one or more pending drafts.
2. `review` shows pending drafts.
3. `approve <draft-id>` writes an approved memory entry and audit events.
4. `reject <draft-id>` marks a draft rejected and writes an audit event.
5. `search`, `list`, `reflect`, and `export` use approved memory only.

## Future LLM Provider Interface

HERmes intentionally does not require Claude, Anthropic, OpenAI, Ollama, or any other LLM API. The code includes small provider interfaces in `src/llm/types.ts` and a deterministic no-op implementation in `src/llm/noopProvider.ts`.

Claude/Anthropic could be added later for memory proposal wording or reflection wording, but LLM output must never write memory directly. It may create drafts only, and human approval must remain mandatory.
