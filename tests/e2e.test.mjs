/**
 * End-to-end integration tests for multi-skills.
 *
 * Simulates the full pipeline:
 *   mock SlashCommandInfo[] → buildSkillRegistry
 *   mock user input → parseSkillRefs
 *   → replaceSkillRefs with <skill> XML blocks
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

// ── Helpers ──────────────────────────────────────────────────────

function skillCommand({ name, description = "Test skill", path, baseDir, scope = "user" }) {
  return {
    name: `skill:${name}`,
    description,
    source: "skill",
    sourceInfo: {
      path,
      source: "local",
      scope,
      origin: "top-level",
      baseDir,
    },
  };
}

/**
 * Simulate the extension's inline expansion logic:
 *   parse $skill_name → resolve in registry → read SKILL.md → <skill> XML → replace
 */
function expandSkillRefs(
  text,
  registry,
  onUnresolved = () => {},
) {
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

  const replacements = [];
  for (const skill of resolved) {
    const content = readFileSync(skill.skillMdPath, "utf-8");
    const body = stripFrontmatter(content).trim();
    const marker =
      `<skill name="${skill.name}" location="${skill.skillMdPath}">\n` +
      `References are relative to ${skill.dir}.\n\n` +
      `${body}\n` +
      `</skill>`;
    replacements.push({ name: skill.name, marker });
  }

  return replaceSkillRefs(text, replacements);
}

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
      "description: Code review skill for reviewing pull requests",
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

