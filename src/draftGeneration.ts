import type { Confidence, DraftProposal } from "./types.js";

const TAG_PATTERNS: Array<[string, RegExp]> = [
  ["zion-skank", /\bzion[\s-]?skank\b/i],
  ["seedance", /\bseedance\b/i],
  ["omni", /\bomni\b/i],
  ["storyboard", /\bstoryboard\b/i],
  ["action-sheet", /\baction sheet\b/i],
  ["character-reference", /\bcharacter reference\b/i],
  ["workflow", /\bworkflow\b/i],
  ["video", /\bvideo\b/i],
  ["prompt", /\bprompt\b/i],
  ["shot-by-shot", /\bshot[-\s]?by[-\s]?shot\b/i],
  ["consistency", /\bconsisten(?:cy|t)\b/i],
  ["skeleton", /\bskeleton\b/i],
  ["watermark", /\bwatermark\b/i],
  ["logo", /\blogo\b/i],
  ["label", /\blabel\b/i],
  ["text-free", /\bno text\b/i],
  ["preference", /\bprefer(?:s|red|ence)?\b/i],
  ["safety", /\bsafe(?:ty)?\b|\bboundar(?:y|ies)\b|\bmust not\b|\bnever\b/i]
];

const STOPWORDS = new Set([
  "about",
  "again",
  "based",
  "could",
  "from",
  "have",
  "james",
  "memory",
  "note",
  "only",
  "should",
  "that",
  "this",
  "what",
  "when",
  "where",
  "with",
  "workflow"
]);

export function createDraftProposalFromText(
  text: string,
  sourceType: string,
  sourceLabel: string
): DraftProposal {
  const content = normalizeContent(text);
  if (!content) {
    throw new Error("Intake text is empty after trimming.");
  }

  const tags = detectTags(content);

  return {
    source_type: sourceType,
    source_label: sourceLabel,
    proposed_category: detectCategory(content),
    proposed_content: content,
    proposed_tags_json: JSON.stringify(tags),
    proposed_confidence: "medium" satisfies Confidence
  };
}

export function detectCategory(text: string): string {
  if (/\bworkflow\b|\bstoryboard\b|\bshot[-\s]?by[-\s]?shot\b|\bseedance\b|\bvideo\b|\bprompt\b/i.test(text)) {
    return "creative_workflow";
  }
  if (/\bprefer(?:s|red|ence)?\b|\bfavorite\b|\bdefault\b|\broutine\b|\bstyle\b/i.test(text)) {
    return "preference";
  }
  if (/\bsafe(?:ty)?\b|\bboundar(?:y|ies)\b|\bmust not\b|\bnever\b|\bdo not\b/i.test(text)) {
    return "boundary";
  }
  if (/\bproject\b|\bscope\b|\bv0\.?1\b|\barchitecture\b/i.test(text)) {
    return "project_note";
  }
  return "general_note";
}

export function detectTags(text: string): string[] {
  const tags: string[] = [];
  for (const [tag, pattern] of TAG_PATTERNS) {
    if (pattern.test(text) && !tags.includes(tag)) {
      tags.push(tag);
    }
  }

  if (tags.length > 0) {
    return tags.slice(0, 12);
  }

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 5 && !STOPWORDS.has(word));

  return Array.from(new Set(words)).slice(0, 5);
}

function normalizeContent(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}
