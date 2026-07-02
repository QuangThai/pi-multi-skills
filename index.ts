/**
 * multi-skills — Multi-skill invocation for pi coding agent
 *
 * Allows users to reference any installed skill from anywhere in their prompt
 * using $skill_name syntax:
 *
 *   "Apply $code-review and $ui-ux-pro-max to review this UI"
 *
 * The extension:
 *   1. Inline autocomplete: type $ + Tab to browse available skills
 *   2. Parses $skill_name references from user input (input event)
 *   3. Resolves skill paths from Pi's loaded /skill:name commands
 *   4. Reads SKILL.md content and expands $skill_name → <skill> XML block
 *     (same format as Pi's native /skill:xxx expansion)
 *   5. Provides `/skills` and `/skills-search` commands
 *   6. Shows a colored widget with detected skills above the editor
 */

import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildSkillRegistry,
  formatSkillTable,
  type SkillInfo,
} from "./resolver";
import {
  parseSkillRefs,
  replaceSkillRefs,
  type SkillReplacement,
} from "./parser";
import { readFileSync } from "node:fs";

// ── Extension entry ──────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Capture current theme for styling skill names
    const theme = ctx.ui.theme;

    // ── Register $ autocomplete provider ───────────────────────
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["$"],

      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);

        // Match $ followed by partial skill name at cursor position
        const match = beforeCursor.match(
          /(?:^|[^\\])\$((?:[a-z][a-z0-9_-]*)?)$/,
        );
        if (!match) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const partial = (match[1] ?? "").toLowerCase();
        const registry = buildSkillRegistry(pi.getCommands());

        if (registry.size === 0) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        // Filter skills by partial name match
        const items: Array<{
          value: string;
          label: string;
          description: string;
        }> = [];
        for (const [name, info] of registry) {
          if (name.startsWith(partial) || name.includes(partial)) {
            const desc = info.description.length > 80
              ? info.description.slice(0, 80) + "..."
              : info.description;
            // Plain text value (editor text buffer) + trailing space for seamless typing
            // Colored label for autocomplete dropdown display
            items.push({
              value: `$${name} `,
              label: theme.fg("accent", `$${name}`),
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
        return current.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix,
        );
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return (
          current.shouldTriggerFileCompletion?.(
            lines,
            cursorLine,
            cursorCol,
          ) ?? true
        );
      },
    }));
  });

  // ── 1. /skills command ─────────────────────────────────────────
  pi.registerCommand("skills", {
    description: "List all available skills with their $name syntax",
    handler: async (_args, ctx) => {
      const registry = buildSkillRegistry(pi.getCommands());
      if (registry.size === 0) {
        ctx.ui.notify("No skills found.", "warning");
        return;
      }
      ctx.ui.notify(
        `Available skills (${registry.size} total):\n\n${formatSkillTable(registry)}`,
        "info",
      );
    },
  });

  // ── 2. /skills-search command ──────────────────────────────────
  pi.registerCommand("skills-search", {
    description: "Search skills by keyword",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /skills-search <keyword>", "warning");
        return;
      }

      const registry = buildSkillRegistry(pi.getCommands());
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

  // ── 3. Intercept user input, expand $skill_name → <skill> XML ──
  pi.on("input", async (event, ctx) => {
    if (!event.text || !event.text.includes("$")) {
      // Clear skill widget when no $ references
      ctx.ui.setWidget("multi-skills", undefined);
      return { action: "continue" };
    }

    const refs = parseSkillRefs(event.text);
    if (refs.length === 0) {
      ctx.ui.setWidget("multi-skills", undefined);
      return { action: "continue" };
    }

    const registry = buildSkillRegistry(pi.getCommands());
    const theme = ctx.ui.theme;

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

    // Update widget to show detected skills with theme colors
    if (resolved.length > 0) {
      const coloredSkills = resolved
        .map((s) => theme.fg("accent", `$${s.name}`))
        .join("  ");
      ctx.ui.setWidget("multi-skills", [
        theme.fg("dim", "Skills: ") + coloredSkills,
      ]);
    }

    if (unresolved.length > 0) {
      ctx.ui.notify(
        `Unknown skills: ${unresolved.join(", ")}. Use /skills to see available skills.`,
        "warning",
      );
    }

    if (resolved.length === 0) {
      ctx.ui.setWidget("multi-skills", undefined);
      return { action: "continue" };
    }

    ctx.ui.notify(
      `Loading skills: ${resolved.map((s) => `$${s.name}`).join(", ")}`,
      "info",
    );

    // Expand: replace $skill_name → <skill name="..." location="...">...</skill>
    // This produces the same XML format as Pi's native /skill:xxx expansion,
    // but works inline at any position in the text, not just at the start.
    const replacements: SkillReplacement[] = [];
    for (const skill of resolved) {
      try {
        const content = readFileSync(skill.skillMdPath, "utf-8");
        const body = stripFrontmatter(content).trim();
        const marker =
          `<skill name="${skill.name}" location="${skill.skillMdPath}">\n` +
          `References are relative to ${skill.dir}.\n\n` +
          `${body}\n` +
          `</skill>`;
        replacements.push({ name: skill.name, marker });
      } catch {
        ctx.ui.notify(
          `Could not read skill file for $${skill.name}`,
          "error",
        );
      }
    }

    if (replacements.length === 0) {
      return { action: "continue" };
    }

    const transformed = replaceSkillRefs(event.text, replacements);

    return { action: "transform", text: transformed };
  });
}
