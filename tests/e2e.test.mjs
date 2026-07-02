/**
 * End-to-end integration tests for multi-skills.
 *
 * Simulates the full pipeline:
 *   mock SlashCommandInfo[] → buildSkillRegistry
 *   mock user input → parseSkillRefs
 *   → prepend <skill> XML blocks, user text after \n\n
 *   → verify output matches Pi's native <skill> format
 */

import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSkillRegistry } from "../resolver.ts";
import { parseSkillRefs, replaceSkillRefs } from "../parser.ts";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

// ── Helper: build mock SlashCommandInfo ──────────────────────────

function skillCommand({ name, description = "Test skill", path, baseDir, scope = "user" }) {
  return {
    name: `skill:${name}`,
    description,
    source: "skill",
    sourceInfo: { path, source: "local", scope, origin: "top-level", baseDir },
  };
}

/**
 * Simulate the extension's current expansion logic:
 *   parse $skill_name → resolve in registry → read SKILL.md
 *   → remove $refs from text → prepend <skill> XML blocks
 *   → user text after \n\n
 */
function expandSkillRefs(text, registry, onUnresolved = () => {}) {
  const refs = parseSkillRefs(text);
  if (refs.length === 0) return text;

  const resolved = [];
  const unresolved = [];
  for (const ref of refs) {
    const skill = registry.get(ref.name);
    if (skill) resolved.push(skill);
    else unresolved.push(ref.name);
  }
  if (unresolved.length > 0) onUnresolved(unresolved);
  if (resolved.length === 0) return text;

  // Build <skill> XML blocks (same format as Pi's native /skill:xxx)
  const xmlBlocks = [];
  for (const skill of resolved) {
    const content = readFileSync(skill.skillMdPath, "utf-8");
    const body = stripFrontmatter(content).trim();
    const block =
      `<skill name="${skill.name}" location="${skill.skillMdPath}">\n` +
      `References are relative to ${skill.dir}.\n\n` +
      `${body}\n` +
      `</skill>`;
    xmlBlocks.push(block);
  }

  // Remove all $skill_name refs → clean user text
  // (uses replaceSkillRefs with empty markers, then handles \$ and whitespace)
  const userText = replaceSkillRefs(
    text,
    resolved.map((s) => ({ name: s.name, marker: "" })),
  )
    .replace(/\\\$/g, "$")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Prepend <skill> blocks at START so Pi's parseSkillBlock detects them
  // and renders compactly: "[skill] name (Ctrl+O to expand)"
  const skillBlock = xmlBlocks.join("\n\n");
  return userText ? `${skillBlock}\n\n${userText}` : skillBlock;
}

// ── Test fixtures ────────────────────────────────────────────────

let tmpDir;
let skillADir, skillAFile;
let skillBDir, skillBFile;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "multi-skills-e2e-"));

  // skill-a: directory SKILL.md
  skillADir = join(tmpDir, "code-review");
  mkdirSync(skillADir);
  skillAFile = join(skillADir, "SKILL.md");
  writeFileSync(
    skillAFile,
    [
      "---",
      "name: code-review",
      "description: Code review skill",
      "---",
      "",
      "# Code Review",
      "",
      "Review the code for:",
      "- Correctness",
      "- Performance",
      "- Security",
      "",
      "```bash",
      "./scripts/review.sh <file>",
      "```",
    ].join("\n"),
  );

  // skill-b: flat markdown skill
  skillBDir = join(tmpDir, "reference-docs");
  mkdirSync(skillBDir);
  skillBFile = join(skillBDir, "SKILL.md");
  writeFileSync(
    skillBFile,
    [
      "---",
      "name: reference-docs",
      "description: Reference documentation skill",
      "---",
      "",
      "# Reference Docs",
      "",
      "Look up API references and documentation.",
      "Use `./scripts/lookup.sh <topic>` for details.",
    ].join("\n"),
  );
});

// ── Tests ────────────────────────────────────────────────────────

