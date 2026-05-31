# Decision 001: v0.1 Boundary

## Status

Accepted.

## Decision

HERmes v0.1 is a local TypeScript/Node 20 CLI backed by SQLite. It has no web app, no connectors, no MCP, no browser automation, no background daemon, no scheduler, no action-taking tools, and no LLM requirement.

## Rationale

The core safety property is human-approved local memory. Keeping v0.1 small makes it easier to audit:

- Intake produces drafts, not memory.
- Approval is explicit.
- Approved memory remains local.
- Reflection is deterministic and based only on approved memory.
- The app cannot act on external systems.

SQLite gives a simple durable audit trail without adding a server. The CLI keeps the workflow inspectable and avoids premature interface complexity.

## Future Notes

Optional LLM providers can later help propose drafts or phrase reflections, but provider output must never write memory directly. Human approval remains mandatory.
