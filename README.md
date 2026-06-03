# ContextCrate

LLM context packs from approved notes and sources.

ContextCrate is a local context generator that turns selected notes, sources, and approved context into copy-paste-ready packs for ChatGPT, Claude, Codex, Gemini, and other LLMs.

Obsidian or other notes can remain your broad memory / second-brain layer. ContextCrate is not trying to replace them. It takes selected material, distills it into context suggestions, keeps only what you explicitly approve, and helps generate clean LLM context packs you can copy, paste, download, save, or hand to coding and writing assistants.

ContextCrate stores only context you approve. Chat and sources can suggest context and save it for review, but a suggestion saved for review is not approved context until you approve it. The CLI remains available for advanced use under the existing `hermes` command.

## Conversation Modes

ContextCrate has two chat modes, selected by environment variables only. The minimal chat screen shows a subtle label: **Mode: Local** or **Mode: Claude**.

- **Local (default).** Fully offline. No network calls. Chat responses come from a local rule-based engine. This is the mode unless you explicitly opt in to the API.
- **Claude (optional API).** When you set the environment variables below, ContextCrate sends your chat message, recent chat context, retrieved approved context, and relevant source excerpts to the Anthropic Claude API to generate response wording.

```bash
export HERMES_CHAT_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-...      # read from env only; never stored, logged, or exported
export HERMES_MODEL=claude-sonnet-4-6 # optional; defaults to claude-sonnet-4-6
```

Claude is the first optional API provider. The provider layer is designed so other API/local model providers can be added later without changing the UI or approval flow.

Be honest about what API mode means:

- It is **not** fully local. Your chat message, recent chat turns, selected approved-context snippets, and relevant source excerpts are sent to Anthropic to produce the reply.
- It still has **no tools**. The model cannot browse, run code, call connectors, or take any action.
- It still **cannot approve context**. Anything the model proposes becomes a "save for review" suggestion only; human approval through the review flow is the only way context is approved.
- If the API key is missing or the call fails, ContextCrate silently falls back to local deterministic mode and tells you it did so.
- The API key is read from the environment for the single model call. It is never written to SQLite, logged, surfaced in the UI, included in errors, or written to exports.

## What It Is Not

ContextCrate is not an autonomous agent. It does not act on the outside world, execute tools, run shell commands from the app, crawl files, connect to services, schedule background work, or collect telemetry. In optional Claude API mode it may generate chat text and context-suggestion wording, but it still takes no actions and cannot approve context.

## Safety Boundaries

- Local CLI plus localhost-only web UI; no public web app or cloud service.
- SQLite only; runtime data stays under `.hermes/`.
- No external connectors, MCP, browser automation, background daemon, scheduler, subagents, telemetry, or analytics.
- The only optional outbound network call is to the configured Claude API model endpoint for chat text generation, and only when you opt in via environment variables.
- No email, calendar, contacts, messaging, social, banking, exchange, wallet, GitHub, or YouTube access.
- No shell execution or generated-code execution from the app.
- File intake reads one explicitly supplied file only.
- Approved context is never hard-deleted.
- LLM output creates "save for review" suggestions only. Human approval remains mandatory; the model never writes approved context.

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

To use ContextCrate conversationally in a browser:

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

1. Chat with ContextCrate in the browser.
2. See its responses, approved context used, and relevant source excerpts.
3. Let it suggest context when something in chat seems useful for future LLM handoffs.
4. Edit, save for review, or dismiss a context suggestion.
5. Save the latest exchange for review.
6. Review context suggestions, then approve context or dismiss it.
7. Add context and save it for review.
8. Open **Manage context** (link in the top navigation, page at `/memories`) to search, edit, or retire your approved context, and to inspect retired/superseded items.
9. Open **LLM context pack** (link in the top navigation, page at `/memory-pack`) to generate selected active approved context as a Markdown pack, copy it from the browser, or download the Markdown.
10. Open `Diagnostics` (small footer link to `/system`) only when you want setup diagnostics, deterministic reflection, or local JSON export.

Only approved context is used for chat, search, and reflection. Saving a chat exchange or suggestion only saves it for review; it does not approve context.

