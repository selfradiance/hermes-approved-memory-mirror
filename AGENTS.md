# AGENTS.md

## HERmes / ContextCrate Repo Rules

HERmes is the internal name for ContextCrate, a safe local context-pack generator for approved notes and sources. It is not an autonomous agent and must not grow action-taking capabilities without an explicit architecture decision.

## Hard Boundaries

- Keep HERmes local-first and CLI-only for v0.1.
- Do not add a web server, browser automation, MCP, external connectors, schedulers, background daemons, subagents, or network calls.
- Do not add shell execution, generated-code execution, or action-taking tools inside the app.
- Do not write runtime data outside `.hermes/`.
- Do not crawl the filesystem. File intake may read only an explicitly supplied file path.
- Do not write approved context directly from generated or inferred output. Intake creates drafts; approval creates approved context.

## Development Expectations

- Keep code simple, typed, and auditable.
- Prefer deterministic behavior in v0.1.
- Add focused tests for context safety and approval flow changes.
- Approved context is never hard-deleted.
- Any future LLM provider must create drafts or reflection wording only; human approval remains mandatory.
