#!/usr/bin/env node
import { Command } from "commander";
import { pathToFileURL } from "node:url";
import {
  approveDraft,
  doctor,
  exportApprovedMemories,
  initHermes,
  intakeFile,
  intakeText,
  listApprovedMemories,
  listPendingDrafts,
  reflectOnApprovedMemory,
  rejectDraft,
  searchApprovedMemories
} from "./hermes.js";
import {
  formatDoctor,
  formatDrafts,
  formatExportPath,
  formatMemories,
  formatReflection,
  formatSearchResults
} from "./format.js";
import type { HermesRuntimeOptions } from "./types.js";

export interface CliRuntimeOptions extends HermesRuntimeOptions {
  writeOut?: (message: string) => void;
  writeErr?: (message: string) => void;
}

export function createProgram(runtime: CliRuntimeOptions = {}): Command {
  const out = (message: string) => (runtime.writeOut ?? process.stdout.write.bind(process.stdout))(`${message}\n`);

  const program = new Command();
  program
    .name("hermes")
    .description("HERmes approved local memory mirror")
    .version("0.1.0");

  program
    .command("init")
    .description("Create .hermes/hermes.db and required tables")
    .action(() => {
      const paths = initHermes(runtime);
      out(`Initialized HERmes database: ${paths.dbPath}`);
    });

  program
    .command("intake")
    .description("Create pending memory drafts from text or one explicit file")
    .option("--text <text>", "text to intake")
    .option("--file <path>", "one explicit file path to intake")
    .option("--allow-external-file", "allow reading one explicitly supplied file outside the project")
    .action((options: { text?: string; file?: string; allowExternalFile?: boolean }) => {
      if ((options.text && options.file) || (!options.text && !options.file)) {
        throw new Error('Use exactly one of --text "..." or --file <path>.');
      }

      const drafts = options.text
        ? intakeText(options.text, runtime)
        : intakeFile(options.file ?? "", { ...runtime, allowExternalFile: Boolean(options.allowExternalFile) });

      out(`Created pending draft(s): ${drafts.map((draft) => draft.id).join(", ")}`);
    });

  program
    .command("review")
    .description("List pending drafts")
    .action(() => {
      out(formatDrafts(listPendingDrafts(runtime)));
    });

  program
    .command("approve")
    .description("Approve a pending draft into memory")
    .argument("<draft-id>", "pending draft id")
    .option("--note <note>", "optional approval note")
    .action((draftId: string, options: { note?: string }) => {
      const memory = approveDraft(parseDraftId(draftId), { ...runtime, approvalNote: options.note });
      out(`Approved draft ${draftId} as memory ${memory.id}.`);
    });

  program
    .command("reject")
    .description("Reject a pending draft")
    .argument("<draft-id>", "pending draft id")
    .option("--note <note>", "optional rejection note")
    .action((draftId: string, options: { note?: string }) => {
      rejectDraft(parseDraftId(draftId), { ...runtime, note: options.note });
      out(`Rejected draft ${draftId}.`);
    });

  program
    .command("list")
    .description("List approved memory entries")
    .action(() => {
      out(formatMemories(listApprovedMemories(runtime)));
    });

  program
    .command("search")
    .description("Search approved memory")
    .argument("<query>", "query text")
    .action((query: string) => {
      out(formatSearchResults(query, searchApprovedMemories(query, runtime)));
    });

  program
    .command("reflect")
    .description("Create a deterministic reflection from approved memory")
    .argument("<question>", "reflection question")
    .action((question: string) => {
      out(formatReflection(reflectOnApprovedMemory(question, runtime)));
    });

  program
    .command("export")
    .description("Export approved memories and events")
    .option("--json", "write JSON export")
    .action((options: { json?: boolean }) => {
      if (!options.json) {
        throw new Error("Only --json export is supported in v0.1.");
      }
      out(formatExportPath(exportApprovedMemories(runtime)));
    });

  program
    .command("doctor")
    .description("Print local database and safety posture diagnostics")
    .action(() => {
      out(formatDoctor(doctor(runtime)));
    });

  return program;
}

export async function runCli(argv: string[] = process.argv.slice(2), runtime: CliRuntimeOptions = {}): Promise<void> {
  const program = createProgram(runtime);
  await program.parseAsync(argv, { from: "user" });
}

function parseDraftId(value: string): number {
  const draftId = Number.parseInt(value, 10);
  if (!Number.isInteger(draftId) || draftId <= 0) {
    throw new Error("Draft id must be a positive integer.");
  }
  return draftId;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === invokedPath) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