ContextCrate sets itself up automatically on first use. Normal chat does not require looking at database paths, table names, or setup diagnostics. If you have no approved context yet, just start chatting; it will suggest context when something seems worth saving.

What the UI cannot do:

- No tools, shell execution, browser automation, MCP, connectors, schedulers, daemons, subagents, or account access.
- No autonomous actions.
- No automatic approved-context writes; the optional Claude API provider can propose context text but only as a "save for review" suggestion.
- No outbound network calls other than the configured Claude API model endpoint, and only when you opt in via environment variables.
- No filesystem crawl; file intake still reads one explicitly supplied file only.
- No writes outside `.hermes/`; explicit JSON and Markdown exports stay under `.hermes/export/`.

## Organic Context Capture

ContextCrate notices simple durable statements in chat with deterministic rules. Examples include "I prefer...", "My goal is...", "Going forward...", "I'm working on...", "I decided...", and "What matters to me is...".

When a candidate appears, the UI shows a small card:

```text
This seems useful as approved context.
Proposed context: I prefer project notes that end with one tiny artifact.
Suggested as: preference
From this chat
[Save for review] [Edit] [Dismiss]
```

After you save, ContextCrate says "Saved for review. Approve it when you’re ready." If you say "remember that...", "save this...", or "add this to memory..." with actual information attached, it saves the information for review and tells you to approve it when ready. If you only ask "Can you remember this?" without pasting the information, it asks you to paste the payload instead of saving the request phrase. When you paste a longer multi-paragraph or bulleted block after "Can you remember all this?", ContextCrate can split the payload into several context suggestions for review instead of saving one giant note. It still does not create approved context. Approval remains explicit through the review flow.

The direct **Add context** form is meant for short durable notes and preferences. If you paste a long, multi-paragraph, or source-like note there, ContextCrate asks how you want to handle it: split it into context suggestions, import it as a source, or save it as one context item anyway. Any context-shaped result still waits for explicit approval.

Approved context can also be corrected or retired through explicit human action on the **Manage context** page (linked in the top navigation, served at `/memories`). Editing approved context creates a new approved replacement and retires the prior version from normal retrieval; retiring context keeps a local tombstone instead of hard-deleting it. Retired and superseded context is inspectable from the same page (`/memories?retired=1`), but excluded from normal chat retrieval, search, reflection, and JSON export by default. Nothing is ever hard-deleted automatically, and there is no automatic cleanup or staleness detection; edit and retire are explicit human actions only.

(As of v0.4.8 these controls live on the dedicated Manage context page reachable from the main navigation. Earlier they were only reachable through the Diagnostics/System page, which made them hard to find.)

Flow:

```text
chat message -> context suggestion -> save for review -> approve context -> approved context
```

In local deterministic mode the detector is local and rule-based. In optional Claude API mode the model may also propose a suggestion. In both modes a suggestion is only saved for review on your action, never browsed for, and never turned into approved context without explicit approval.

## LLM Context Pack Export

LLM Context Pack Export creates a clean Markdown context pack from selected active approved context. It is designed for Claude Code, Codex, ChatGPT, Claude, Gemini, and similar tools: copy/paste durable project context into a current work order without giving an assistant access to the local store.

In the UI, open **LLM context pack** at `/memory-pack`, search approved context, select the context to include, enter a project name, and optionally add the current next step or **Settled decisions / things not to reopen**. Add decisions that are already settled, so a coding assistant does not waste time suggesting them again. Generating the pack renders the full Markdown directly on the page with **Copy context pack** as the primary action, while **Download Markdown** and the local file under `.hermes/export/` remain secondary.

The pack includes the generated timestamp, a note that it came from human-approved context, project title, optional next-step and settled-decisions sections, selected approved context grouped by project decisions, preferences / working style, creative workflow, cautions / risks, and other, plus a footer that states the pack is not permission to edit files, commit, push, run commands, access accounts, or take external actions.

This feature does not connect to agents, MCP, GitHub, editors, shells, accounts, or external services. It does not write into any repo. It exports active approved context only and grants no action authority. The approval invariant is unchanged: only explicit human approval creates approved context.

## Sources (Markdown / Text Import)

As of v0.4.0 you can import local documents into a **source library**. A source is a raw imported document; approved context is distilled, durable context you have approved. Importing a source does **not** create approved context.

