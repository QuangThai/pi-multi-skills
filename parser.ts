/**
 * multi-skills — Parser
 *
 * Parses `$skill_name` references from user input text.
 * Supports:
 *   - $skill_name (standalone)
 *   - Multi-skill: "Dùng $skillA và $skillB để làm X"
 *   - Escaped: \$\ → literal $
 */

/** Regex pattern for $skill_name references */
// Matches $ followed by lowercase letters, digits, and hyphens
// Not preceded by \ (escape)
const SKILL_REF_RE = /(?<!\\)\$([a-z][a-z0-9_-]*)/gi;

export interface ParsedRef {
  raw: string;       // Full match including $, e.g. "$skillA"
  name: string;      // Skill name without $, e.g. "skillA"
  index: number;     // Position in original text
}

/**
 * Escape regex-special characters in a string.
 * Shared utility used by both parser and index.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse all $skill_name references from text.
 * Returns deduplicated list preserving first-occurrence order.
 */
export function parseSkillRefs(text: string): ParsedRef[] {
  const refs: ParsedRef[] = [];

  SKILL_REF_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SKILL_REF_RE.exec(text)) !== null) {
    refs.push({
      raw: match[0],
      name: match[1].toLowerCase(),
      index: match.index,
    });
  }

  // Deduplicate by name while preserving order
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.name)) return false;
    seen.add(ref.name);
    return true;
  });
}

/**
 * Replacement entry for replaceSkillRefs.
 */
export interface SkillReplacement {
  name: string;
  marker: string;
}

/**
 * Replace $skill_name references with markers.
 *
 * Sort by name length descending so longer names (e.g. "code-review")
 * are replaced before shorter ones (e.g. "code") to prevent partial
 * matches.
 */
export function replaceSkillRefs(
  text: string,
  replacements: SkillReplacement[],
): string {
  const sorted = [...replacements].sort(
    (a, b) => b.name.length - a.name.length,
  );

  let result = text;
  for (const { name, marker } of sorted) {
    result = result.replace(
      new RegExp(`(?<!\\\\)\\$${escapeRegex(name)}\\b`, "gi"),
      marker,
    );
  }
  // Clean any remaining escaped \$
  result = result.replace(/\\\$/g, "$");
  return result;
}

/**
 * Quick check whether text contains any $skill references.
 */
export function hasSkillRefs(text: string): boolean {
  SKILL_REF_RE.lastIndex = 0;
  return SKILL_REF_RE.test(text);
}
