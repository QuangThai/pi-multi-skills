/**
 * multi-skills — Multi-skill invocation for pi coding agent
 * 
 * Allows users to reference any installed skill from anywhere in their prompt
 * using $skill_name syntax:
 * 
 *   "Vui lòng sử dụng $code-review và $ui-ux-pro-max để review UI này"
 * 
 * The extension:
 *   1. Inline autocomplete: gõ $ + Tab để xem/xuất skill name
 *   2. Parses $skill_name references from user input (input event)
 *   3. Resolves skill paths from all locations (global, project, packages)
 *   4. Reads SKILL.md content and auto-injects into system prompt
 *   5. Provides `/skills` and `/skills-search` commands
 * 
 * Install: Place in ~/.pi/agent/extensions/multi-skills/index.ts
 * Usage:   /reload  then type  "Dùng $skillName để làm X"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSkillRegistry, formatSkillTable, type SkillInfo } from "./resolver";
import { parseSkillRefs } from "./parser";

// ── In-memory state ──────────────────────────────────────────────
let skillRegistry: Map<string, SkillInfo> | null = null;
let pendingSkills: SkillInfo[] = [];
let skillsInjectedThisTurn = false;

// ── Extension entry ──────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // ── 0. Module-level: rebuild registry on reload ───────────────
  pi.on("session_start", async (_event, ctx) => {
    skillRegistry = buildSkillRegistry(ctx.cwd);
    pendingSkills = [];
    skillsInjectedThisTurn = false;

    // ── Register $ autocomplete provider ───────────────────────
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["$"],

      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);

        // Match $ followed by partial skill name at cursor position
        // Allow: text $skill, text$skill (no space), start of line $skill
        const match = beforeCursor.match(
          /(?:^|[^\\])\$([a-z0-9_-]*)$/i,
        );
        if (!match) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const partial = (match[1] ?? "").toLowerCase();
        const registry = skillRegistry;

        if (!registry || registry.size === 0) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        // Filter skills by partial name match
        const items = [];
        for (const [name, info] of registry) {
          if (name.startsWith(partial) || name.includes(partial)) {
            const desc = info.description.length > 80
              ? info.description.slice(0, 80) + "..."
              : info.description;
            items.push({
              value: `$${name}`,
              label: `$${name}`,
              description: desc,
            });
          }
        }

        if (items.length === 0) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        return {
          prefix: `$${partial}`,
          items,
        };
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  // ── 1. Register /skills command (list available skills) ───────
  pi.registerCommand("skills", {
    description: "List all available skills with their $name syntax",
    handler: async (_args, ctx) => {
      const registry = skillRegistry ?? buildSkillRegistry(ctx.cwd);
      if (!registry || registry.size === 0) {
        ctx.ui.notify("No skills found.", "warning");
        return;
      }

      const table = formatSkillTable(registry);
      ctx.ui.notify(
        `Available skills (${registry.size} total):\n\n${table}`,
        "info",
      );
    },
  });

  // ── 2. Register /skills-search command ────────────────────────
  pi.registerCommand("skills-search", {
    description: "Search skills by keyword",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /skills-search <keyword>", "warning");
        return;
      }

      const registry = skillRegistry ?? buildSkillRegistry(ctx.cwd);
      const keyword = args.toLowerCase();
      const matches: string[] = [];

      for (const [name, info] of registry) {
        if (
          name.includes(keyword) ||
          info.description.toLowerCase().includes(keyword)
        ) {
          const desc = info.description.length > 60
            ? info.description.slice(0, 60) + "..."
            : info.description;
          matches.push(`  \$${name.padEnd(28)} ${desc}`);
        }
      }

      if (matches.length === 0) {
        ctx.ui.notify(`No skills matching "${args}"`, "warning");
      } else {
        ctx.ui.notify(
          `Skills matching "${args}" (${matches.length}):\n\n${matches.join("\n")}`,
          "info",
        );
      }
    },
  });

  // ── 3. Intercept user input, parse $skill_name references ─────
  pi.on("input", async (event, ctx) => {
    // Skip if no $refs or empty text
    if (!event.text || !event.text.includes("$")) {
      return { action: "continue" };
    }

    const refs = parseSkillRefs(event.text);
    if (refs.length === 0) {
      return { action: "continue" };
    }

    // Build registry if not yet done
    const registry = skillRegistry ?? buildSkillRegistry(ctx.cwd);
    skillRegistry = registry;

    // Resolve each referenced skill
    const resolved: SkillInfo[] = [];
    const unresolved: string[] = [];

    for (const ref of refs) {
      const skill = registry.get(ref.name);
      if (skill) {
        resolved.push(skill);
      } else {
        unresolved.push(ref.name);
      }
    }

    if (resolved.length === 0) {
      // No skills found — warn and continue
      if (unresolved.length > 0) {
        ctx.ui.notify(
          `Unknown skills: ${unresolved.join(", ")}. Use /skills to see available skills.`,
          "warning",
        );
      }
      return { action: "continue" };
    }

    // Notify about unresolved skills
    if (unresolved.length > 0) {
      ctx.ui.notify(
        `Unknown skills: ${unresolved.join(", ")}. They will be skipped.`,
        "warning",
      );
    }

    // Store pending skills for injection in before_agent_start
    pendingSkills = resolved;
    skillsInjectedThisTurn = false;

    // Notify user
    const names = resolved.map(s => `$${s.name}`).join(", ");
    ctx.ui.notify(
      `Loading skills: ${names}`,
      "info",
    );

    // Transform: replace $skill_name → [skill: name] markers
    // CRITICAL: sort by name length descending so longer names (e.g. 'code-review')
    // are replaced before shorter ones (e.g. 'code') to prevent partial matches.
    const sorted = [...resolved].sort((a, b) => b.name.length - a.name.length);
    let transformed = event.text;
    for (const skill of sorted) {
      const marker = `[skill: ${skill.name}]`;
      transformed = transformed.replace(
        new RegExp(`(?<!\\\\)\\$${escapeRegex(skill.name)}\\b`, "gi"),
        marker,
      );
    }
    // Clean escaped \$
    transformed = transformed.replace(/\\\$/g, "$");

    return {
      action: "transform",
      text: transformed,
    };
  });

  // ── 4. Inject skill content into system prompt ────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (pendingSkills.length === 0) return;
    if (skillsInjectedThisTurn) return;
    skillsInjectedThisTurn = true;

    // Build system prompt injection block
    const parts: string[] = [];

    for (const skill of pendingSkills) {
      // Read SKILL.md content fresh each time
      let content: string;
      try {
        const { readFileSync } = await import("node:fs");
        content = readFileSync(skill.skilMdPath, "utf-8");
      } catch {
        content = `[Unable to read ${skill.name} skill]`;
      }

      parts.push(
        `<skill name="${skill.name}">\n` +
        `  <description>${skill.description}</description>\n` +
        `  <path>${skill.dir}</path>\n` +
        `${content}\n` +
        `</skill>`,
      );
    }

    const injection = `
## Loaded Skills (via $skill_name)

The user has requested the following skills to be active for this task.
Apply their instructions where relevant.

${parts.join("\n\n")}

When referencing files from these skills, use the <path> shown above.
When executing scripts from these skills, use the <path> as the working directory
or prefix paths with the skill directory.
`;

    return {
      systemPrompt: event.systemPrompt + "\n" + injection,
    };
  });

  // ── 5. Clean up pending skills after turn ends ────────────────
  pi.on("turn_end", async () => {
    pendingSkills = [];
    skillsInjectedThisTurn = false;
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
