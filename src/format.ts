import path from "node:path";
import type {
  DoctorReport,
  MemoryDraft,
  MemoryEntry,
  ReflectionReport,
  SearchResult
} from "./types.js";

export function formatDrafts(drafts: MemoryDraft[]): string {
  if (drafts.length === 0) {
    return "No pending drafts.";
  }

  return [
    `Pending drafts: ${drafts.length}`,
    ...drafts.map((draft) =>
      [
        `[${draft.id}] ${draft.proposed_category}`,
        `tags: ${formatTags(draft.proposed_tags_json)}`,
        `confidence: ${draft.proposed_confidence}`,
        `source: ${draft.source_type} ${draft.source_label}`,
        `content: ${draft.proposed_content}`
      ].join("\n  ")
    )
  ].join("\n\n");
}

export function formatMemories(memories: MemoryEntry[]): string {
  if (memories.length === 0) {
    return "No approved memories.";
  }

  const allActive = memories.every(
    (memory) => memory.status === "approved" && !memory.deleted_at && !memory.retired_at
  );
  return [
    `${allActive ? "Approved memories" : "Memories"}: ${memories.length}`,
    ...memories.map((memory) =>
      [
        `[${memory.id}] ${memory.category}`,
        ...(allActive ? [] : [`status: ${memory.status}`]),
        `created: ${memory.created_at}`,
        ...(memory.retired_at ? [`retired: ${memory.retired_at}`] : []),
        ...(memory.retired_reason ? [`reason: ${memory.retired_reason}`] : []),
        `tags: ${formatTags(memory.tags_json)}`,
        `confidence: ${memory.confidence}`,
        `source: ${memory.source_type} ${memory.source_label}`,
        `content: ${memory.content}`
      ].join("\n  ")
    )
  ].join("\n\n");
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No approved memories matched "${query}".`;
  }

  return [
    `Matches for "${query}": ${results.length}`,
    ...results.map(({ memory, snippet }) => `[${memory.id}] ${memory.category} | ${snippet}`)
  ].join("\n");
}

export function formatReflection(report: ReflectionReport): string {
  return [
    `Question: ${report.question}`,
    `Relevant memory ids: ${report.relevantMemoryIds.length > 0 ? report.relevantMemoryIds.join(", ") : "none"}`,
    "Relevant snippets:",
    ...(report.relevantSnippets.length > 0
      ? report.relevantSnippets.map(({ id, snippet }) => `- [${id}] ${snippet}`)
      : ["- none"]),
    "Pattern summary:",
    ...report.patternSummary.map((line) => `- ${line}`),
    report.basisNote
  ].join("\n");
}

export function formatDoctor(report: DoctorReport): string {
  return [
    `Database path: ${report.dbPath}`,
    `Database exists: ${report.dbExists ? "yes" : "no"}`,
    "Tables:",
    ...Object.entries(report.tables).map(([table, exists]) => `- ${table}: ${exists ? "yes" : "no"}`),
    `Pending drafts: ${report.pendingDraftCount}`,
    `Approved memories: ${report.approvedMemoryCount}`,
    `External connectors/tools configured: ${
      report.externalConnectorsConfigured || report.toolsConfigured ? "yes" : "no"
    }`,
    `Chat provider: ${report.chatProviderLabel}`,
    "HERmes posture: local CLI/local interface only; no connectors, no tools, no MCP, no background daemon. Chat text may use the optional Claude API provider, but it gets no tools and cannot approve memory or take actions."
  ].join("\n");
}

export function formatExportPath(exportPath: string): string {
  return `Export written: ${path.normalize(exportPath)}`;
}

function formatTags(tagsJson: string): string {
  try {
    const tags = JSON.parse(tagsJson);
    if (Array.isArray(tags) && tags.length > 0) {
      return tags.join(", ");
    }
  } catch {
    return "(invalid tags json)";
  }
  return "(none)";
}