- Supported types: Markdown (`.md`, `.markdown`) and plain text (`.txt`). Other file types are rejected with a friendly message.
- Size limit: about 1 MB of text per file. Larger files are rejected.
- Sources stay local. The file you choose is read in your browser and its text is stored in the same local SQLite database under `.hermes/`. The app never reads arbitrary filesystem paths — only the file you explicitly select.
- Imported text is split into ordered **excerpts** (chunks) so it can be searched and shown in readable pieces.

In the `Sources` page (linked from the chat header) you can:

1. Import a Markdown or text file.
2. See your sources with title, filename, import date, and excerpt count.
3. Rename a source title or delete a raw imported source.
4. Search inside your sources.
5. View a source's excerpts.
6. Use **Suggest context from this source** to create save-for-review items. You choose how many to ask for (1–10, default 7). These are never auto-approved; approval still happens through the review flow, and every suggestion is editable before you approve it. As of v0.4.3 the suggestions you just created appear **inline on the Sources page**, so you can edit, approve, or dismiss each one without leaving Sources.

Deleting a source removes the imported raw source and excerpts. Approved context already created from that source remains approved context, and pending drafts are not cleaned up automatically.

### How source context extraction works (v0.4.2)

Imported sources are raw material, not approved context. **Suggest context from this source** is a **full-source extraction workflow**: it reviews the whole source (every excerpt, in order), not a chat-style top-N retrieval, and turns it into durable, standalone suggestions that you must still approve.

- **Local mode (default):** a deterministic pass keeps complete, standalone sentences that signal durable personal or project context (stable preferences, recurring principles, long-running projects, identity anchors, decision patterns, creative workflows, finance/Bitcoin thesis, training/health patterns, AI/coding principles). It ignores document metadata such as titles, filenames, creation dates, "purpose" lines, and headings (for example "MASTER IDENTITY DOCUMENT"), and drops tiny fragments.
- **Claude API mode (optional):** when `HERMES_CHAT_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are set, Claude proposes higher-quality suggestions from the source text. Small sources are sent in one pass; **large sources are processed in ordered batches (map-reduce): each batch is reviewed, then the candidates are combined, de-duplicated, ranked, and trimmed to the number you asked for.** Claude receives the source excerpts as text only, has no tools, and cannot approve or write context. If the API is unavailable or returns an unusable response, extraction falls back to the deterministic pass.

In both modes, suggestions that simply repeat context you have **already approved or have pending** are skipped, so the workflow does not re-suggest the same things. When fewer strong suggestions than you requested are found, the UI says so honestly (for example, "Reviewed 42 source excerpts. Suggested 4 context suggestions for review. Only 4 strong new suggestions were found.") rather than silently returning a short list.

Either way, suggestions are saved for review only. Only your explicit approval writes approved context. The API key is read from the environment for the single model call and is never stored, logged, rendered, or exported. Setting `HERMES_DEBUG_EXTRACTION` prints counts-only diagnostics (chunk/char totals, batches, requested vs. returned vs. saved, mode) to stderr - never source content or the API key.

When you chat, ContextCrate instead includes only relevant **source excerpts** alongside **approved context** (chat uses retrieval, not full-source extraction). The two are clearly distinguished:

- "Sources from approved context" are approved context entries.
- "Source excerpts" are raw passages from imported documents, shown as secondary/collapsible reference only.

In optional Claude API mode, the model receives your message, recent chat, retrieved approved context, **and** relevant source excerpts. The system prompt instructs it to treat approved context as durable context and source excerpts as raw reference material - never as approved context. The model still has no tools, takes no actions, and cannot approve context.

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
npx tsx src/cli.ts memory-pack --query "Seedance" --title "Seedance packet" --settled-decisions "Keep the export copy/paste only." --out .hermes/export/seedance-pack.md
npx tsx src/cli.ts doctor
```

## v0.2 Conversational Idea Mirror

`hermes chat` opens a simple local terminal chat loop. It uses the same deterministic chat engine as the web UI. The web UI is now the preferred everyday interface.

Inside chat:

```text
/help        show commands
/exit        leave chat
/memories    show memories used in the latest response
/save-draft  save the latest user+ContextCrate exchange as a pending suggestion
```

