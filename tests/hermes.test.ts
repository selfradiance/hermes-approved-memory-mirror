import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveDraft,
  doctor,
  editApprovedMemory,
  exportApprovedMemories,
  initHermes,
  intakeFile,
  intakeText,
  listApprovedMemories,
  listMemoryEvents,
  listPendingDrafts,
  listRetiredMemories,
  reflectOnApprovedMemory,
  rejectDraft,
  retireApprovedMemory,
  retrieveRelevantApprovedMemories,
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
    expect(pendingReport.basisNote).toBe("Reflection is based only on approved local memory.");
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
