/**
 * Parser for `$skill-name` references.
 *
 * References are recognized only outside Markdown fenced/inline code. Escaped
 * dollars (`\$`) remain literal, and callers can filter candidates against the
 * skills that Pi has actually loaded.
 */

/** Agent Skills names are lowercase letters, digits, and hyphens. Underscores
 * remain accepted for backwards compatibility with this extension's original
 * `$skill_name` syntax and Pi's lenient loading behavior. */
const SKILL_NAME_START_RE = /[a-z0-9]/;
const SKILL_NAME_CHAR_RE = /[a-z0-9_-]/;
const TOKEN_CHAR_RE = /[\p{L}\p{N}_-]/u;
const BOUNDARY_BLOCKER_RE = /[\p{L}\p{N}_$]/u;

export interface ParsedRef {
  raw: string;
  name: string;
  index: number;
}

export interface SkillNameLookup {
  has(name: string): boolean;
}

interface EscapedRef extends ParsedRef {
  escapeIndex: number;
}

interface ScanResult {
  refs: ParsedRef[];
  escapedRefs: EscapedRef[];
}

interface Fence {
  character: "`" | "~";
  length: number;
}

function countRepeatedCharacter(text: string, start: number, character: string): number {
  let end = start;
  while (text[end] === character) end += 1;
  return end - start;
}

function precedingBackslashCount(text: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    count += 1;
  }
  return count;
}

function codePointCharacterAt(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointCharacterBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;

  let start = index - 1;
  const trailingCodeUnit = text.charCodeAt(start);
  if (
    trailingCodeUnit >= 0xdc00 &&
    trailingCodeUnit <= 0xdfff &&
    start > 0
  ) {
    const leadingCodeUnit = text.charCodeAt(start - 1);
    if (leadingCodeUnit >= 0xd800 && leadingCodeUnit <= 0xdbff) {
      start -= 1;
    }
  }
  return text.slice(start, index);
}

function scanTextLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  inlineTicks: number,
  result: ScanResult,
): number {
  let cursor = lineStart;

  while (cursor < lineEnd) {
    const character = text[cursor];

    if (
      character === "`" &&
      (inlineTicks > 0 || precedingBackslashCount(text, cursor) % 2 === 0)
    ) {
      const tickCount = countRepeatedCharacter(text, cursor, "`");
      if (inlineTicks === 0) {
        inlineTicks = tickCount;
      } else if (tickCount === inlineTicks) {
        inlineTicks = 0;
      }
      cursor += tickCount;
      continue;
    }

    if (inlineTicks > 0 || character !== "$") {
      cursor += 1;
      continue;
    }

    const backslashCount = precedingBackslashCount(text, cursor);
    const escaped = backslashCount % 2 === 1;
    const previousCharacter = codePointCharacterBefore(text, cursor);
    if (!escaped && previousCharacter && BOUNDARY_BLOCKER_RE.test(previousCharacter)) {
      cursor += 1;
      continue;
    }

    const nameStart = cursor + 1;
    const firstNameCharacter = text[nameStart];
    if (!firstNameCharacter || !SKILL_NAME_START_RE.test(firstNameCharacter)) {
      cursor += 1;
      continue;
    }

    let nameEnd = nameStart + 1;
    while (nameEnd < lineEnd) {
      const nextCharacter = text[nameEnd];
      if (!nextCharacter || !SKILL_NAME_CHAR_RE.test(nextCharacter)) break;
      nameEnd += 1;
    }

    // Reject mixed-case/otherwise identifier-like suffixes instead of parsing a
    // misleading lowercase prefix from `$skillName`.
    const trailingCharacter = codePointCharacterAt(text, nameEnd);
    if (trailingCharacter && TOKEN_CHAR_RE.test(trailingCharacter)) {
      cursor = nameEnd + 1;
      continue;
    }

    const name = text.slice(nameStart, nameEnd);
    const reference = {
      raw: text.slice(cursor, nameEnd),
      name,
      index: cursor,
    };
    if (escaped) {
      result.escapedRefs.push({ ...reference, escapeIndex: cursor - 1 });
    } else {
      result.refs.push(reference);
    }
    cursor = nameEnd;
  }

  return inlineTicks;
}

