/**
 * Skill-reference expansion shared by the Pi input handler and integration
 * tests. This is the production transformation path, not a test simulation.
 */

import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { parseSkillRefs, replaceSkillRefs, type ParsedRef } from "./parser";
import type { SkillInfo } from "./resolver";

export interface SkillLoadFailure {
  skill: SkillInfo;
  message: string;
}

export interface SkillExpansionResult {
  transformed: boolean;
  text: string;
  loaded: SkillInfo[];
  failures: SkillLoadFailure[];
  bodyCharacters: number;
}

interface SkillData {
  skill: SkillInfo;
  body: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSkill(
  skill: SkillInfo,
): Promise<{ data: SkillData } | { failure: SkillLoadFailure }> {
  try {
    const content = await readFile(skill.skillMdPath, "utf-8");
    return {
      data: {
        skill,
        body: stripFrontmatter(content).trim(),
      },
    };
  } catch (error) {
    return {
      failure: {
        skill,
        message: errorMessage(error),
      },
    };
  }
}

function formatSingleSkill({ skill, body }: SkillData): string {
  return (
    `<skill name="${skill.name}" location="${skill.skillMdPath}">\n` +
    `References are relative to ${skill.dir}.\n\n` +
    `${body}\n` +
    `</skill>`
  );
}

function formatSkillSection({ skill, body }: SkillData): string {
  return (
    `## ${skill.name}\n\n` +
    `Skill file: ${skill.skillMdPath}\n` +
    `References in this section are relative to ${skill.dir}.\n\n` +
    body
  );
}

function formatMergedSkills(skillData: SkillData[]): string {
  const first = skillData[0];
  if (!first) throw new Error("Cannot format an empty skill collection");

  const names = skillData.map(({ skill }) => skill.name).join(", ");
  const sections = skillData.map(formatSkillSection).join("\n\n---\n\n");
  return (
    `<skill name="${names}" location="${first.skill.skillMdPath}">\n` +
    `This invocation combines multiple skills. Each section has its own ` +
    `skill file and relative-reference directory.\n\n` +
    `${sections}\n` +
    `</skill>`
  );
}

function formatSkillBlock(skillData: SkillData[]): string {
  if (skillData.length === 1) {
    const onlySkill = skillData[0];
    if (onlySkill) return formatSingleSkill(onlySkill);
  }
  return formatMergedSkills(skillData);
}

function isEscapedCharacter(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Avoid adding code delimiters inside Markdown metadata or URL/path tokens. */
function isUnsafeMentionContext(reference: ParsedRef, source: string): boolean {
  const lineStart = source.lastIndexOf("\n", reference.index - 1) + 1;
  let squareDepth = 0;
  let linkDestinationDepth = 0;
  let insideAngleBrackets = false;

  for (let cursor = lineStart; cursor < reference.index; cursor += 1) {
    if (isEscapedCharacter(source, cursor)) continue;
    const character = source[cursor];

    if (linkDestinationDepth > 0) {
      if (character === "(") linkDestinationDepth += 1;
      else if (character === ")") linkDestinationDepth -= 1;
      continue;
    }

    if (character === "]" && source[cursor + 1] === "(") {
      if (squareDepth > 0) squareDepth -= 1;
      linkDestinationDepth = 1;
      cursor += 1;
    } else if (character === "[") {
      squareDepth += 1;
    } else if (character === "]" && squareDepth > 0) {
      squareDepth -= 1;
    } else if (character === "<") {
      insideAngleBrackets = true;
    } else if (character === ">") {
      insideAngleBrackets = false;
    }
  }

  const lineEndIndex = source.indexOf("\n", reference.index);
  const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex;
  const closingSquareBracket = source.indexOf("]", reference.index);
  const insideDelimitedSquare = squareDepth > 0 &&
    closingSquareBracket !== -1 &&
    closingSquareBracket < lineEnd;
  const closingAngleBracket = source.indexOf(">", reference.index);
  const insideDelimitedAngle = insideAngleBrackets &&
    closingAngleBracket !== -1 &&
    closingAngleBracket < lineEnd;
  if (insideDelimitedSquare || linkDestinationDepth > 0 || insideDelimitedAngle) {
    return true;
  }

  const linePrefix = source.slice(lineStart, reference.index);
  if (/^ {0,3}\[[^\]\n]+\]:/.test(linePrefix)) return true;

  let tokenStart = reference.index;
  while (tokenStart > lineStart && !/[\s\[\]()<>"']/.test(source[tokenStart - 1] ?? "")) {
    tokenStart -= 1;
  }
  const tokenPrefix = source.slice(tokenStart, reference.index);
  const afterReference = reference.index + reference.raw.length;
  const tokenSuffix = source.slice(afterReference);
  return /[\\/@]/.test(tokenPrefix) ||
    /^[a-z][a-z0-9+.-]*:/i.test(tokenPrefix) ||
    /^[\\/@?#=&]/.test(tokenSuffix) ||
    /^\.[a-z0-9]/i.test(tokenSuffix);
}

/**
 * Inline code uses Pi's theme-aware `mdCode`/accent color. Keep the original
 * mention unchanged where adding backticks could alter existing Markdown.
 */
function formatSkillMention(reference: ParsedRef, source: string): string {
  const afterReference = reference.index + reference.raw.length;
  return source[reference.index - 1] === "`" ||
      source[afterReference] === "`" ||
      isUnsafeMentionContext(reference, source)
    ? reference.raw
    : `\`${reference.raw}\``;
}

/**
 * Expand every installed `$skill-name` reference in a message.
 *
 * - User formatting is preserved byte-for-byte apart from successful
 *   reference substitutions and matching escaped-reference unescaping.
 * - File failures leave that reference untouched.
 * - Multiple skills retain independent relative-reference directories.
 */
export async function expandSkillReferences(
  text: string,
  registry: Map<string, SkillInfo>,
): Promise<SkillExpansionResult> {
  const requested = parseSkillRefs(text, registry)
    .map((ref) => registry.get(ref.name))
    .filter((skill): skill is SkillInfo => skill !== undefined);

  if (requested.length === 0) {
    return {
      transformed: false,
      text,
      loaded: [],
      failures: [],
      bodyCharacters: 0,
    };
  }

  const results = await Promise.all(requested.map(loadSkill));

  const skillData: SkillData[] = [];
  const failures: SkillLoadFailure[] = [];
  for (const result of results) {
    if ("data" in result) skillData.push(result.data);
    else failures.push(result.failure);
  }

  if (skillData.length === 0) {
    return {
      transformed: false,
      text,
      loaded: [],
      failures,
      bodyCharacters: 0,
    };
  }

  const loaded = skillData.map(({ skill }) => skill);
  const userText = replaceSkillRefs(
    text,
    loaded.map((skill) => ({ name: skill.name, marker: formatSkillMention })),
  );
  const skillBlock = formatSkillBlock(skillData);

  return {
    transformed: true,
    text: userText ? `${skillBlock}\n\n${userText}` : skillBlock,
    loaded,
    failures,
    bodyCharacters: skillData.reduce((total, { body }) => total + body.length, 0),
  };
}
