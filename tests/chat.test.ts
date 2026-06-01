import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createChatResponse,
  listChatMessages,
  listChatSessions,
  saveLatestChatExchangeDraft,
  sendChatMessage
} from "../src/chat.js";
import { createProgram } from "../src/cli.js";
import {
  approveDraft,
  initHermes,
  intakeText,
  listApprovedMemories,
  listPendingDrafts,
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

  it("idea mode returns multiple ideas with memory references", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const memoryId = approveText(
      root,
      "Zion Skank creative workflow uses Seedance shot-by-shot prompts and a small approval note."
    );

    const turn = sendChatMessage("Give me creative sparks for Zion Skank content ideas.", runtime(root));

    expect(turn.response.mode).toBe("idea");
    expect(turn.response.ideaCandidates.length).toBeGreaterThanOrEqual(3);
    expect(turn.response.ideaCandidates.length).toBeLessThanOrEqual(5);
    expect(turn.response.ideaCandidates.every((idea) => idea.memoryIds.includes(memoryId))).toBe(true);
    expect(turn.hermesMessage.content).toContain("Smallest next artifact:");
    expect(turn.hermesMessage.content).toContain(`Inspired by memories: ${memoryId}`);
  });

  it("/save-draft behavior creates a pending draft only", () => {
    const root = makeProject();
    initHermes(runtime(root));
    approveText(root, "Seedance storyboard work benefits from concise approval notes.");
    const turn = sendChatMessage("What does this make you think of for Seedance?", runtime(root));

    const draft = saveLatestChatExchangeDraft(turn.session.id, runtime(root));

    expect(draft.status).toBe("pending");
    expect(draft.source_type).toBe("chat");
    expect(draft.source_label).toBe(`chat_session:${turn.session.id}`);
    expect(listPendingDrafts(runtime(root)).map((pending) => pending.id)).toEqual([draft.id]);
    expect(listApprovedMemories(runtime(root))).toHaveLength(1);
  });

  it("chat never creates approved memory directly", () => {
    const root = makeProject();
    initHermes(runtime(root));
    approveText(root, "Approved memory about quiet project planning.");

    const turn = sendChatMessage("Reflect on quiet project planning.", runtime(root));
    saveLatestChatExchangeDraft(turn.session.id, runtime(root));

    expect(listApprovedMemories(runtime(root))).toHaveLength(1);
    expect(listPendingDrafts(runtime(root))).toHaveLength(1);
  });

  it("persists chat sessions and messages locally", () => {
    const root = makeProject();
    initHermes(runtime(root));
    const memoryId = approveText(root, "Seedance storyboard notes should stay inspectable.");

    const turn = sendChatMessage("Mirror the Seedance storyboard note.", runtime(root));
    const sessions = listChatSessions(runtime(root));
    const messages = listChatMessages(turn.session.id, runtime(root));

    expect(sessions).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.role)).toEqual(["user", "hermes"]);
    expect(messages[0]?.content).toBe("Mirror the Seedance storyboard note.");
    expect(JSON.parse(messages[1]?.memory_ids_json ?? "[]")).toEqual([memoryId]);
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