/** Scan all candidate references while ignoring Markdown code spans and fences. */
function scanSkillRefs(text: string): ScanResult {
  const result: ScanResult = { refs: [], escapedRefs: [] };
  let fence: Fence | undefined;
  let inlineTicks = 0;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const line = text.slice(lineStart, lineEnd);
    const markerMatch = line.match(/^ {0,3}(`+|~+)(.*)$/);
    const marker = markerMatch?.[1];
    const markerCharacter = marker?.[0];
    const markerRemainder = markerMatch?.[2] ?? "";

    if (fence) {
      if (
        marker &&
        markerCharacter === fence.character &&
        marker.length >= fence.length &&
        markerRemainder.trim() === ""
      ) {
        fence = undefined;
      }
    } else if (
      inlineTicks === 0 &&
      marker &&
      (markerCharacter === "`" || markerCharacter === "~") &&
      marker.length >= 3 &&
      !(markerCharacter === "`" && markerRemainder.includes("`"))
    ) {
      fence = { character: markerCharacter, length: marker.length };
    } else {
      inlineTicks = scanTextLine(text, lineStart, lineEnd, inlineTicks, result);
    }

    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }

  return result;
}

/**
 * Parse deduplicated references in first-occurrence order.
 *
 * Passing a lookup makes parsing registry-aware: only skills exposed by Pi are
 * returned, so ordinary `$shell`/`$php` variables remain untouched.
 */
export function parseSkillRefs(text: string, knownSkills?: SkillNameLookup): ParsedRef[] {
  const refs = scanSkillRefs(text).refs;
  const seen = new Set<string>();

  return refs.filter((ref) => {
    if (knownSkills && !knownSkills.has(ref.name)) return false;
    if (seen.has(ref.name)) return false;
    seen.add(ref.name);
    return true;
  });
}

export interface SkillReplacement {
  name: string;
  /** Static replacement or a formatter for context-sensitive occurrences. */
  marker: string | ((reference: ParsedRef, source: string) => string);
}

interface TextEdit {
  start: number;
  end: number;
  value: string;
}

/**
 * Replace known skill references without normalizing any unrelated whitespace.
 * An escaped reference is unescaped only when its skill name also has a
 * replacement, preserving unrelated shell variables, prices, and paths.
 */
export function replaceSkillRefs(
  text: string,
  replacements: SkillReplacement[],
): string {
  if (replacements.length === 0) return text;

  const replacementByName = new Map(
    replacements.map(({ name, marker }) => [name, marker]),
  );
  const scan = scanSkillRefs(text);
  const edits: TextEdit[] = [];

  for (const ref of scan.refs) {
    const marker = replacementByName.get(ref.name);
    if (marker !== undefined) {
      const value = typeof marker === "function" ? marker(ref, text) : marker;
      edits.push({ start: ref.index, end: ref.index + ref.raw.length, value });
    }
  }

  for (const escapedRef of scan.escapedRefs) {
    if (replacementByName.has(escapedRef.name)) {
      edits.push({ start: escapedRef.escapeIndex, end: escapedRef.escapeIndex + 1, value: "" });
    }
  }

  edits.sort((left, right) => right.start - left.start);

  let result = text;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return result;
}

/** Return the partial name after a valid trailing `$` autocomplete trigger. */
export function getSkillCompletionPrefix(textBeforeCursor: string): string | undefined {
  const match = /\$([a-z0-9][a-z0-9_-]*)?$/.exec(textBeforeCursor);
  if (!match) return undefined;

  const partial = match[1] ?? "";
  const probe = partial ? textBeforeCursor : `${textBeforeCursor}a`;
  const expectedName = partial || "a";
  const candidate = scanSkillRefs(probe).refs.find(
    (ref) => ref.index === match.index && ref.name === expectedName,
  );

  return candidate ? partial : undefined;
}
