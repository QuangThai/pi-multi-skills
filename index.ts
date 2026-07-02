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
 *   4. Reads SKILL.md content and auto-injects into system prompt
 *   5. Provides `/skills` and `/skills-search` commands
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

// ── Helpers ─────────────────────────────────────────────────────
/** Regex for $skill_name patterns */
const SKILL_DISPLAY_RE = /\$[a-z][a-z0-9_-]*/g;

/** Minimal editor interface for the highlight wrapper (avoids pi-tui import) */
interface InnerEditor {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  getText(): string;
  setText(text: string): void;
  focused: boolean;
  onSubmit?: ((text: string) => void) | undefined;
  onChange?: ((text: string) => void) | undefined;
  borderColor?: ((str: string) => string) | undefined;
  addToHistory?(text: string): void;
  insertTextAtCursor?(text: string): void;
  getExpandedText?(): string;
  setAutocompleteProvider?(provider: unknown): void;
  setPaddingX?(padding: number): void;
  setAutocompleteMaxVisible?(maxVisible: number): void;
}

/**
 * Editor wrapper that delegates everything to the inner editor
 * but post-processes render output to highlight $skill_name with
 * the current theme's accent color.
 */
class SkillHighlightEditor implements InnerEditor {
  private inner: InnerEditor;
  private theme: { fg(token: string, text: string): string };

  constructor(
    inner: InnerEditor,
    theme: { fg(token: string, text: string): string },
  ) {
    this.inner = inner;
    this.theme = theme;

    // Forward onSubmit / onChange so the app can submit
    if (inner.onSubmit) {
      this.onSubmit = inner.onSubmit.bind(inner);
    }
    if (inner.onChange) {
      this.onChange = inner.onChange.bind(inner);
    }
  }

  // ── Delegated members ───────────────────────────────────
  get focused(): boolean {
    return this.inner.focused;
  }
  set focused(value: boolean) {
    this.inner.focused = value;
  }
  get onSubmit(): ((text: string) => void) | undefined {
    return this.inner.onSubmit;
  }
  set onSubmit(fn: ((text: string) => void) | undefined) {
    this.inner.onSubmit = fn;
  }
  get onChange(): ((text: string) => void) | undefined {
    return this.inner.onChange;
  }
  set onChange(fn: ((text: string) => void) | undefined) {
    this.inner.onChange = fn;
  }
  get borderColor(): ((str: string) => string) | undefined {
    return this.inner.borderColor;
  }
  set borderColor(fn: ((str: string) => string) | undefined) {
    this.inner.borderColor = fn;
  }

  // ── Component interface ─────────────────────────────────
  render(width: number): string[] {
    const lines = this.inner.render(width);
    // Highlight $skill_name patterns with accent color in every line
    return lines.map((line: string) =>
      line.replace(SKILL_DISPLAY_RE, (match: string) => this.theme.fg("accent", match)),
    );
  }
  invalidate(): void { this.inner.invalidate(); }
  handleInput(data: string): void { this.inner.handleInput(data); }

  // ── EditorComponent interface ───────────────────────────
  getText(): string { return this.inner.getText(); }
  setText(text: string): void { this.inner.setText(text); }
  addToHistory?(text: string): void { this.inner.addToHistory?.(text); }
  insertTextAtCursor?(text: string): void { this.inner.insertTextAtCursor?.(text); }
  getExpandedText?(): string { return this.inner.getExpandedText?.() ?? this.inner.getText(); }
  setAutocompleteProvider?(provider: unknown): void {
    this.inner.setAutocompleteProvider?.(provider);
  }
  setPaddingX?(padding: number): void { this.inner.setPaddingX?.(padding); }
  setAutocompleteMaxVisible?(maxVisible: number): void { this.inner.setAutocompleteMaxVisible?.(maxVisible); }
}

// ── In-memory state ──────────────────────────────────────────────
let pendingSkills: SkillInfo[] = [];
let skillsInjectedThisTurn = false;

