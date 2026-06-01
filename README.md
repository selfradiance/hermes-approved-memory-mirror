# Approved Mind Mirror

A private memory companion that remembers only what you approve.

Approved Mind Mirror (originally codenamed HERmes) is a private local memory mirror and idea partner. You chat with it in a simple local browser window. As you talk, it may notice something worth remembering and suggest it. Nothing becomes an approved memory until you approve it.

Approved Mind Mirror stores only memories you approve. Chat can suggest memories and save them for review, but a memory suggestion saved for review is not an approved memory until you approve it. The CLI remains available for advanced use.

## Conversation Modes

Approved Mind Mirror has two chat modes, selected by environment variables only. The minimal chat screen shows a subtle label: **Mode: Local** or **Mode: Claude**.

- **Local (default).** Fully offline. No network calls. Chat responses come from a local rule-based engine. This is the mode unless you explicitly opt in to the API.
- **Claude (optional API).** When you set the environment variables below, Approved Mind Mirror sends your chat message, recent chat context, and the retrieved approved memories to the Anthropic Claude API to generate the response wording.

```bash
export HERMES_CHAT_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-...      # read from env only; never stored, logged, or exported
export HERMES_MODEL=claude-sonnet-4-6 # optional; defaults to claude-sonnet-4-6
```

Claude is the first optional API provider. The provider layer is designed so other API/local model providers can be added later (for example OpenAI-compatible endpoints, DeepSeek, Kimi/Moonshot, or a local Ollama model) without changing the UI or memory-approval flow.

Be honest about what API mode means:

- It is **not** fully local. Your chat message, recent chat turns, and the selected approved-memory snippets are sent to Anthropic to produce the reply.
- It still has **no tools**. The model cannot browse, run code, call connectors, or take any action.
- It still **cannot approve memory**. Anything the model proposes becomes a "save for review" suggestion only; human approval through the review flow is the only way a memory is approved.
- If the API key is missing or the call fails, Approved Mind Mirror silently falls back to local deterministic mode and tells you it did so.
- The API key is read from the environment for the single model call. It is never written to SQLite, logged, surfaced in the UI, included in errors, or written to exports.

## What It Is Not

Approved Mind Mirror is not an autonomous agent. It does not act on the outside world, execute tools, run shell commands from the app, crawl files, connect to services, schedule background work, or collect telemetry. In optional Claude API mode it may generate chat text and memory-suggestion wording, but it still takes no actions and cannot approve memory.

## Safety Boundaries

- Local CLI plus localhost-only web UI; no public web app or cloud service.
- SQLite only; runtime data stays under `.hermes/`.
- No external connectors, MCP, browser automation, background daemon, scheduler, subagents, telemetry, or analytics.
- The only optional outbound network call is to the configured Claude API model endpoint for chat text generation, and only when you opt in via environment variables.
- No email, calendar, contacts, messaging, social, banking, exchange, wallet, GitHub, or YouTube access.
- No shell execution or generated-code execution from the app.
- File intake reads one explicitly supplied file only.
- Approved memories are never hard-deleted.
- LLM output creates "save for review" suggestions only. Human approval remains mandatory; the model never writes approved memory.

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

To use Approved Mind Mirror conversationally in a browser:

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

The Local Web Chat UI is local-only and binds to loopback, not `0.0.0.0`. It rejects non-local/cross-site POST requests. It adds no connectors, accounts, telemetry, cloud sync, or autonomous actions. A subtle "Mode:" label shows whether chat is running in Local or Claude mode. The only optional outbound call is the configured Claude API model endpoint, and only when you opt in.

In the UI:

1. Chat with Approved Mind Mirror in the browser.
2. See its responses and the sources from your memory used.
3. Let it suggest a memory when something in chat seems worth remembering.
4. Edit, save for review, or dismiss a memory suggestion.
5. Save the latest exchange for review.
6. Review memory suggestions, then approve a memory or dismiss it.
7. Add a note and save it for review.
8. Open `Diagnostics` (small footer link to `/system`) only when you want diagnostics, search, deterministic reflection, or local JSON export.

