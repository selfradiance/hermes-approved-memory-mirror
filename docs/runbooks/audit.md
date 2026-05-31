# Audit Runbook

Run these commands from the project root:

```bash
npm install
npm test
npm run typecheck
npm run build
npm run demo
npx tsx src/cli.ts doctor
git status --short
git check-ignore -v HERMES_APPROVED_MEMORY_MIRROR_PROJECT_CONTEXT.md
find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print | sort
```

Expected safety signals:

- Database files are under `.hermes/`.
- Exports are under `.hermes/export/`.
- No runtime writes occur outside `.hermes/`.
- `doctor` reports no external connectors/tools configured.
- The project context file exists locally and is ignored by git.
