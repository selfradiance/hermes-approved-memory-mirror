export type DraftStatus = "pending" | "approved" | "rejected";
export type MemoryStatus = "approved" | "superseded" | "deleted";
export type Confidence = "low" | "medium" | "high";

export interface HermesRuntimeOptions {
  projectRoot?: string;
  dbFileName?: string;
}

export interface HermesPaths {
  projectRoot: string;
  hermesDir: string;
  dbPath: string;
  exportDir: string;
}

export interface DraftProposal {
  source_type: string;
  source_label: string;
  proposed_category: string;
  proposed_content: string;
  proposed_tags_json: string;
  proposed_confidence: Confidence;
}

export interface MemoryDraft extends DraftProposal {
  id: number;
  created_at: string;
  status: DraftStatus;
  review_note: string | null;
}

export interface MemoryEntry {
  id: number;
  created_at: string;
  updated_at: string | null;
  source_type: string;
  source_label: string;
  category: string;
  content: string;
  tags_json: string;
  confidence: Confidence;
  status: MemoryStatus;
  supersedes_id: number | null;
  deleted_at: string | null;
  approval_note: string | null;
}

export interface MemoryEvent {
  event_id: number;
  memory_id: number | null;
  draft_id: number | null;
  event_type: string;
  created_at: string;
  details_json: string;
}

export interface SearchResult {
  memory: MemoryEntry;
  snippet: string;
}

export interface ReflectionReport {
  question: string;
  relevantMemoryIds: number[];
  relevantSnippets: Array<{ id: number; snippet: string }>;
  patternSummary: string[];
  basisNote: "Reflection is based only on approved local memory.";
}

export interface DoctorReport {
  dbPath: string;
  dbExists: boolean;
  tables: Record<string, boolean>;
  pendingDraftCount: number;
  approvedMemoryCount: number;
  externalConnectorsConfigured: false;
  toolsConfigured: false;
}
