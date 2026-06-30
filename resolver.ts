/**
 * multi-skills — Skill resolver
 * 
 * Discovers all installed skills from every location pi loads them from:
 *   - Global:  ~/.pi/agent/skills/,  ~/.agents/skills/
 *   - Project: .pi/skills/ (cwd → git root)
 *   - Packages: ~/.pi/agent/npm/<pkg>/skills/, ~/.pi/agent/git/<host>/<path>/skills/
 *   - Settings: user & project settings.json "skills" array
 *
 * Builds a name → { path, description, frontmatter } registry.
 */

import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;               // Absolute path to skill directory
  skilMdPath: string;        // Absolute path to SKILL.md
  content?: string;          // Cached SKILL.md content
  scope: "user" | "project" | "package";
  frontmatter?: Record<string, unknown>;
}

const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
const AGENTS_DIR = join(homedir(), ".agents");

/**
 * Default global skill locations
 */
function globalSkillRoots(): string[] {
  return [
    join(PI_AGENT_DIR, "skills"),
    join(AGENTS_DIR, "skills"),
  ];
}

/**
 * Package skill locations (npm + git packages under ~/.pi/agent/)
 */
function packageSkillRoots(): string[] {
  const roots: string[] = [];
  const npmDir = join(PI_AGENT_DIR, "npm");
  const gitDir = join(PI_AGENT_DIR, "git");

  // npm packages: each package may have skills/ dir or pi.skills in package.json
  // Actual packages are in npm/node_modules/<pkg>/
  const npmModulesDir = join(npmDir, "node_modules");
  if (existsSync(npmModulesDir)) {
    // Scan both @scoped/packages and unscoped packages
    for (const entry of readdirSync(npmModulesDir)) {
      const entryPath = join(npmModulesDir, entry);
      let stat;
      try { stat = statSync(entryPath); } catch { continue; }
      if (!stat.isDirectory()) continue;

      // Handle @scoped packages (e.g. @scope/package)
      if (entry.startsWith("@")) {
        for (const subEntry of readdirSync(entryPath)) {
          const subPath = join(entryPath, subEntry);
          try { if (!statSync(subPath).isDirectory()) continue; } catch { continue; }
          scanPackageForSkills(subPath, roots);
        }
      } else {
        scanPackageForSkills(entryPath, roots);
      }
    }
  }

  // git packages: host/user/repo pattern (variable depth)
  // Common structures:
  //   git/github.com/addyosmani/agent-skills/skills/      ← 3 levels + skills/
  //   git/github.com/user/repo/skills/
  //   git/github.com/addyosmani/agent-skills/package.json  ← pi.skills entry
  if (existsSync(gitDir)) {
    scanGitReposRecursive(gitDir, 0, 3, roots);
  }

  return roots;
}

/**
 * Scan an npm package directory for skills/ subdirectory or pi.skills in package.json
 */
function scanPackageForSkills(pkgPath: string, roots: string[]): void {
  // Check for conventional skills/ directory
  const skillsDir = join(pkgPath, "skills");
  if (existsSync(skillsDir)) {
    roots.push(skillsDir);
  }

  // Check package.json for pi.skills entries
  const pkgJsonPath = join(pkgPath, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      const piSkills = pkgJson.pi?.skills;
      if (Array.isArray(piSkills)) {
        for (const skillEntry of piSkills) {
          const abs = resolve(pkgPath, skillEntry);
          if (existsSync(abs)) {
            roots.push(abs);
          }
        }
      }
    } catch { /* skip invalid package.json */ }
  }
}

/**
 * Recursively scan git package directories up to `maxDepth` levels
 * looking for skills/ subdirectories and package.json pi.skills entries.
 *
 * The git clone structure is: git/<host>/<user>/<repo>/
 * We scan each directory at any depth for skills/ and package.json.
 */
function scanGitReposRecursive(
  dir: string,
  currentDepth: number,
  maxDepth: number,
  roots: string[],
): void {
  if (currentDepth > maxDepth) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Skip .git directories and hidden dirs
    if (entry.startsWith(".")) continue;

    // Check for conventional skills/ directory
    const skillsDir = join(fullPath, "skills");
    if (existsSync(skillsDir)) {
      roots.push(skillsDir);
    }

    // Check package.json for pi.skills entries
    const pkgJsonPath = join(fullPath, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        const piSkills = pkgJson.pi?.skills;
        if (Array.isArray(piSkills)) {
          for (const skillEntry of piSkills) {
            const abs = resolve(fullPath, skillEntry);
            if (existsSync(abs)) {
              roots.push(abs);
            }
          }
        }
      } catch { /* skip */ }
    }

    // Recurse into subdirectories
    scanGitReposRecursive(fullPath, currentDepth + 1, maxDepth, roots);
  }
}