// ── System prompt injection template ─────────────────────────────
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildInjectionBlock(skills: SkillInfo[]): string {
  const parts: string[] = [];

  for (const skill of skills) {
    let content: string;
    try {
      content = readFileSync(skill.skillMdPath, "utf-8");
    } catch {
      content = `[Unable to read ${skill.name} skill]`;
    }

    const body = stripFrontmatter(content).trim();

    parts.push(
      "<skill name=\"" + escapeXml(skill.name) + "\" location=\"" + escapeXml(skill.skillMdPath) + "\">\n" +
      "References are relative to " + skill.dir + ".\n\n" +
      body + "\n" +
      "</skill>",
    );
  }

  return (
    "\n## Loaded Skills (via $skill_name)\n" +
    "\n" +
    "The user has requested the following skills to be active for this task.\n" +
    "Apply their instructions where relevant.\n" +
    "\n" +
    parts.join("\n\n") +
    "\n" +
    "\n" +
    "When referencing files from these skills, resolve relative paths against\n" +
    "the skill directory shown in each block.\n"
  );
}

// ── Extension entry ──────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // ── 0. Build registry, register autocomplete & editor wrapper ─
  pi.on("session_start", async (_event, ctx) => {
    pendingSkills = [];
    skillsInjectedThisTurn = false;

    // Capture current theme for styling skill names
    const theme = ctx.ui.theme;

    // ── Wrap editor to highlight $skill_name in accent color ──
    const previousEditor = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui: unknown, editorTheme: unknown, keybindings: unknown) => {
      const inner: InnerEditor = previousEditor
        ? (previousEditor(tui as any, editorTheme as any, keybindings as any) as unknown as InnerEditor)
        : (tui as any).createDefaultEditor?.(editorTheme, keybindings) as unknown as InnerEditor;
      if (!inner) {
        // Fallback: if we can't get the editor, return a dummy so pi doesn't crash
        return previousEditor
          ? previousEditor(tui as any, editorTheme as any, keybindings as any)
          : undefined as any;
      }
      return new SkillHighlightEditor(inner, theme) as any;
    });

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
            // Plain text — SkillHighlightEditor wrapper colors them at render time
            items.push({
              value: `$${name} `,
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

  // ── 3. Intercept user input, parse $skill_name references ──────
  pi.on("input", async (event, ctx) => {
    if (!event.text || !event.text.includes("$")) {
      return { action: "continue" };
    }

    const refs = parseSkillRefs(event.text);
    if (refs.length === 0) {
      return { action: "continue" };
    }

    const registry = buildSkillRegistry(pi.getCommands());

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
      if (unresolved.length > 0) {
        ctx.ui.notify(
          `Unknown skills: ${unresolved.join(", ")}. Use /skills to see available skills.`,
          "warning",
        );
      }
      return { action: "continue" };
    }

    if (unresolved.length > 0) {
      ctx.ui.notify(
        `Unknown skills: ${unresolved.join(", ")}. They will be skipped.`,
        "warning",
      );
    }

    pendingSkills = resolved;
    skillsInjectedThisTurn = false;

    ctx.ui.notify(
      `Loading skills: ${resolved.map((s) => `$${s.name}`).join(", ")}`,
      "info",
    );

    // Transform: replace $skill_name → [skill: name] markers
    // replaceSkillRefs sorts by name length internally to prevent
    // partial matches (e.g. $code matched inside $code-review).
    const transformed = replaceSkillRefs(
      event.text,
      resolved.map(
        (s): SkillReplacement => ({ name: s.name, marker: `[skill: ${s.name}]` }),
      ),
    );

    return { action: "transform", text: transformed };
  });

  // ── 4. Inject skill content into system prompt ─────────────────
  pi.on("before_agent_start", async (event) => {
    if (pendingSkills.length === 0) return;
    if (skillsInjectedThisTurn) return;
    skillsInjectedThisTurn = true;

    return {
      systemPrompt:
        event.systemPrompt + buildInjectionBlock(pendingSkills),
    };
  });

  // ── 5. Clean up pending skills after turn ends ─────────────────
  pi.on("turn_end", async () => {
    pendingSkills = [];
    skillsInjectedThisTurn = false;
  });
}
