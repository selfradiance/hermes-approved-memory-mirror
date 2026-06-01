# HERmes — Approved Memory Mirror

HERmes is a tiny local TypeScript/Node memory mirror for James. Its primary interface is a localhost-only web chat UI for conversational reflection, idea mirroring, memory draft review, approved-memory search, and JSON export. The CLI remains available for advanced use.

HERmes stores only human-approved memories. Intake creates drafts. Drafts are not memory.

## What It Is Not

HERmes is not an autonomous agent. It does not act on the outside world, execute tools, run shell commands from the app, crawl files, connect to services, schedule background work, collect telemetry, or call an LLM.

## Safety Boundaries

- Local CLI plus localhost-only web UI; no public web app or cloud service.
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

## Local Web Chat UI

To use HERmes conversationally in a browser:

```bash
./scripts/start-local-ui.sh
```

On macOS, you can also double-click:

```text
HERmes.command
```

The launcher builds the app, starts the local UI, prints the URL, and asks macOS to open it. The default local URL is:

```text
http://127.0.0.1:8787
```

During development you can also run:

```bash
npm install
npm run ui
```

The Local Web Chat UI is local-only and binds to loopback, not `0.0.0.0`. It rejects non-local/cross-site POST requests. It does not add LLM/API calls, connectors, accounts, telemetry, cloud sync, or autonomous actions.

In the UI:

1. Chat with HERmes in the browser.
2. See HERmes responses and the approved memories used.
3. Save the latest exchange as a pending draft.
4. Review pending drafts and approve or reject them.
5. Add notes as pending drafts.
6. Open `System` only when you want diagnostics, search, deterministic reflection, or local JSON export.

Only approved memories are used for chat/list/search/reflect. Saving a chat exchange creates a pending draft only; it does not approve memory.

HERmes initializes its local memory store automatically on first use. Normal chat does not require looking at database paths, table names, or setup diagnostics.

What the UI cannot do:

- No LLM/API/provider calls.
- No external network calls.
- No tools, shell execution, browser automation, MCP, connectors, schedulers, daemons, subagents, or account access.
- No autonomous actions.
- No automatic approved-memory writes.
- No filesystem crawl; file intake still reads one explicitly supplied file only.
- No writes outside `.hermes/`, except existing explicit export under `.hermes/export/`.

## Advanced CLI Commands

The terminal chat and CLI commands remain useful for scripting, debugging, and tests:

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
npx tsx src/cli.ts chat
npx tsx src/cli.ts export --json
npx tsx src/cli.ts doctor
```

## v0.2 Conversational Idea Mirror

`hermes chat` opens a simple local terminal chat loop. It uses the same deterministic chat engine as the web UI. The web UI is now the preferred everyday interface.

Inside chat:

```text
/help        show commands
/exit        leave chat
/memories    show memories used in the latest response
/save-draft  save the latest user+HERmes exchange as a pending draft
```

`/save-draft` never creates approved memory. It creates a pending draft with source `chat`, and the existing review/approve flow remains the only way to turn that draft into approved memory.

When you ask for ideas, possibilities, directions, creative sparks, project ideas, content ideas, or "what does this make you think of", HERmes switches into idea mode. It returns 3 to 5 deterministic idea candidates, why each fits, which approved memory IDs inspired it, and the smallest next artifact for each idea.

Example:

```text
$ hermes chat
HERmes chat is local and deterministic. Type /help for commands or /exit to leave.
you> What does this make you think of for Zion Skank?
HERmes:
Here are 3 deterministic idea candidates grounded in approved memory.

1. Tiny brief: Zion Skank through Seedance
Why it fits: Memory [1] says Zion Skank uses Seedance shot-by-shot prompts..., giving this idea a known local anchor.
Inspired by memories: 1
Smallest next artifact: a six-line brief with goal, audience, constraint, tone, shape, and open question

Memories used:
- [1] Zion Skank uses Seedance shot-by-shot prompts...
you> /save-draft
Created pending draft 2. Review and approve it separately if it should become memory.
```

What chat does not do:

- No LLM/API/provider calls.
- No tools, shell execution, browser automation, MCP, connectors, schedulers, daemons, subagents, or account access.
- No autonomous actions.
- No automatic approved-memory writes.
- No filesystem crawl; chat uses approved memory already in SQLite.
- No writes outside `.hermes/`; chat sessions and messages are stored in local SQLite tables.

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

`chat_sessions` and `chat_messages` store local web and terminal chat history. HERmes messages record the approved memory IDs used for each response.

## Human Approval Flow

1. `intake` creates one or more pending drafts.
2. `review` shows pending drafts.
3. `approve <draft-id>` writes an approved memory entry and audit events.
4. `reject <draft-id>` marks a draft rejected and writes an audit event.
5. Web chat, terminal chat, `search`, `list`, `reflect`, and `export` use approved memory only.

## Future LLM Provider Interface

HERmes intentionally does not require Claude, Anthropic, OpenAI, Ollama, or any other LLM API. The code includes small provider interfaces in `src/llm/types.ts` and a deterministic no-op implementation in `src/llm/noopProvider.ts`.

Claude/Anthropic could be added later for memory proposal wording or reflection wording, but LLM output must never write memory directly. It may create drafts only, and human approval must remain mandatory.
