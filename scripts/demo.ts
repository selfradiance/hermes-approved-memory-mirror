import fs from "node:fs";
import path from "node:path";
import { runCli } from "../src/cli.js";
import { listPendingDrafts } from "../src/hermes.js";

const projectRoot = process.cwd();
const runtime = { projectRoot, dbFileName: "demo.db" };
const demoDbPath = path.join(projectRoot, ".hermes", "demo.db");
const exportPath = path.join(projectRoot, ".hermes", "export", "memories-export.json");

fs.rmSync(demoDbPath, { force: true });
fs.rmSync(exportPath, { force: true });

await runCli(["init"], runtime);
await runCli(["intake", "--file", "examples/zion-skank-workflow-note.md"], runtime);
await runCli(["review"], runtime);

const firstDraft = listPendingDrafts(runtime)[0];
if (!firstDraft) {
  throw new Error("Demo expected at least one pending draft.");
}

await runCli(["approve", String(firstDraft.id)], runtime);
await runCli(["search", "Seedance"], runtime);
await runCli(["reflect", "What video workflow should I reuse for Zion Skank?"], runtime);
await runCli(["export", "--json"], runtime);
