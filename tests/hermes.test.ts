import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveDraft,
  doctor,
  editApprovedMemory,
  exportApprovedMemories,
  exportProjectMemoryPack,
  getSavedContextPack,
  initHermes,
  intakeFile,
  intakeText,
  listApprovedMemories,
  listMemoryEvents,
  listPendingDrafts,
  listRetiredMemories,
  listSavedContextPacks,
  reflectOnApprovedMemory,
  rejectDraft,
  retireApprovedMemory,
  retrieveRelevantApprovedMemories,
  saveContextPack,
  searchApprovedMemories
} from "../src/hermes.js";
import type { HermesRuntimeOptions } from "../src/types.js";

const tempRoots: string[] = [];

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-test-"));
  tempRoots.push(root);
  return root;
}

function runtime(root: string): HermesRuntimeOptions {
  return { projectRoot: root };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("HERmes v0.1", () => {
  it("init creates database and tables", () => {
    const root = makeProject();
    const paths = initHermes(runtime(root));
    expect(fs.existsSync(paths.dbPath)).toBe(true);

    const report = doctor(runtime(root));
    expect(report.dbExists).toBe(true);
    expect(report.tables.memory_entries).toBe(true);
    expect(report.tables.memory_drafts).toBe(true);
    expect(report.tables.memory_events).toBe(true);
    expect(report.tables.chat_sessions).toBe(true);
    expect(report.tables.chat_messages).toBe(true);
    expect(report.tables.memory_suggestion_dismissals).toBe(true);
    expect(report.tables.context_packs).toBe(true);
  });

  it("intake creates pending draft, not approved memory", () => {
    const root = makeProject();
    initHermes(runtime(root));

    const drafts = intakeText("James prefers quiet project notes.", runtime(root));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.status).toBe("pending");
    expect(listPendingDrafts(runtime(root))).toHaveLength(1);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("approve moves draft to approved memory and writes events", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Seedance storyboard workflow note.", runtime(root));

    const memory = approveDraft(draft.id, runtime(root));
    const events = listMemoryEvents(runtime(root));

    expect(memory.status).toBe("approved");
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(1);
    expect(events.map((event) => event.event_type)).toContain("memory_created");
    expect(events.map((event) => event.event_type)).toContain("draft_approved");
  });

  it("reject does not create approved memory", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("A draft that should not become memory.", runtime(root));

    rejectDraft(draft.id, { ...runtime(root), note: "Not useful." });

    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
    expect(listMemoryEvents(runtime(root)).map((event) => event.event_type)).toContain("draft_rejected");
  });

  it("search only returns approved memories", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [approvedDraft] = intakeText("Seedance approved workflow.", runtime(root));
    intakeText("Unapproved nebula workflow.", runtime(root));
    approveDraft(approvedDraft.id, runtime(root));

    expect(searchApprovedMemories("Seedance", runtime(root))).toHaveLength(1);
    expect(searchApprovedMemories("nebula", runtime(root))).toHaveLength(0);
  });

  it("reflect only uses approved memories", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [approvedDraft] = intakeText("Zion Skank uses Seedance shot-by-shot prompts.", runtime(root));
    intakeText("Nebula pending-only private draft.", runtime(root));
    approveDraft(approvedDraft.id, runtime(root));

    const approvedReport = reflectOnApprovedMemory("What Seedance workflow should I reuse?", runtime(root));
    const pendingReport = reflectOnApprovedMemory("What about Nebula?", runtime(root));

    expect(approvedReport.relevantMemoryIds).toEqual([1]);
    expect(pendingReport.relevantMemoryIds).toEqual([]);
    expect(pendingReport.basisNote).toBe("Reflection is based only on approved local context.");
  });

  it("export writes JSON under .hermes/export", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Exportable approved memory.", runtime(root));
    approveDraft(draft.id, runtime(root));

    const exportPath = exportApprovedMemories(runtime(root));

    expect(exportPath).toBe(path.join(root, ".hermes", "export", "memories-export.json"));
    expect(fs.existsSync(exportPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(exportPath, "utf8"));
    expect(parsed.approved_memories).toHaveLength(1);
    expect(Array.isArray(parsed.memory_events)).toBe(true);
  });

  it("retiring an approved memory removes it from normal retrieval and keeps it inspectable", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("Amber formatting preference should avoid bracketed citations.", runtime(root));
    const memory = approveDraft(draft.id, runtime(root));

    const retired = retireApprovedMemory(memory.id, { ...runtime(root), reason: "outdated" });
    const events = listMemoryEvents(runtime(root));

    expect(retired.status).toBe("deleted");
    expect(retired.retired_at).toBeTruthy();
    expect(retired.retired_reason).toBe("outdated");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
    expect(searchApprovedMemories("Amber", runtime(root))).toHaveLength(0);
    expect(retrieveRelevantApprovedMemories("bracketed citations", runtime(root))).toHaveLength(0);
    expect(reflectOnApprovedMemory("What about bracketed citations?", runtime(root)).relevantMemoryIds).toEqual([]);
    expect(listRetiredMemories(runtime(root))).toHaveLength(1);
    expect(events.map((event) => event.event_type)).toContain("memory_retired");
  });

  it("editing an approved memory supersedes the old row and uses the replacement normally", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText("James prefers old source review notes.", runtime(root));
    const oldMemory = approveDraft(draft.id, runtime(root));

    const replacement = editApprovedMemory(
      oldMemory.id,
      "James prefers inline source review notes with no bracketed reference formatting.",
      { ...runtime(root), note: "Clarified formatting preference." }
    );
    const active = listApprovedMemories(runtime(root));
    const retired = listRetiredMemories(runtime(root));
    const events = listMemoryEvents(runtime(root));

    expect(replacement.status).toBe("approved");
    expect(replacement.supersedes_id).toBe(oldMemory.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(replacement.id);
    expect(active[0]?.content).toContain("no bracketed reference formatting");
    expect(retired).toHaveLength(1);
    expect(retired[0]?.id).toBe(oldMemory.id);
    expect(retired[0]?.status).toBe("superseded");
    expect(searchApprovedMemories("old source", runtime(root))).toHaveLength(0);
    expect(searchApprovedMemories("bracketed reference", runtime(root))).toHaveLength(1);
    expect(retrieveRelevantApprovedMemories("bracketed reference formatting", runtime(root))[0]?.memory.id).toBe(
      replacement.id
    );
    expect(events.map((event) => event.event_type)).toContain("memory_superseded");
    expect(events.map((event) => event.event_type)).toContain("memory_edited");
  });

  it("export excludes retired and superseded memories by default", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [retireDraft] = intakeText("Retired export memory.", runtime(root));
    const [editDraft] = intakeText("Old export memory.", runtime(root));
    const retiredMemory = approveDraft(retireDraft.id, runtime(root));
    const editedMemory = approveDraft(editDraft.id, runtime(root));
    retireApprovedMemory(retiredMemory.id, runtime(root));
    const replacement = editApprovedMemory(editedMemory.id, "Replacement export memory.", runtime(root));

    const exportPath = exportApprovedMemories(runtime(root));
    const parsed = JSON.parse(fs.readFileSync(exportPath, "utf8"));

    expect(parsed.approved_memories.map((memory: { id: number }) => memory.id)).toEqual([replacement.id]);
    expect(parsed.memory_events.map((event: { event_type: string }) => event.event_type)).toContain("memory_retired");
    expect(parsed.memory_events.map((event: { event_type: string }) => event.event_type)).toContain("memory_superseded");
  });

  it("project context pack export writes selected active approved context as Markdown", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [draft] = intakeText(
      "James decided HERmes project exports should stay copy-paste only for coding assistants.",
      runtime(root)
    );
    const memory = approveDraft(draft.id, runtime(root));

    const result = exportProjectMemoryPack(
      {
        title: "HERmes coding context",
        currentNextStep: "Wire the export through the local UI.",
        settledDecisions: "Do not add MCP, connectors, or agent write access.",
        memoryIds: [memory.id],
        outPath: ".hermes/export/test-pack.md",
        generatedAt: new Date("2026-06-02T15:04:05.000Z")
      },
      runtime(root)
    );

    expect(result.exportPath).toBe(path.join(root, ".hermes", "export", "test-pack.md"));
    expect(fs.existsSync(result.exportPath)).toBe(true);
    const markdown = fs.readFileSync(result.exportPath, "utf8");
    expect(markdown).toContain("# Project Context Pack: HERmes coding context");
    expect(markdown).toContain("Generated: 2026-06-02T15:04:05.000Z");
    expect(markdown).toContain("This context pack was exported from human-approved context.");
    expect(markdown).toContain("Project: HERmes coding context");
    expect(markdown).toContain("Wire the export through the local UI.");
    expect(markdown).toContain("Do not add MCP, connectors, or agent write access.");
    expect(markdown).toContain("## Settled decisions / things not to reopen");
    expect(markdown).toContain(`#### Context ${memory.id}`);
    expect(markdown).toContain(`- Approved context id: ${memory.id}`);
    expect(markdown).toContain("James decided HERmes project exports should stay copy-paste only");
    expect(markdown).toContain(
      "This is context for a coding assistant. It is not permission to edit files, commit, push, run commands, access accounts, or take external actions unless James explicitly says so in the current work order."
    );
  });

  it("project context pack export rejects retired, superseded, and outside output paths", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const [retireDraft] = intakeText("Retired project pack memory.", runtime(root));
    const [editDraft] = intakeText("Old project pack memory.", runtime(root));
    const retiredMemory = approveDraft(retireDraft.id, runtime(root));
    const oldMemory = approveDraft(editDraft.id, runtime(root));
    retireApprovedMemory(retiredMemory.id, runtime(root));
    const replacement = editApprovedMemory(oldMemory.id, "Replacement project pack memory.", runtime(root));

    expect(() =>
      exportProjectMemoryPack({ title: "Bad pack", memoryIds: [retiredMemory.id] }, runtime(root))
    ).toThrow(/Active approved context item/);
    expect(() => exportProjectMemoryPack({ title: "Bad pack", memoryIds: [oldMemory.id] }, runtime(root))).toThrow(
      /Active approved context item/
    );
    expect(() =>
      exportProjectMemoryPack(
        { title: "Bad path", memoryIds: [replacement.id], outPath: "project-memory-pack.md" },
        runtime(root)
      )
    ).toThrow(/under \.hermes\/export/);
    expect(() =>
      exportProjectMemoryPack(
        { title: "Bad extension", memoryIds: [replacement.id], outPath: ".hermes/export/pack.txt" },
        runtime(root)
      )
    ).toThrow(/Markdown \.md/);

    const result = exportProjectMemoryPack({ title: "Good pack", memoryIds: [replacement.id] }, runtime(root));
    expect(path.dirname(result.exportPath)).toBe(path.join(root, ".hermes", "export"));
    expect(path.basename(result.exportPath)).toMatch(/^project-context-pack-\d{8}-\d{6}\.md$/);
    expect(result.markdown).toContain("Replacement project pack memory.");
    expect(result.markdown).not.toContain("Retired project pack memory.");
    expect(result.markdown).not.toContain("Old project pack memory.");
  });

  it("saves generated context packs as export snapshots without creating approved context", () => {
    const root = makeProject();
    initHermes(runtime(root));

    const saved = saveContextPack(
      {
        title: "Reusable handoff pack",
        markdown: "# Reusable handoff pack\n\nApproved context snapshot.",
        exportPath: path.join(root, ".hermes", "export", "reusable-handoff-pack.md"),
        createdAt: new Date("2026-06-03T16:20:00.000Z")
      },
      runtime(root)
    );

    expect(saved.id).toBe(1);
    expect(saved.title).toBe("Reusable handoff pack");
    expect(saved.created_at).toBe("2026-06-03T16:20:00.000Z");
    expect(saved.markdown).toContain("Approved context snapshot.");
    expect(saved.filename).toBe("reusable-handoff-pack.md");
    expect(saved.export_path).toBe(path.join(root, ".hermes", "export", "reusable-handoff-pack.md"));
    expect(listSavedContextPacks(runtime(root))).toHaveLength(1);
    expect(getSavedContextPack(saved.id, runtime(root))?.markdown).toBe(saved.markdown);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listMemoryEvents(runtime(root)).map((event) => event.event_type)).toContain("context_pack_saved");
  });

  it("lists saved context packs newest first", () => {
    const root = makeProject();
    initHermes(runtime(root));
    saveContextPack({ title: "First pack", markdown: "# First" }, runtime(root));
    saveContextPack({ title: "Second pack", markdown: "# Second" }, runtime(root));

    expect(listSavedContextPacks(runtime(root)).map((pack) => pack.title)).toEqual(["Second pack", "First pack"]);
  });

  it("file intake does not crawl directories", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const notesDir = path.join(root, "notes");
    fs.mkdirSync(notesDir);
    fs.writeFileSync(path.join(notesDir, "note.md"), "This file should not be crawled.", "utf8");

    expect(() => intakeFile(notesDir, runtime(root))).toThrow(/Directories are not allowed/);
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
  });

  it("external file intake requires explicit allowance", () => {
    const root = makeProject();
    const externalRoot = makeProject();
    const externalFile = path.join(externalRoot, "external-note.md");
    fs.writeFileSync(externalFile, "External Seedance note.", "utf8");
    initHermes(runtime(root));

    expect(() => intakeFile(externalFile, runtime(root))).toThrow(/requires --allow-external-file/);

    const drafts = intakeFile(externalFile, { ...runtime(root), allowExternalFile: true });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.source_label).toBe(fs.realpathSync(externalFile));
    expect(listPendingDrafts(runtime(root))).toHaveLength(1);
  });

  it("app runtime writes stay under .hermes", () => {
    const root = makeProject();
    const inputPath = path.join(root, "input.md");
    fs.writeFileSync(inputPath, "James prefers Seedance workflow notes.", "utf8");

    initHermes(runtime(root));
    const [draft] = intakeFile("input.md", runtime(root));
    approveDraft(draft.id, runtime(root));
    exportApprovedMemories(runtime(root));

    const files = listFiles(root).map((file) => path.relative(root, file));
    const unexpected = files.filter((file) => file !== "input.md" && !file.startsWith(".hermes/"));

    expect(unexpected).toEqual([]);
  });
});

function listFiles(root: string): string[] {
  const output: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...listFiles(fullPath));
    } else {
      output.push(fullPath);
    }
  }
  return output;
}
