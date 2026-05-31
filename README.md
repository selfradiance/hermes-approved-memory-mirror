# HERmes — Approved Memory Mirror

HERmes v0.1 is a tiny local TypeScript/Node CLI memory mirror for James. It lets you manually add or import notes, review proposed memory drafts, approve or reject them, search approved memory, and generate deterministic reflection output from approved memory.

HERmes stores only human-approved memories. Intake creates drafts. Drafts are not memory.

## What It Is Not

HERmes is not an autonomous agent. It does not act on the outside world, execute tools, run shell commands from the app, crawl files, connect to services, schedule background work, or call an LLM in v0.1.

## Safety Boundaries

- CLI only; no web app.
- SQLite only; runtime data stays under `.hermes/`.
- No external connectors, MCP, browser automation, background daemon, scheduler, subagents, or network calls.
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

v0.1 intentionally does not require Claude, Anthropic, or any other LLM API. The code includes small provider interfaces in `src/llm/types.ts` and a deterministic no-op implementation in `src/llm/noopProvider.ts`.

Claude/Anthropic could be added later for memory proposal wording or reflection wording, but LLM output must never write memory directly. It may create drafts only, and human approval must remain mandatory.
