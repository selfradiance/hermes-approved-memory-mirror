import { createDraftProposalFromText } from "../draftGeneration.js";
import type { MemoryProposalProvider, ReflectionInput, ReflectionProvider } from "./types.js";

const BASIS_NOTE = "Reflection is based only on approved local context." as const;

export class NoopMemoryProposalProvider implements MemoryProposalProvider {
  async propose(input: {
    sourceType: string;
    sourceLabel: string;
    content: string;
  }) {
    return [
      createDraftProposalFromText(input.content, input.sourceType, input.sourceLabel)
    ];
  }
}

export class NoopReflectionProvider implements ReflectionProvider {
  async reflect(input: ReflectionInput) {
    return {
      question: input.question,
      relevantMemoryIds: input.memories.map((memory) => memory.id),
      relevantSnippets: input.memories.map((memory) => ({
        id: memory.id,
        snippet: memory.content.replace(/\s+/g, " ").slice(0, 180)
      })),
      patternSummary:
        input.memories.length === 0
          ? ["No approved local context was supplied to the no-op reflection provider."]
          : [`Approved local context items supplied: ${input.memories.length}.`],
      basisNote: BASIS_NOTE
    };
  }
}

export const noopMemoryProposalProvider = new NoopMemoryProposalProvider();
export const noopReflectionProvider = new NoopReflectionProvider();
