/**
 * Skill-reference expansion shared by the Pi input handler and integration
 * tests. This is the production transformation path, not a test simulation.
 */

import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { parseSkillRefs, replaceSkillRefs } from "./parser";
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

/**
 * Expand every installed `$skill-name` reference in a message.
 *
 * - User formatting is preserved byte-for-byte apart from successful
 *   reference substitutions and explicit `\$` unescaping.
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
    loaded.map((skill) => ({ name: skill.name, marker: skill.name })),
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
