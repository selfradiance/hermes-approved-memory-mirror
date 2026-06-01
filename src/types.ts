export type DraftStatus = "pending" | "approved" | "rejected";
export type MemoryStatus = "approved" | "superseded" | "deleted";
export type Confidence = "low" | "medium" | "high";
export type ChatRole = "user" | "hermes";

export interface HermesRuntimeOptions {
  projectRoot?: string;
  dbFileName?: string;
  chatProvider?: ChatProvider;
}

export type ChatProviderId = "deterministic" | "anthropic";

export interface ChatProviderContextMessage {
  role: ChatRole;
  content: string;
}

export interface ChatGenerationInput {
  userMessage: string;
  recentMessages: ChatProviderContextMessage[];
  memories: SearchResult[];
  sourceChunks?: SourceChunkResult[];
}

export interface ChatGenerationResult {
  responseText: string;
  proposedMemoryText?: string;
  mode: "reflection" | "idea";
  ideaCandidates: IdeaCandidate[];
}

export interface SourceMemoryCandidate {
  content: string;
  category: string;
  tags: string[];
  rationale?: string;
  chunkIndexes?: number[];
}

export interface SourceExtractionInput {
  sourceId: number;
  sourceTitle: string;
  chunks: Array<{ chunkIndex: number; content: string }>;
  limit: number;
}

export interface ChatProvider {
  readonly id: ChatProviderId;
  readonly label: string;
  generate(input: ChatGenerationInput): Promise<ChatGenerationResult>;
  extractSourceMemories?(input: SourceExtractionInput): Promise<SourceMemoryCandidate[]>;
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

export interface ChatSession {
  id: number;
  created_at: string;
  updated_at: string;
  title: string | null;
}

export interface ChatMessage {
  id: number;
  session_id: number;
  created_at: string;
  role: ChatRole;
  content: string;
  memory_ids_json: string;
}

export interface MemorySuggestion {
  proposedContent: string;
  suggestedCategory: string;
  suggestedTags: string[];
  sourceType: "chat";
  sourceLabel: string;
  sourceSessionId: number | null;
  sourceMessageId: number | null;
  suggestionKey: string;
}

export interface SearchResult {
  memory: MemoryEntry;
  snippet: string;
}

export type SourceStatus = "active" | "archived";

export interface Source {
  id: number;
  title: string;
  original_filename: string;
  source_type: string;
  imported_at: string;
  content_hash: string;
  size_bytes: number;
  status: SourceStatus;
}

export interface SourceChunk {
  id: number;
  source_id: number;
  chunk_index: number;
  content: string;
  char_count: number;
  created_at: string;
}

export interface SourceSummary extends Source {
  chunk_count: number;
}

export interface SourceChunkResult {
  chunk: SourceChunk;
  sourceTitle: string;
  snippet: string;
}

export interface IdeaCandidate {
  title: string;
  whyItFits: string;
  memoryIds: number[];
  smallestNextArtifact: string;
}

export interface ChatResponse {
  mode: "reflection" | "idea";
  body: string;
  memoriesUsed: SearchResult[];
  ideaCandidates: IdeaCandidate[];
}

export interface ChatTurn {
  session: ChatSession;
  userMessage: ChatMessage;
  hermesMessage: ChatMessage;
  response: ChatResponse;
  memorySuggestion?: MemorySuggestion;
  savedDraft?: MemoryDraft;
  providerId: ChatProviderId;
  providerLabel: string;
  providerError?: string;
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
  chatProviderLabel: string;
}