Only approved memories are used for chat, search, and reflection. Saving a chat exchange or suggestion only saves it for review; it does not approve a memory.

Approved Mind Mirror sets itself up automatically on first use. Normal chat does not require looking at database paths, table names, or setup diagnostics. If you have no approved memories yet, just start chatting; it will suggest memories when something seems worth saving.

What the UI cannot do:

- No tools, shell execution, browser automation, MCP, connectors, schedulers, daemons, subagents, or account access.
- No autonomous actions.
- No automatic approved-memory writes; the optional Claude API provider can propose memory text but only as a "save for review" suggestion.
- No outbound network calls other than the configured Claude API model endpoint, and only when you opt in via environment variables.
- No filesystem crawl; file intake still reads one explicitly supplied file only.
- No writes outside `.hermes/`, except existing explicit export under `.hermes/export/`.

## Organic Memory Capture

Approved Mind Mirror v0.2.3 notices simple durable statements in chat with deterministic rules. Examples include "I prefer...", "My goal is...", "Going forward...", "I'm working on...", "I decided...", and "What matters to me is...".

When a candidate appears, the UI shows a small card:

```text
This seems worth remembering.
Proposed memory: I prefer project notes that end with one tiny artifact.
Suggested as: preference
From this chat
[Save for review] [Edit] [Dismiss]
```

After you save, Approved Mind Mirror says "Saved for review. Approve it when you’re ready." If you say "remember that...", "save this...", or "add this to memory...", it saves it for review immediately and tells you to approve it when ready. It still does not create an approved memory. Approval remains explicit through the review flow.

Flow:

```text
chat message -> memory suggestion -> save for review -> approve memory -> approved memory
```

In local deterministic mode the detector is local and rule-based. In optional Claude API mode the model may also propose a suggestion. In both modes a suggestion is only saved for review on your action, never browsed for, and never turned into an approved memory without explicit approval.

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

When you ask for ideas, possibilities, directions, creative sparks, project ideas, content ideas, or "what does this make you think of", Approved Mind Mirror switches into idea mode. It returns 3 to 5 deterministic idea candidates, why each fits, which approved memory IDs inspired it, and the smallest next artifact for each idea.

Example:

```text
$ hermes chat
HERmes chat mode: Local. Memory approval is always human-only. Type /help for commands or /exit to leave.
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

What chat does not do (in either mode):

- No tools, shell execution, browser automation, MCP, connectors, schedulers, daemons, subagents, or account access.
- No autonomous actions.
- No automatic approved-memory writes.
- No filesystem crawl; chat uses approved memory already in SQLite.
- No writes outside `.hermes/`; chat sessions and messages are stored in local SQLite tables.
- No outbound network calls in local deterministic mode; in optional Claude API mode the only outbound call is the configured model endpoint for text generation.

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

`chat_sessions` and `chat_messages` store local web and terminal chat history. Assistant messages record the approved memory IDs used for each response.

`memory_suggestion_dismissals` stores local dismissal markers so an ignored organic suggestion does not keep reappearing for the same chat message.

## Human Approval Flow

1. `intake`, chat suggestions, direct "remember that..." requests, and chat save create pending drafts.
2. `review` shows pending drafts.
3. `approve <draft-id>` writes an approved memory entry and audit events.
4. `reject <draft-id>` marks a draft rejected and writes an audit event.
5. Web chat, terminal chat, `search`, `list`, `reflect`, and `export` use approved memory only.

## Chat Provider Interface

Approved Mind Mirror does not require any LLM API to run. Chat goes through a small provider interface (`ChatProvider` in `src/types.ts`):

- `DeterministicChatProvider` (in `src/chat.ts`) is the default. It is fully local and offline.
- `AnthropicChatProvider` (in `src/llm/anthropicChatProvider.ts`) is optional and selected only when `HERMES_CHAT_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are set.

The provider receives only the user message, recent chat context, and retrieved approved memories. It returns response text and an optional proposed memory suggestion. The provider is given no tools. LLM output never writes memory directly: a proposed suggestion can only be saved for review, and human approval through the review flow remains mandatory.