describe("E2E: $skill_name expansion → <skill> XML at start", () => {
  it("bare $code-review → <skill> XML only (no user text)", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
    ]);

    const result = expandSkillRefs("$code-review", registry);

    // Must start with <skill> tag
    assert.match(result, /^<skill name="code-review" location="/);
    assert.match(result, /References are relative to/);
    assert.match(result, /# Code Review/);
    assert.match(result, /Correctness/);
    assert.match(result, /Security/);
    assert.match(result, /<\/skill>$/);

    // No trailing \n\n (userText is empty for bare reference)
    assert.doesNotMatch(result, /<\/skill>\n\n$/);
  });

  it("inline $code-review → <skill> at start, user text after \\n\\n", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
    ]);

    const input = "Please apply $code-review to review this UI";
    const result = expandSkillRefs(input, registry);

    // <skill> block is at the START (so Pi's parseSkillBlock detects it)
    assert.match(result, /^<skill name="code-review"/);

    // User text preserved after \n\n (with \$ref removed, whitespace collapsed)
    assert.match(result, /\n\nPlease apply to review this UI$/);

    // No \$code-review remains
    assert.doesNotMatch(result, /\$code-review/);
  });

  it("$code-review at start of text → <skill> + user text after \\n\\n", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
    ]);

    const input = "$code-review analyze this code";
    const result = expandSkillRefs(input, registry);

    assert.match(result, /^<skill name="code-review"/);
    assert.match(result, /\n\nanalyze this code$/);
  });

  it("multiple $skill_name refs → all <skill> blocks at start", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
      skillCommand({ name: "reference-docs", path: skillBFile, baseDir: skillBDir }),
    ]);

    const input = "$code-review and $reference-docs";
    const result = expandSkillRefs(input, registry);

    // Both <skill> blocks at start
    assert.match(result, /^<skill name="code-review"/);
    assert.match(result, /<skill name="reference-docs"/);
    assert.match(result, /# Code Review/);
    assert.match(result, /# Reference Docs/);

    // User text after all skill blocks
    assert.match(result, /\n\nand$/);
  });

  it("multiple inline $ refs → all <skill> at start, clean user text after", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
      skillCommand({ name: "reference-docs", path: skillBFile, baseDir: skillBDir }),
    ]);

    const input = "Run $code-review first, then $reference-docs for API docs";
    const result = expandSkillRefs(input, registry);

    // Both <skill> blocks at start
    assert.match(result, /^<skill name="code-review"/);
    assert.match(result, /<skill name="reference-docs"/);

    // User text cleaned of $refs, whitespace collapsed
    assert.match(result, /\n\nRun first, then for API docs$/);
    assert.doesNotMatch(result, /\$code-review/);
    assert.doesNotMatch(result, /\$reference-docs/);
  });

  it("preserves text with no $ references unchanged", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
    ]);

    assert.equal(expandSkillRefs("Just normal text", registry), "Just normal text");
  });

  it("ignores uppercase shell variables like $PATH and $HOME", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
    ]);

    const result = expandSkillRefs("Using $PATH and $HOME", registry);
    assert.equal(result, "Using $PATH and $HOME");
  });

  it("preserves escaped \\$ as literal dollar sign", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
    ]);

    const input = "Price is \\$100, not $code-review";
    const result = expandSkillRefs(input, registry);

    // $code-review expanded, \\$100 → $100
    assert.match(result, /^<skill name="code-review"/);
    assert.match(result, /\n\nPrice is \$100, not$/);
  });

  it("unresolved skills keep $ references as-is", () => {
    const registry = buildSkillRegistry([]);
    const unresolvedSpy = [];

    const input = "Use $unknown-skill for this";
    const result = expandSkillRefs(input, registry, (u) => unresolvedSpy.push(...u));

    assert.equal(result, input); // unchanged
    assert.deepEqual(unresolvedSpy, ["unknown-skill"]);
  });

  it("same $skill_name used twice → one <skill> block, refs removed from user text", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
    ]);

    const input = "$code-review is great, $code-review is thorough";
    const result = expandSkillRefs(input, registry);

    // Only ONE <skill> block (deduped by name)
    const occurrences = result.match(/<skill name="code-review"/g);
    assert.equal(occurrences.length, 1);

    // Both $code-review removed from user text
    assert.match(result, /\n\nis great, is thorough$/);
  });

  it("overlapping skill names (longest match wins)", () => {
    const shortDir = mkdtempSync(join(tmpdir(), "multi-skills-short-"));
    const shortFile = join(shortDir, "SKILL.md");
    writeFileSync(shortFile, "---\nname: code\ndescription: Code skill\n---\n\n# Code");

    const longDir = mkdtempSync(join(tmpdir(), "multi-skills-long-"));
    const longFile = join(longDir, "SKILL.md");
    writeFileSync(longFile, "---\nname: code-review\ndescription: Code review skill\n---\n\n# Code Review");

    const registry = buildSkillRegistry([
      skillCommand({ name: "code", path: shortFile, baseDir: shortDir }),
      skillCommand({ name: "code-review", path: longFile, baseDir: longDir }),
    ]);

    const result = expandSkillRefs("Use $code-review and $code", registry);

    assert.match(result, /^<skill name="code-review"/);
    assert.match(result, /<skill name="code"/);
    assert.match(result, /# Code Review/);
    assert.match(result, /# Code/);
    assert.match(result, /\n\nUse and$/);
  });

  it("XML format matches Pi's native _expandSkillCommand exactly", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
    ]);

    const result = expandSkillRefs("$code-review", registry);

    // Pi's native format (agent-session.js):
    //   `<skill name="${name}" location="${path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`
    assert.match(result, /^<skill name="code-review" location="/);
    assert.match(result, /">\nReferences are relative to /);
    assert.match(result, /\n\n# Code Review/);
    assert.match(result, /Correctness/);
    assert.match(result, /Security/);
    assert.match(result, /<\/skill>$/);

    // Exactly one skill block
    assert.equal(result.match(/<skill name=/g).length, 1);
    assert.equal(result.match(/<\/skill>/g).length, 1);
  });
});

