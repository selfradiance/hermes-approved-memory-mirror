import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createChatResponse,
  dismissMemorySuggestion,
  extractMemoryPayloadFromUserMessage,
  getLatestMemorySuggestion,
  listChatMessages,
  listChatSessions,
  saveLatestChatExchangeDraft,
  saveSuggestedMemoryDraft,
  suggestMemoryFromUserMessage,
  sendChatMessage
} from "../src/chat.js";
import { createProgram } from "../src/cli.js";
import {
  approveDraft,
  initHermes,
  intakeText,
  listApprovedMemories,
  listPendingDrafts,
  retireApprovedMemory,
  retrieveRelevantApprovedMemories
} from "../src/hermes.js";
import type { HermesRuntimeOptions, SearchResult } from "../src/types.js";

const tempRoots: string[] = [];

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-test-"));
  tempRoots.push(root);
  return root;
}

function runtime(root: string): HermesRuntimeOptions {
  return { projectRoot: root };
}

function approveText(root: string, text: string): number {
  const [draft] = intakeText(text, runtime(root));
  return approveDraft(draft.id, runtime(root)).id;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("HERmes v0.2 chat", () => {
  it("exposes a chat command", () => {
    const program = createProgram();

    expect(program.commands.some((command) => command.name() === "chat")).toBe(true);
  });

  it("memory-pack CLI exports matching approved memories", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    approveText(root, "CLI memory pack export should stay a Markdown copy-paste packet.");
    const output: string[] = [];
    const program = createProgram({
      ...runtime(root),
      writeOut: (message) => output.push(message)
    });

    await program.parseAsync(
      [
        "memory-pack",
        "--query",
        "CLI memory pack",
        "--title",
        "CLI packet",
        "--settled-decisions",
        "Keep this as a copy-paste export.",
        "--out",
        ".hermes/export/cli-pack.md"
      ],
      { from: "user" }
    );

    const exportPath = path.join(root, ".hermes", "export", "cli-pack.md");
    expect(output.join("\n")).toContain(`Export written: ${exportPath}`);
    expect(fs.readFileSync(exportPath, "utf8")).toContain("# Project Context Pack: CLI packet");
    expect(fs.readFileSync(exportPath, "utf8")).toContain("## Settled decisions / things not to reopen");
    expect(fs.readFileSync(exportPath, "utf8")).toContain("CLI memory pack export should stay");
  });

  it("memory-pack CLI help uses settled-decisions wording", () => {
    const program = createProgram();
    const command = program.commands.find((candidate) => candidate.name() === "memory-pack");

    expect(command?.helpInformation()).toContain("--settled-decisions <text>");
    expect(command?.helpInformation()).toContain("optional settled decisions or things not to reopen");
    expect(command?.helpInformation()).not.toContain(["re", "liti", "gate"].join(""));
  });

  it("retrieves relevant approved memories for chat", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const seedanceId = approveText(root, "Seedance storyboard work should use shot-by-shot prompt notes.");
    approveText(root, "Quiet weekly planning notes should stay concise.");
    intakeText("Pending-only nebula idea should not be retrieved.", runtime(root));

    const results = retrieveRelevantApprovedMemories("What Seedance storyboard ideas fit?", runtime(root));

    expect(results.map(({ memory }) => memory.id)).toEqual([seedanceId]);
    expect(results[0]?.snippet).toContain("Seedance storyboard");
  });

  it("does not retrieve retired memories for chat", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const memoryId = approveText(root, "Cobalt chat memory should not appear after retirement.");
    retireApprovedMemory(memoryId, runtime(root));

    const turn = await sendChatMessage("What about Cobalt chat memory?", runtime(root));

    expect(turn.response.memoriesUsed).toHaveLength(0);
    expect(turn.hermesMessage.content).toContain("Context used:\n- none");
  });

  it("idea mode returns multiple ideas with memory references", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const memoryId = approveText(
      root,
      "Zion Skank creative workflow uses Seedance shot-by-shot prompts and a small approval note."
    );

    const turn = await sendChatMessage("Give me creative sparks for Zion Skank content ideas.", runtime(root));

    expect(turn.response.mode).toBe("idea");
    expect(turn.response.ideaCandidates.length).toBeGreaterThanOrEqual(3);
    expect(turn.response.ideaCandidates.length).toBeLessThanOrEqual(5);
    expect(turn.response.ideaCandidates.every((idea) => idea.memoryIds.includes(memoryId))).toBe(true);
    expect(turn.hermesMessage.content).toContain("Smallest next artifact:");
    expect(turn.hermesMessage.content).toContain(`Inspired by memories: ${memoryId}`);
  });

  it("/save-draft behavior creates a pending draft only", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    approveText(root, "Seedance storyboard work benefits from concise approval notes.");
    const turn = await sendChatMessage("What does this make you think of for Seedance?", runtime(root));

    const draft = saveLatestChatExchangeDraft(turn.session.id, runtime(root));

    expect(draft.status).toBe("pending");
    expect(draft.source_type).toBe("chat");
    expect(draft.source_label).toBe(`chat_session:${turn.session.id}`);
    expect(listPendingDrafts(runtime(root)).map((pending) => pending.id)).toEqual([draft.id]);
    expect(listApprovedMemories(runtime(root))).toHaveLength(1);
  });

  it("chat never creates approved memory directly", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    approveText(root, "Approved memory about quiet project planning.");

    const turn = await sendChatMessage("Reflect on quiet project planning.", runtime(root));
    saveLatestChatExchangeDraft(turn.session.id, runtime(root));

    expect(listApprovedMemories(runtime(root))).toHaveLength(1);
    expect(listPendingDrafts(runtime(root))).toHaveLength(1);
  });

  it("persists chat sessions and messages locally", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const memoryId = approveText(root, "Seedance storyboard notes should stay inspectable.");

    const turn = await sendChatMessage("Mirror the Seedance storyboard note.", runtime(root));
    const sessions = listChatSessions(runtime(root));
    const messages = listChatMessages(turn.session.id, runtime(root));

    expect(sessions).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.role)).toEqual(["user", "hermes"]);
    expect(messages[0]?.content).toBe("Mirror the Seedance storyboard note.");
    expect(JSON.parse(messages[1]?.memory_ids_json ?? "[]")).toEqual([memoryId]);
  });

  it("suggests a draft for durable user statements", () => {
    const suggestion = suggestMemoryFromUserMessage(
      "I prefer quiet project planning notes that end with one smallest next artifact."
    );

    expect(suggestion?.proposedContent).toContain("I prefer quiet project planning notes");
    expect(suggestion?.suggestedCategory).toBe("preference");
    expect(suggestion?.suggestionKey).toMatch(/^[a-f0-9]{16}$/);
  });

  it("does not suggest memory for vague or temporary messages", () => {
    expect(suggestMemoryFromUserMessage("hello")).toBeUndefined();
    expect(suggestMemoryFromUserMessage("I want pizza tonight.")).toBeUndefined();
    expect(suggestMemoryFromUserMessage("/save-draft")).toBeUndefined();
  });

  it("direct remember requests create pending drafts only", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const turn = await sendChatMessage(
      "remember that I prefer deterministic memory mirrors over automation agents.",
      runtime(root)
    );
    const drafts = listPendingDrafts(runtime(root));

    expect(turn.savedDraft?.status).toBe("pending");
    expect(turn.savedDraft?.source_label).toBe(`chat_session:${turn.session.id}:message:${turn.userMessage.id}`);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.proposed_content).toBe("James prefers deterministic memory mirrors over automation agents.");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("command-only remember requests do not create pending drafts", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const turn = await sendChatMessage("Can you remember this?", runtime(root));

    expect(turn.memoryRequestNeedsPayload).toBe(true);
    expect(turn.memorySuggestion).toBeUndefined();
    expect(turn.savedDraft).toBeUndefined();
    expect(listPendingDrafts(runtime(root))).toHaveLength(0);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("extracts blank-line remember payloads instead of the command phrase", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const turn = await sendChatMessage(
      [
        "Can you remember this?",
        "",
        "I prefer inline source suggestions because jumping between pages is annoying."
      ].join("\n"),
      runtime(root)
    );
    const drafts = listPendingDrafts(runtime(root));

    expect(extractMemoryPayloadFromUserMessage(turn.userMessage.content)).toEqual({
      kind: "payload",
      payload: "James prefers inline source suggestions because jumping between pages is annoying."
    });
    expect(turn.savedDraft?.status).toBe("pending");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.proposed_content).toContain("inline source suggestions");
    expect(drafts[0]?.proposed_content).not.toContain("Can you remember this");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("extracts inline question remember payloads", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    await sendChatMessage("Can you remember this? I prefer inline source suggestions.", runtime(root));
    const drafts = listPendingDrafts(runtime(root));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.proposed_content).toBe("James prefers inline source suggestions.");
    expect(drafts[0]?.proposed_content).not.toContain("Can you remember this");
  });

  it("extracts colon remember payloads", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    await sendChatMessage(
      "Please remember this: I prefer to review source suggestions inline.",
      runtime(root)
    );
    const [draft] = listPendingDrafts(runtime(root));

    expect(draft?.proposed_content).toBe("James prefers to review source suggestions inline.");
    expect(draft?.proposed_content).not.toContain("Please remember this");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("extracts multiple suggestions from long multi-paragraph remember-it-all payloads", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const payload = [
      "I prefer source suggestions to appear inline because jumping between pages is annoying.",
      "",
      "Project source review should keep newly suggested memories directly under the source result notice.",
      "",
      "Use the source extraction workflow for imported files, but use chat-local extraction for pasted remember-this blocks.",
      "",
      "The memory review flow should avoid one giant memory when the pasted block contains several durable points."
    ].join("\n");
    const turn = await sendChatMessage(
      [
        "Can you remember it all?",
        "",
        payload
      ].join("\n"),
      runtime(root)
    );
    const drafts = listPendingDrafts(runtime(root));

    expect(turn.savedDrafts?.length).toBeGreaterThan(1);
    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts.map((draft) => draft.proposed_content).join("\n")).toContain("source suggestions");
    expect(drafts.map((draft) => draft.proposed_content).join("\n")).toContain("source extraction workflow");
    expect(drafts.every((draft) => !draft.proposed_content.includes("Can you remember it all"))).toBe(true);
    expect(drafts.every((draft) => draft.proposed_content.length < payload.length)).toBe(true);
    expect(drafts.every((draft) => draft.status === "pending")).toBe(true);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("extracts useful suggestions from long bullet-list remember payloads", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    await sendChatMessage(
      [
        "Please remember this:",
        "- I prefer inline source suggestions because jumping between pages is annoying.",
        "- Project Source Review should avoid hiding new memory suggestions on a different page.",
        "- Use the source extraction workflow for imported files and chat-local extraction for pasted notes."
      ].join("\n"),
      runtime(root)
    );
    const drafts = listPendingDrafts(runtime(root));

    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts.map((draft) => draft.proposed_content).join("\n")).toContain("inline source suggestions");
    expect(drafts.map((draft) => draft.proposed_content).join("\n")).toContain("Project Source Review");
    expect(drafts.every((draft) => !draft.proposed_content.includes("Please remember this"))).toBe(true);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("saved organic suggestions remain pending until explicit approval", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const turn = await sendChatMessage(
      "My goal is to make HERmes feel like a natural conversation partner before adding intelligence.",
      runtime(root)
    );

    expect(turn.memorySuggestion).toBeDefined();
    const draft = saveSuggestedMemoryDraft(
      {
        proposedContent: "My goal is to make HERmes feel conversational before adding intelligence.",
        sourceSessionId: turn.session.id,
        sourceMessageId: turn.userMessage.id,
        suggestionKey: turn.memorySuggestion?.suggestionKey ?? ""
      },
      runtime(root)
    );

    expect(draft.status).toBe("pending");
    expect(draft.source_type).toBe("chat");
    expect(draft.source_label).toBe(`chat_session:${turn.session.id}:message:${turn.userMessage.id}`);
    expect(listPendingDrafts(runtime(root))).toHaveLength(1);
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
  });

  it("dismissed suggestions do not reappear for the same message", async () => {
    const root = makeProject();
    initHermes(runtime(root));
    const turn = await sendChatMessage(
      "Going forward, HERmes should suggest memory lightly without interrupting chat.",
      runtime(root)
    );
    const suggestion = getLatestMemorySuggestion(turn.session.id, runtime(root));

    expect(suggestion).toBeDefined();
    dismissMemorySuggestion(
      turn.session.id,
      turn.userMessage.id,
      suggestion?.suggestionKey ?? "",
      runtime(root)
    );

    expect(getLatestMemorySuggestion(turn.session.id, runtime(root))).toBeUndefined();
  });

  it("chat still works with zero approved memories", async () => {
    const root = makeProject();
    initHermes(runtime(root));

    const turn = await sendChatMessage("What does this make you think of for a tiny local app?", runtime(root));

    expect(turn.response.mode).toBe("idea");
    expect(turn.response.memoriesUsed).toHaveLength(0);
    expect(turn.hermesMessage.content).toContain("these ideas come only from your current message");
    expect(listApprovedMemories(runtime(root))).toHaveLength(0);
    expect(listChatMessages(turn.session.id, runtime(root))).toHaveLength(2);
  });

  it("can generate a deterministic response without persistence", () => {
    const memory = {
      memory: {
        id: 7,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: null,
        source_type: "manual_text",
        source_label: "test",
        category: "creative_workflow",
        content: "Use tiny storyboard artifacts.",
        tags_json: JSON.stringify(["storyboard"]),
        confidence: "medium",
        status: "approved",
        supersedes_id: null,
        deleted_at: null,
        retired_at: null,
        retired_reason: null,
        approval_note: null
      },
      snippet: "Use tiny storyboard artifacts."
    } satisfies SearchResult;

    const response = createChatResponse("What ideas does this make you think of?", [memory]);

    expect(response.mode).toBe("idea");
    expect(response.ideaCandidates).toHaveLength(3);
    expect(response.ideaCandidates[0]?.memoryIds).toEqual([7]);
  });
});
