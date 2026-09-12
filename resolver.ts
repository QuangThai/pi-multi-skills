/**
 * Build a lightweight skill registry from Pi's already-loaded slash commands.
 *
 * Pi has already handled discovery, trust, settings, package filters,
 * validation, and collisions. Registry construction therefore performs no
 * filesystem I/O; skill bodies are read lazily only when invoked.
 */

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { dirname, extname, join } from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  skillMdPath: string;
}

function getSkillName(commandName: string): string | undefined {
  if (!commandName.startsWith("skill:")) return undefined;
  const name = commandName.slice("skill:".length);
  return name || undefined;
}

/**
 * Current Pi versions expose the canonical Markdown file path. The directory
 * fallback keeps compatibility with older/synthetic command providers without
 * touching the filesystem on autocomplete's hot path.
 */
function getSkillPath(sourcePath: string): string {
  return extname(sourcePath).toLowerCase() === ".md"
    ? sourcePath
    : join(sourcePath, "SKILL.md");
}

function skillFromCommand(command: SlashCommandInfo): SkillInfo | undefined {
  if (command.source !== "skill") return undefined;

  const name = getSkillName(command.name);
  const sourcePath = command.sourceInfo?.path;
  if (!name || typeof sourcePath !== "string" || sourcePath.length === 0) {
    return undefined;
  }

  const skillMdPath = getSkillPath(sourcePath);
  return {
    name,
    description: command.description ?? "",
    dir: command.sourceInfo.baseDir ?? dirname(skillMdPath),
    skillMdPath,
  };
}

/** Preserve Pi's command order and keep its first command for duplicate names. */
export function buildSkillRegistry(
  commands: SlashCommandInfo[],
): Map<string, SkillInfo> {
  const registry = new Map<string, SkillInfo>();

  for (const command of commands) {
    const skill = skillFromCommand(command);
    if (skill && !registry.has(skill.name)) {
      registry.set(skill.name, skill);
    }
  }

  return registry;
}

/** Format available skills for the `/skills` command. */
export function formatSkillTable(registry: Map<string, SkillInfo>): string {
  const rows: string[] = [];
  for (const [name, info] of registry) {
    const description = info.description.length > 60
      ? `${info.description.slice(0, 60)}...`
      : info.description;
    rows.push(`  $${name.padEnd(28)} ${description}`);
  }
  return rows.join("\n");
}