describe("E2E: $skill_name expansion → <skill> XML", () => {
  it("expands a single $skill_name reference at the start of text", () => {
    const registry = buildSkillRegistry([
      skillCommand({
        name: "code-review",
        path: skillAFile,
        baseDir: skillADir,
      }),
    ]);

    const result = expandSkillRefs("$code-review", registry);

    // Must contain the skill XML block - note: tag has name AND location attributes
    assert.match(result, /^<skill name="code-review" location="/);
    assert.match(result, /location="[^"]+code-review[\\/]SKILL\.md"/);
    assert.match(result, /References are relative to/);
    assert.match(result, /# Code Review/);
    assert.match(result, /Correctness/);
    assert.match(result, /Security/);
    assert.match(result, /<\/skill>$/);
  });

  it("expands a single $skill_name reference inline in text", () => {
    const registry = buildSkillRegistry([
      skillCommand({
        name: "code-review",
        path: skillAFile,
        baseDir: skillADir,
      }),
    ]);

    const input = "Please apply $code-review to review this UI";
    const result = expandSkillRefs(input, registry);

    // Original text preserved around the skill block
    assert.ok(result.startsWith("Please apply "));
    assert.ok(result.endsWith(" to review this UI"));

    // Skill block present inline
    assert.match(result, /<skill name="code-review"/);
    assert.match(result, /<\/skill>/);

    // The $code-review reference is gone, replaced by XML
    assert.doesNotMatch(result, /\$code-review/);
  });

  it("expands multiple $skill_name references in the same message", () => {
    const registry = buildSkillRegistry([
      skillCommand({
        name: "code-review",
        path: skillAFile,
        baseDir: skillADir,
      }),
      skillCommand({
        name: "reference-docs",
        path: skillBFile,
        baseDir: skillBDir,
      }),
    ]);

    const input = "$code-review and $reference-docs";
    const result = expandSkillRefs(input, registry);

    // Both skill blocks present
    assert.match(result, /<skill name="code-review"/);
    assert.match(result, /<skill name="reference-docs"/);
    assert.match(result, /# Code Review/);
    assert.match(result, /# Reference Docs/);

    // Separator preserved between the two blocks
    assert.match(result, /<\/skill>\s+and\s+<skill/);
  });

  it("expands multiple inline $ references with surrounding text", () => {
    const registry = buildSkillRegistry([
      skillCommand({
        name: "code-review",
        path: skillAFile,
        baseDir: skillADir,
      }),
      skillCommand({
        name: "reference-docs",
        path: skillBFile,
        baseDir: skillBDir,
      }),
    ]);

    const input = "Run $code-review first, then $reference-docs for API docs";
    const result = expandSkillRefs(input, registry);

    assert.ok(result.startsWith("Run "));
    assert.match(result, / first, then /);
    assert.ok(result.endsWith(" for API docs"));
    assert.match(result, /<skill name="code-review"/);
    assert.match(result, /<skill name="reference-docs"/);
    assert.doesNotMatch(result, /\$code-review/);
    assert.doesNotMatch(result, /\$reference-docs/);
  });

  it("preserves text with no $skill references unchanged", () => {
    const registry = buildSkillRegistry([
      skillCommand({
        name: "code-review",
        path: skillAFile,
        baseDir: skillADir,
      }),
    ]);

    const input = "Just normal text without any skill references";
    const result = expandSkillRefs(input, registry);

    assert.equal(result, input);
  });

  it("ignores uppercase shell variables like $PATH and $HOME", () => {
    const registry = buildSkillRegistry([
      skillCommand({
        name: "code-review",
        path: skillAFile,
        baseDir: skillADir,
      }),
    ]);

    const input = "Using $PATH and $HOME environment variables";
    const result = expandSkillRefs(input, registry);

    // Should not be modified since $PATH/$HOME don't match lowercase pattern
    assert.equal(result, input);
  });

  it("preserves escaped \\$ as literal dollar sign", () => {
    const registry = buildSkillRegistry([
      skillCommand({
        name: "code-review",
        path: skillAFile,
        baseDir: skillADir,
      }),
    ]);

    const input = "Price is \\$100, not $code-review";
    const result = expandSkillRefs(input, registry);

    // $code-review should be expanded, \\$100 becomes $100
    assert.ok(result.startsWith("Price is $100, not "));
    assert.match(result, /<skill name="code-review"/);
  });

  it("reports unresolved skills but keeps $ references as-is", () => {
    const registry = buildSkillRegistry([]);

    const unresolvedSpy = [];
    const input = "Use $non-existent-skill for this task";
    const result = expandSkillRefs(input, registry, (u) => unresolvedSpy.push(...u));

    // $ reference preserved as-is since skill doesn't exist
    assert.equal(result, input);
    assert.deepEqual(unresolvedSpy, ["non-existent-skill"]);
  });

  it("handles deduplication: same $skill_name used twice", () => {
    const registry = buildSkillRegistry([
      skillCommand({
        name: "code-review",
        path: skillAFile,
        baseDir: skillADir,
      }),
    ]);

    const input = "$code-review is great, $code-review is thorough";
    const result = expandSkillRefs(input, registry);

    // Both occurrences replaced
    const occurrences = result.match(/<skill name="code-review"/g);
    assert.equal(occurrences.length, 2);
  });

  it("handles overlapping skill names (longest match wins)", () => {
    // Create skills with overlapping names
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

    assert.match(result, /<skill name="code-review"/);
    assert.match(result, /<skill name="code"/);
    assert.match(result, /# Code Review/);
    assert.match(result, /# Code/);
  });

  it("produces XML format matching Pi's native _expandSkillCommand", () => {
    const registry = buildSkillRegistry([
      skillCommand({
        name: "code-review",
        path: skillAFile,
        baseDir: skillADir,
      }),
    ]);

    const result = expandSkillRefs("$code-review", registry);

    // Verify the exact XML structure matches what Pi's _expandSkillCommand produces.
    // Pi's native format (from agent-session.js):
    //   `<skill name="${name}" location="${path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`
    assert.match(result, /^<skill name="code-review" location="/);
    assert.match(result, /">\nReferences are relative to /);
    assert.match(result, /\n\n# Code Review/);
    assert.match(result, /<\/skill>$/);

    // Verify the body content
    assert.match(result, /Correctness/);
    assert.match(result, /Security/);

    // Count opening tags (should be exactly 1)
    const openTags = result.match(/<skill name=/g);
    assert.equal(openTags.length, 1);

    // Count closing tags
    const closeTags = result.match(/<\/skill>/g);
    assert.equal(closeTags.length, 1);
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
    assert.ok(!registry.has("skills")); // extension commands filtered out
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

describe("E2E: XML output compatibility with Pi's parseSkillBlock", () => {
  it("XML skill block is parseable by Pi's parseSkillBlock regex", () => {
    // Verify the format matches Pi's native <skill> XML that parseSkillBlock expects.
    // Pi's parseSkillBlock (from agent-session.js):
    //   /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/

    const registry = buildSkillRegistry([
      skillCommand({
        name: "code-review",
        path: skillAFile,
        baseDir: skillADir,
      }),
    ]);

    const result = expandSkillRefs("$code-review", registry);

    // Must match Pi's parseSkillBlock regex
    const parseRegex = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;
    const match = result.match(parseRegex);
    assert.ok(match, `Output must match Pi's parseSkillBlock regex.\nFirst 200 chars: ${result.slice(0, 200)}`);

    assert.equal(match[1], "code-review");                            // skill name
    assert.ok(match[2].endsWith("SKILL.md"));                         // skill location
    assert.ok(match[3].includes("# Code Review"));                     // body content
    assert.equal(match[4], undefined);                                 // no args
  });
});
