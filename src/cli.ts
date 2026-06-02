#!/usr/bin/env node
import { Command, Option } from "commander";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import {
  createChatSession,
  formatMemoriesUsed,
  saveLatestChatExchangeDraft,
  sendChatMessage
} from "./chat.js";
import {
  approveDraft,
  doctor,
  editApprovedMemory,
  exportApprovedMemories,
  exportProjectMemoryPack,
  initHermes,
  intakeFile,
  intakeText,
  listApprovedMemories,
  listPendingDrafts,
  listRetiredMemories,
  reflectOnApprovedMemory,
  rejectDraft,
  retireApprovedMemory,
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
import { chatModeLabel } from "./llm/chatMode.js";
import type { HermesRuntimeOptions } from "./types.js";
import type { ChatTurn } from "./types.js";

export interface CliRuntimeOptions extends HermesRuntimeOptions {
  writeOut?: (message: string) => void;
  writeErr?: (message: string) => void;
  readIn?: Readable;
  readOut?: Writable;
}

export function createProgram(runtime: CliRuntimeOptions = {}): Command {
  const out = (message: string) => (runtime.writeOut ?? process.stdout.write.bind(process.stdout))(`${message}\n`);
  let deprecatedSettledDecisions: string | undefined;

  const program = new Command();
  program
    .name("hermes")
    .description("HERmes approved local memory mirror")
    .version("0.4.10");

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
    .option("--retired", "list retired and superseded memories")
    .action((options: { retired?: boolean }) => {
      out(formatMemories(options.retired ? listRetiredMemories(runtime) : listApprovedMemories(runtime)));
    });

  program
    .command("edit")
    .description("Create an approved correction that supersedes an existing approved memory")
    .argument("<memory-id>", "approved memory id")
    .requiredOption("--text <text>", "replacement memory text")
    .option("--note <note>", "optional correction note")
    .action((memoryId: string, options: { text: string; note?: string }) => {
      const replacement = editApprovedMemory(parseDraftId(memoryId), options.text, {
        ...runtime,
        note: options.note
      });
      out(`Edited memory ${memoryId}; replacement memory ${replacement.id} is now active.`);
    });

  program
    .command("retire")
    .description("Retire an approved memory from normal retrieval")
    .argument("<memory-id>", "approved memory id")
    .option("--reason <reason>", "optional retirement reason")
    .action((memoryId: string, options: { reason?: string }) => {
      retireApprovedMemory(parseDraftId(memoryId), { ...runtime, reason: options.reason });
      out(`Retired memory ${memoryId}.`);
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
    .command("chat")
    .description("Open a local deterministic terminal chat mirror")
    .action(async () => {
      await runChatLoop(runtime);
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
    .command("memory-pack")
    .description("Export selected active approved memories as a Markdown project context packet")
    .requiredOption("--title <title>", "project name/title")
    .option("--query <query>", "select active approved memories matching this query")
    .option("--ids <ids>", "comma-separated active approved memory ids")
    .option("--current-next-step <text>", "optional current next step")
    .option("--settled-decisions <text>", "optional settled decisions or things not to reopen")
    .addOption(
      new Option("--do-not-relitigate <text>", "deprecated alias for --settled-decisions")
        .hideHelp()
        .argParser((value) => {
          deprecatedSettledDecisions = value;
          return value;
        })
    )
    .option("--out <path>", "Markdown output path under .hermes/export")
    .action(
      (options: {
        title: string;
        query?: string;
        ids?: string;
        currentNextStep?: string;
        settledDecisions?: string;
        out?: string;
      }) => {
        if (options.ids && options.query) {
          throw new Error("Use --ids or --query, not both.");
        }
        if (!options.ids && !options.query) {
          throw new Error("Use --query or --ids to select active approved memories.");
        }

        const memoryIds = options.ids
          ? parseMemoryIdList(options.ids)
          : searchApprovedMemories(options.query ?? "", runtime).map(({ memory }) => memory.id);
        if (memoryIds.length === 0) {
          throw new Error("No active approved memories matched the selection.");
        }

        const result = exportProjectMemoryPack(
          {
            title: options.title,
            currentNextStep: options.currentNextStep,
            settledDecisions: options.settledDecisions ?? deprecatedSettledDecisions,
            memoryIds,
            outPath: options.out
          },
          runtime
        );
        out(formatExportPath(result.exportPath));
      }
    );

  program
    .command("doctor")
    .description("Print local database and safety posture diagnostics")
    .action(() => {
      out(formatDoctor(doctor(runtime)));
    });

  return program;
}

async function runChatLoop(runtime: CliRuntimeOptions): Promise<void> {
  const out = (message: string) => (runtime.writeOut ?? process.stdout.write.bind(process.stdout))(`${message}\n`);
  const rl = readline.createInterface({
    input: runtime.readIn ?? process.stdin,
    output: runtime.readOut ?? process.stdout,
    prompt: "you> "
  });
  let session = createChatSession(runtime, "Interactive chat");
  let latestTurn: ChatTurn | undefined;

  out(
    `HERmes chat mode: ${chatModeLabel()}. Memory approval is always human-only. Type /help for commands or /exit to leave.`
  );
  rl.prompt();

  try {
    for await (const inputLine of rl) {
      const line = inputLine.trim();
      if (!line) {
        rl.prompt();
        continue;
      }

      if (line === "/exit" || line === "/quit") {
        out("Goodbye.");
        break;
      }

      if (line === "/help") {
        out(
          [
            "Commands:",
            "/help - show chat commands",
            "/exit - leave chat",
            "/memories - show memories used in the latest response",
            "/save-draft - save the latest user+HERmes exchange as a pending draft"
          ].join("\n")
        );
        rl.prompt();
        continue;
      }

      if (line === "/memories") {
        out(latestTurn ? formatMemoriesUsed(latestTurn.response.memoriesUsed) : "No response has used memories yet.");
        rl.prompt();
        continue;
      }

      if (line === "/save-draft") {
        if (!latestTurn) {
          out("No exchange is available to save yet.");
          rl.prompt();
          continue;
        }
        const draft = saveLatestChatExchangeDraft(session.id, runtime);
        out(`Created pending draft ${draft.id}. Review and approve it separately if it should become memory.`);
        rl.prompt();
        continue;
      }

      latestTurn = await sendChatMessage(line, { ...runtime, sessionId: session.id });
      session = latestTurn.session;
      out(`HERmes:\n${latestTurn.hermesMessage.content}`);
      if (latestTurn.providerError) {
        out(`(Claude API was unavailable, so this reply used local deterministic mode: ${latestTurn.providerError})`);
      }
      if (latestTurn.memoryRequestNeedsPayload) {
        out("Paste the information you want remembered, and I will save it for review.");
      } else if (latestTurn.rememberedPayloadNoSuggestions) {
        out("I did not find any strong standalone memories in that block. Paste a shorter note or phrase one item directly.");
      } else if (latestTurn.savedDrafts && latestTurn.savedDrafts.length > 0) {
        out(`Saved ${latestTurn.savedDrafts.length} memory suggestions for review.`);
      } else if (latestTurn.savedDraft) {
        out("Saved as a draft. Review and approve it before it becomes memory.");
      } else if (latestTurn.memorySuggestion) {
        out(
          [
            "This may be worth remembering:",
            latestTurn.memorySuggestion.proposedContent,
            "Use the local web UI to edit, save, or dismiss this suggestion."
          ].join("\n")
        );
      }
      rl.prompt();
    }
  } finally {
    rl.close();
  }
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

function parseMemoryIdList(value: string): number[] {
  const ids: number[] = [];
  for (const part of value.split(",")) {
    const parsed = Number.parseInt(part.trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("Memory ids must be positive integers.");
    }
    if (!ids.includes(parsed)) {
      ids.push(parsed);
    }
  }
  if (ids.length === 0) {
    throw new Error("At least one memory id is required.");
  }
  return ids;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === invokedPath) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
