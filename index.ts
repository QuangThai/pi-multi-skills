/**
 * Multi-skill invocation for Pi.
 *
 * Type `$skill-name` anywhere in a user/RPC prompt to load one or more skills
 * through the same structural wrapper Pi uses for native skill invocations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandSkillReferences } from "./expander";
import { getSkillCompletionPrefix } from "./parser";
import {
  buildSkillRegistry,
  formatSkillTable,
  type SkillInfo,
} from "./resolver";

const MAX_AUTOCOMPLETE_RESULTS = 20;
const LARGE_INJECTION_CHARACTERS = 50_000;
const WIDGET_KEY = "multi-skills";

function truncateDescription(description: string, length: number): string {
  return description.length > length
    ? `${description.slice(0, length)}...`
    : description;
}

function rankAutocompleteSkills(
  registry: Map<string, SkillInfo>,
  partial: string,
): SkillInfo[] {
  return [...registry.values()]
    .filter(({ name }) => name.includes(partial))
    .sort((left, right) => {
      const prefixDifference = Number(!left.name.startsWith(partial)) -
        Number(!right.name.startsWith(partial));
      if (prefixDifference !== 0) return prefixDifference;

      const indexDifference = left.name.indexOf(partial) - right.name.indexOf(partial);
      return indexDifference || left.name.localeCompare(right.name);
    })
    .slice(0, MAX_AUTOCOMPLETE_RESULTS);
}

export default function multiSkillsExtension(pi: ExtensionAPI): void {
  let cachedRegistry: Map<string, SkillInfo> | undefined;

  const refreshRegistry = (): Map<string, SkillInfo> => {
    cachedRegistry = buildSkillRegistry(pi.getCommands());
    return cachedRegistry;
  };

  const getRegistry = (): Map<string, SkillInfo> => cachedRegistry ?? refreshRegistry();

  pi.on("session_start", (_event, ctx) => {
    refreshRegistry();
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    const theme = ctx.ui.theme;

    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["$"],

      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const linePartial = getSkillCompletionPrefix(beforeCursor);
        if (linePartial === undefined) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const partial = cursorLine === 0
          ? linePartial
          : getSkillCompletionPrefix([
            ...lines.slice(0, cursorLine),
            beforeCursor,
          ].join("\n"));
        if (partial === undefined) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }
        if (options.signal.aborted) return null;

        const registry = getRegistry();
        if (registry.size === 0) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const items = rankAutocompleteSkills(registry, partial).map((skill) => ({
          value: `$${skill.name} `,
          label: theme.fg("accent", `$${skill.name}`),
          description: truncateDescription(skill.description, 80),
        }));

        if (items.length === 0) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        return { prefix: `$${partial}`, items };
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  pi.registerCommand("skills", {
    description: "List all available skills with their $name syntax",
    handler: async (_args, ctx) => {
      const registry = getRegistry();
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

  pi.registerCommand("skills-search", {
    description: "Search skills by keyword",
    handler: async (args, ctx) => {
      const keyword = args.trim().toLowerCase();
      if (!keyword) {
        ctx.ui.notify("Usage: /skills-search <keyword>", "warning");
        return;
      }

      const matches: string[] = [];
      for (const [name, info] of getRegistry()) {
        if (
          name.includes(keyword) ||
          info.description.toLowerCase().includes(keyword)
        ) {
          matches.push(
            `  $${name.padEnd(28)} ${truncateDescription(info.description, 60)}`,
          );
        }
      }

      if (matches.length === 0) {
        ctx.ui.notify(`No skills matching "${args.trim()}"`, "warning");
        return;
      }

      ctx.ui.notify(
        `Skills matching "${args.trim()}" (${matches.length}):\n\n${matches.join("\n")}`,
        "info",
      );
    },
  });

  pi.on("input", async (event, ctx) => {
    // Match Pi's documented routing pattern: extension-injected messages should
    // not unexpectedly activate another extension's `$variables`.
    if (event.source === "extension") return { action: "continue" };

    if (!event.text.includes("$")) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return { action: "continue" };
    }

    const expansion = await expandSkillReferences(event.text, getRegistry());

    for (const failure of expansion.failures) {
      ctx.ui.notify(
        `Could not read skill file for $${failure.skill.name}: ${failure.message}`,
        "error",
      );
    }

    if (!expansion.transformed) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return { action: "continue" };
    }

    const theme = ctx.ui.theme;
    const coloredSkills = expansion.loaded
      .map((skill) => theme.fg("accent", `$${skill.name}`))
      .join("  ");
    ctx.ui.setWidget(WIDGET_KEY, [
      theme.fg("dim", "Skills: ") + coloredSkills,
    ]);

    ctx.ui.notify(
      `Loaded skills: ${expansion.loaded.map((skill) => `$${skill.name}`).join(", ")}`,
      "info",
    );

    if (expansion.bodyCharacters > LARGE_INJECTION_CHARACTERS) {
      ctx.ui.notify(
        `Loaded skill instructions contain ${expansion.bodyCharacters.toLocaleString("en-US")} characters; consider invoking fewer skills to preserve context.`,
        "warning",
      );
    }

    return event.images
      ? { action: "transform", text: expansion.text, images: event.images }
      : { action: "transform", text: expansion.text };
  });

  pi.on("turn_end", (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