/**
 * Project skill locations: walk up from cwd to git root
 */
function projectSkillRoots(cwd: string): string[] {
  const roots: string[] = [];

  // Walk up looking for .pi/skills/ and .agents/skills/
  let current = resolve(cwd);
  let last = "";
  while (current !== last) {
    // Check .pi/skills
    const piSkills = join(current, ".pi", "skills");
    if (existsSync(piSkills)) {
      roots.push(piSkills);
    }
    // Check .agents/skills
    const agentsSkills = join(current, ".agents", "skills");
    if (existsSync(agentsSkills)) {
      roots.push(agentsSkills);
    }
    last = current;
    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;

    // Stop at git root
    if (existsSync(join(current, ".git"))) break;
  }

  return roots;
}

/**
 * Parse SKILL.md frontmatter (simple YAML parser for the subset used by Agent Skills)
 */
function parseFrontmatter(content: string): { frontmatter?: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return { body: content };

  const yaml = match[1];
  const frontmatter: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const kvMatch = line.match(/^\s*(\w[\w-]*)\s*:\s*(.*?)\s*$/);
    if (kvMatch) {
      let value: unknown = kvMatch[2].trim();
      // Remove surrounding quotes
      if (typeof value === "string") {
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
      }
      frontmatter[kvMatch[1]] = value;
    }
  }

  return { frontmatter, body: content.slice(match[0].length) };
}

/**
 * Scan a skill root directory for individual skills
 * A skill is either:
 *   - A directory containing SKILL.md (standard format)
 *   - A .md file directly in the root (pi-flat format for certain roots)
 */
function scanSkillRoot(root: string, scope: SkillInfo["scope"]): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (!existsSync(root)) return skills;

  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);

    // Skip entries that can't be stat'd (broken symlinks, permission issues)
    let entryStat;
    try {
      entryStat = statSync(fullPath);
    } catch {
      continue;
    }

    // Directory skill: contains SKILL.md
    if (entryStat.isDirectory()) {
      const skilMdPath = join(fullPath, "SKILL.md");
      if (existsSync(skilMdPath)) {
        try {
          const content = readFileSync(skilMdPath, "utf-8");
          const { frontmatter } = parseFrontmatter(content);
          const name = (frontmatter?.name as string) || entry;
          const description = (frontmatter?.description as string) || "";

          // Validate name per Agent Skills spec
          if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) && frontmatter?.name) {
            // Pi allows non-matching names but warns
          }

          skills.push({
            name,
            description,
            dir: fullPath,
            skilMdPath,
            content,
            scope,
            frontmatter,
          });
        } catch { /* skip unreadable skills */ }
      }
    }
    // Flat .md skill (pi style for global roots)
    else if (entry.endsWith(".md") && entry !== "SKILL.md") {
      try {
        const content = readFileSync(fullPath, "utf-8");
        const { frontmatter } = parseFrontmatter(content);
        const name = entry.replace(/\.md$/, "").toLowerCase();
        const description = (frontmatter?.description as string) || "";

        skills.push({
          name,
          description,
          dir: dirname(fullPath),
          skilMdPath: fullPath,
          content,
          scope,
          frontmatter,
        });
      } catch { /* skip */ }
    }
  }

  return skills;
}

/**
 * Build complete skill registry from all locations
 */
export function buildSkillRegistry(cwd?: string): Map<string, SkillInfo> {
  const registry = new Map<string, SkillInfo>();

  // Collect all skill roots
  const roots: Array<{ root: string; scope: SkillInfo["scope"] }> = [
    ...globalSkillRoots().map(r => ({ root: r, scope: "user" as SkillInfo["scope"] })),
    ...packageSkillRoots().map(r => ({ root: r, scope: "package" as SkillInfo["scope"] })),
  ];

  if (cwd) {
    roots.push(
      ...projectSkillRoots(cwd).map(r => ({ root: r, scope: "project" as SkillInfo["scope"] })),
    );
  }

  // Scan each root
  for (const { root, scope } of roots) {
    for (const skill of scanSkillRoot(root, scope)) {
      // Earlier roots win (user > project > package)
      if (!registry.has(skill.name)) {
        registry.set(skill.name, skill);
      }
    }
  }

  return registry;
}

/**
 * Format available skills as a human-readable table for the /skills command
 */
export function formatSkillTable(registry: Map<string, SkillInfo>): string {
  const rows: string[] = [];
  for (const [name, info] of registry) {
    const desc = info.description.length > 60
      ? info.description.slice(0, 60) + "..."
      : info.description;
    rows.push(`  \$${name.padEnd(28)} ${desc}`);
  }
  return rows.join("\n");
}
