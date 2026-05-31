import type { DraftProposal, MemoryEntry, ReflectionReport } from "../types.js";

export interface MemoryProposalInput {
  sourceType: string;
  sourceLabel: string;
  content: string;
}

export interface MemoryProposalProvider {
  propose(input: MemoryProposalInput): Promise<DraftProposal[]>;
}

export interface ReflectionInput {
  question: string;
  memories: MemoryEntry[];
}

export interface ReflectionProvider {
  reflect(input: ReflectionInput): Promise<ReflectionReport>;
}