describe("E2E: /skills command registry", () => {
  it("builds registry from mixed sources (extension + skill)", () => {
    const registry = buildSkillRegistry([
      { name: "skills", description: "List skills", source: "extension", sourceInfo: { path: "<test>", source: "test", scope: "temporary", origin: "top-level" } },
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
      skillCommand({ name: "reference-docs", path: skillBFile, baseDir: skillBDir }),
    ]);

    assert.equal(registry.size, 2);
    assert.ok(registry.has("code-review"));
    assert.ok(registry.has("reference-docs"));
    assert.ok(!registry.has("skills"));
  });

  it("handles skill resolution with dir → SKILL.md lookup", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillADir, baseDir: skillADir }),
    ]);

    const skill = registry.get("code-review");
    assert.ok(skill);
    assert.equal(skill.skillMdPath, skillAFile);
    assert.equal(skill.dir, skillADir);
  });
});

describe("E2E: parseSkillBlock compatibility (Pi's compact rendering)", () => {
  it("bare $code-review output matches parseSkillBlock regex", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
    ]);

    const result = expandSkillRefs("$code-review", registry);

    // Pi's parseSkillBlock (agent-session.js):
    //   /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/
    const parseRegex =
      /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;
    const match = result.match(parseRegex);
    assert.ok(match, `Must match Pi's parseSkillBlock.\nFirst 200 chars: ${result.slice(0, 200)}`);

    assert.equal(match[1], "code-review");
    assert.ok(match[2].endsWith("SKILL.md"));
    assert.ok(match[3].includes("# Code Review"));
    assert.equal(match[4], undefined); // no user text for bare ref
  });

  it("inline $code-reference output matches parseSkillBlock with userMessage", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "code-review", path: skillAFile, baseDir: skillADir }),
    ]);

    const result = expandSkillRefs("Please apply $code-review to this UI", registry);

    // Must match with userMessage captured
    const parseRegex =
      /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;
    const match = result.match(parseRegex);
    assert.ok(match, `Inline must match parseSkillBlock.\nFirst 200 chars: ${result.slice(0, 200)}`);

    assert.equal(match[1], "code-review");
    assert.ok(match[3].includes("# Code Review"));

    // userMessage captured (for Pi's separate rendering)
    assert.ok(match[4]);
    assert.match(match[4], /Please apply to this UI/);
  });
});
