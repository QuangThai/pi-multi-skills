/**
 * multi-skills — Parser
 * 
 * Parses `$skill_name` references from user input text.
 * Supports:
 *   - $skill_name (standalone)
 *   - Multi-skill: "Dùng $skillA và $skillB để làm X"
 *   - Escaped: \$\$ → literal $$
 *   - Nested with punctuation: $skill_name, $skill_name. $skill_name?
 */

/** Regex pattern for $skill_name references */
// Matches $ followed by lowercase letters, digits, and hyphens
// Not preceded by \ (escape) and not part of $$ (literal)
export const SKILL_REF_PATTERN = /(?<!\\)\$([a-z][a-z0-9_-]*)/gi;

export interface ParsedRef {
  raw: string;       // Full match including $, e.g. "$skillA"
  name: string;      // Skill name without $, e.g. "skillA"
  index: number;     // Position in original text
}

/**
 * Parse all $skill_name references from text
 */
export function parseSkillRefs(text: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  SKILL_REF_PATTERN.lastIndex = 0;

  while ((match = SKILL_REF_PATTERN.exec(text)) !== null) {
    // Skip escaped: \$
    if (match.index > 0 && text[match.index - 1] === "\\") continue;

    refs.push({
      raw: match[0],
      name: match[1].toLowerCase(),
      index: match.index,
    });
  }

  // Deduplicate by name while preserving order
  const seen = new Set<string>();
  return refs.filter(ref => {
    if (seen.has(ref.name)) return false;
    seen.add(ref.name);
    return true;
  });
}

/**
 * Replace $skill_name references with [skill: name] markers.
 * Also handles common Korean/Vietnamese/Chinese punctuation that might follow.
 */
export function replaceSkillRefs(
  text: string,
  replacements: Map<string, string>,
): string {
  let result = text;
  for (const [name, marker] of replacements) {
    result = result.replace(
      new RegExp(`(?<!\\\\)\\$${escapeRegex(name)}\\b`, "gi"),
      marker,
    );
  }
  // Clean up any remaining escaped \$ → $
  result = result.replace(/\\\$/g, "$");
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if text contains any $skill references
 */
export function hasSkillRefs(text: string): boolean {
  SKILL_REF_PATTERN.lastIndex = 0;
  return SKILL_REF_PATTERN.test(text);
}