`/save-draft` never creates approved context. It creates a pending draft with source `chat`, and the existing review/approve flow remains the only way to turn that draft into approved context.

When you ask for ideas, possibilities, directions, creative sparks, project ideas, content ideas, or "what does this make you think of", ContextCrate switches into idea mode. It returns 3 to 5 deterministic idea candidates, why each fits, which approved context IDs inspired it, and the smallest next artifact for each idea.

Example:

```text
$ hermes chat
ContextCrate chat mode: Local. Context approval is always human-only. Type /help for commands or /exit to leave.
you> What does this make you think of for Zion Skank?
ContextCrate:
Here are 3 deterministic idea candidates grounded in approved context.

1. Tiny brief: Zion Skank through Seedance
Why it fits: Memory [1] says Zion Skank uses Seedance shot-by-shot prompts..., giving this idea a known local anchor.
Inspired by memories: 1
Smallest next artifact: a six-line brief with goal, audience, constraint, tone, shape, and open question

Memories used:
- [1] Zion Skank uses Seedance shot-by-shot prompts...
you> /save-draft
Created pending context suggestion 2. Review and approve it separately if it should become approved context.
```

What chat does not do (in either mode):

- No tools, shell execution, browser automation, MCP, connectors, schedulers, daemons, subagents, or account access.
- No autonomous actions.
- No automatic approved-context writes.
- No filesystem crawl; chat uses approved context already in SQLite.
- No writes outside `.hermes/`; chat sessions and messages are stored in local SQLite tables.
- No outbound network calls in local deterministic mode; in optional Claude API mode the only outbound call is the configured model endpoint for text generation.

## Demo

```bash
npm run demo
```

The demo uses `.hermes/demo.db`, imports `examples/zion-skank-workflow-note.md`, approves the first draft, searches for `Seedance`, reflects on the Zion Skank workflow, and exports approved context to `.hermes/export/memories-export.json`.

Release notes for v0.1.0 are in [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md).

## Data Model

`memory_drafts` stores proposed memories created by intake. Drafts have `pending`, `approved`, or `rejected` status.

`memory_entries` stores approved context and retired/superseded context history. Each approved context entry has a source, timestamp, category, tags, confidence, status, and audit event. Entries are not hard-deleted. Edits create a replacement row with `supersedes_id`; the old row is retired from normal use. Retired/superseded entries are excluded from chat, search, reflection, and export by default.

`memory_events` stores audit events for draft creation, approval, rejection, memory creation, memory edit/supersession, retirement, and export.

`chat_sessions` and `chat_messages` store local web and terminal chat history. Assistant messages record the approved context IDs used for each response.

`memory_suggestion_dismissals` stores local dismissal markers so an ignored organic suggestion does not keep reappearing for the same chat message.

`sources` stores imported documents (title, original filename, type, import time, content hash, size, status). `source_chunks` stores the ordered excerpts for each source. Sources are raw imported text and are never treated as approved context; only explicit draft approval writes `memory_entries`. Deleting a source removes the source row and its excerpts, not approved context previously created from it.

## Human Approval Flow

1. `intake`, chat suggestions, direct "remember that..." requests, and chat save create pending drafts.
2. `review` shows pending drafts.
3. `approve <draft-id>` writes an approved context entry and audit events.
4. `reject <draft-id>` marks a draft rejected and writes an audit event.
5. Explicit edit/retire controls can supersede or retire approved context without hard-deleting history.
6. Web chat, terminal chat, `search`, `list`, `reflect`, JSON export, and LLM Context Pack export use active approved context only.

## Chat Provider Interface

ContextCrate does not require any LLM API to run. Chat goes through a small provider interface (`ChatProvider` in `src/types.ts`):

- `DeterministicChatProvider` (in `src/chat.ts`) is the default. It is fully local and offline.
- `AnthropicChatProvider` (in `src/llm/anthropicChatProvider.ts`) is optional and selected only when `HERMES_CHAT_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are set.

The provider receives only the user message, recent chat context, retrieved approved context, and relevant source excerpts. It returns response text and an optional proposed context suggestion. The provider is given no tools. LLM output never writes context directly: a proposed suggestion can only be saved for review, and human approval through the review flow remains mandatory.
