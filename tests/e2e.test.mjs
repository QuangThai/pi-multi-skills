/**
 * End-to-end integration tests for multi-skills.
 *
 * Simulates the full pipeline:
 *   mock SlashCommandInfo[] → buildSkillRegistry
 *   mock user input → parseSkillRefs
 *   → prepend <skill> XML block (merged for multi-skill)
 *   → verify parseSkillBlock compatibility
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

const SKILL_A_CONTENT = `# Skill A\n\nContent A`;
const SKILL_B_CONTENT = `# Skill B\n\nContent B`;

function skillCmd({ name, description = "Test", path, baseDir, scope = "user" }) {
  return {
    name: `skill:${name}`,
    description,
    source: "skill",
    sourceInfo: { path, source: "local", scope, origin: "top-level", baseDir },
  };
}

function simulateExpansion(text, registry) {
  const refs = parseSkillRefs(text);
  if (refs.length === 0) return text;

  const resolved = refs.map((r) => registry.get(r.name)).filter(Boolean);
  if (resolved.length === 0) return text;

  // Build <skill> XML blocks
  const xmlBlocks = [];
  for (const s of resolved) {
    const content = readFileSync(s.skillMdPath, "utf-8");
    const body = stripFrontmatter(content).trim();
    xmlBlocks.push(
      `<skill name="${s.name}" location="${s.skillMdPath}">\n` +
      `References are relative to ${s.dir}.\n\n${body}\n</skill>`,
    );
  }

  // Clean user text
  const userText = replaceSkillRefs(
    text,
    resolved.map((s) => ({ name: s.name, marker: "" })),
  )
    .replace(/\\\$/g, "$")
    .replace(/\s{2,}/g, " ")
    .trim();

  // SINGLE skill → use as-is. MULTI skill → merge into one block.
  let skillBlock;
  if (xmlBlocks.length === 1) {
    skillBlock = xmlBlocks[0];
  } else {
    const first = resolved[0];
    const allNames = resolved.map((s) => s.name).join(", ");
    const mergedBody = resolved
      .map((s) => {
        const c = readFileSync(s.skillMdPath, "utf-8");
        const b = stripFrontmatter(c).trim();
        return `## ${s.name}\n\n${b}`;
      })
      .join("\n\n---\n\n");
    skillBlock =
      `<skill name="${allNames}" location="${first.skillMdPath}">\n` +
      `References are relative to ${first.dir}.\n\n${mergedBody}\n</skill>`;
  }

  return userText ? `${skillBlock}\n\n${userText}` : skillBlock;
}

// ── Fixtures ────────────────────────────────────────────────────

let tmpDir, d1, d2, f1, f2;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "e2e-"));
  d1 = join(tmpDir, "skill-a");
  mkdirSync(d1);
  f1 = join(d1, "SKILL.md");
  writeFileSync(f1, `---\nname: skill-a\ndescription: First\n---\n\n${SKILL_A_CONTENT}`);

  d2 = join(tmpDir, "skill-b");
  mkdirSync(d2);
  f2 = join(d2, "SKILL.md");
  writeFileSync(f2, `---\nname: skill-b\ndescription: Second\n---\n\n${SKILL_B_CONTENT}`);
});

// ── Tests ────────────────────────────────────────────────────────

describe("E2E: single skill", () => {
  it("bare $skill-a → single <skill> block", () => {
    const r = buildSkillRegistry([skillCmd({ name: "skill-a", path: f1, baseDir: d1 })]);
    const out = simulateExpansion("$skill-a", r);
    assert.match(out, /^<skill name="skill-a"/);
    assert.match(out, /Skill A/);
    assert.doesNotMatch(out, /Skill B/);
    assert.match(out, /<\/skill>$/);
  });

  it("inline 'Use $skill-a' → <skill> at start + user text", () => {
    const r = buildSkillRegistry([skillCmd({ name: "skill-a", path: f1, baseDir: d1 })]);
    const out = simulateExpansion("Use $skill-a please", r);
    assert.match(out, /^<skill name="skill-a"/);
    assert.match(out, /\n\nUse please$/);
  });
});

describe("E2E: multi-skill merged block", () => {
  it("bare $skill-a $skill-b → ONE merged <skill> with both skills", () => {
    const r = buildSkillRegistry([
      skillCmd({ name: "skill-a", path: f1, baseDir: d1 }),
      skillCmd({ name: "skill-b", path: f2, baseDir: d2 }),
    ]);
    const out = simulateExpansion("$skill-a $skill-b", r);

    // One <skill> block only
    assert.equal(out.match(/<skill name=/g).length, 1);
    assert.equal(out.match(/<\/skill>/g).length, 1);

    // Name contains both skills
    assert.match(out, /^<skill name="skill-a, skill-b"/);

    // Both skills' content present
    assert.match(out, /Skill A/);
    assert.match(out, /Skill B/);

    // No user text (bare refs)
    assert.match(out, /<\/skill>$/);
  });

  it("inline multi-skill → merged block + user text", () => {
    const r = buildSkillRegistry([
      skillCmd({ name: "skill-a", path: f1, baseDir: d1 }),
      skillCmd({ name: "skill-b", path: f2, baseDir: d2 }),
    ]);
    const out = simulateExpansion("Run $skill-a then $skill-b here", r);

    // One merged block
    assert.equal(out.match(/<skill name=/g).length, 1);

    // Both skills present
    assert.match(out, /Skill A/);
    assert.match(out, /Skill B/);

    // User text after \n\n
    assert.match(out, /\n\nRun then here$/);
  });

  it("parseSkillBlock matches merged multi-skill block", () => {
    const r = buildSkillRegistry([
      skillCmd({ name: "skill-a", path: f1, baseDir: d1 }),
      skillCmd({ name: "skill-b", path: f2, baseDir: d2 }),
    ]);
    const out = simulateExpansion("$skill-a $skill-b", r);

    const re = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;
    const m = out.match(re);
    assert.ok(m, "parseSkillBlock must match merged block");
    assert.equal(m[1], "skill-a, skill-b");
    assert.ok(m[3].includes("Skill A"));
    assert.ok(m[3].includes("Skill B"));
    assert.equal(m[4], undefined);
  });

  it("3 skills merged into one block", () => {
    const d3 = join(tmpDir, "skill-c");
    mkdirSync(d3);
    const f3 = join(d3, "SKILL.md");
    writeFileSync(f3, "---\nname: skill-c\ndescription: Third\n---\n\n# Skill C\nContent C");

    const r = buildSkillRegistry([
      skillCmd({ name: "skill-a", path: f1, baseDir: d1 }),
      skillCmd({ name: "skill-b", path: f2, baseDir: d2 }),
      skillCmd({ name: "skill-c", path: f3, baseDir: d3 }),
    ]);
    const out = simulateExpansion("use $skill-a $skill-b $skill-c here", r);

    assert.equal(out.match(/<skill name=/g).length, 1);
    assert.match(out, /^<skill name="skill-a, skill-b, skill-c"/);
    assert.match(out, /Skill A/);
    assert.match(out, /Skill B/);
    assert.match(out, /Skill C/);
    assert.match(out, /\n\nuse here$/);
  });
});

describe("E2E: edge cases", () => {
  it("preserves text with no $ refs", () => {
    assert.equal(simulateExpansion("hello", buildSkillRegistry([])), "hello");
  });

  it("ignores $PATH $HOME", () => {
    const out = simulateExpansion("$PATH and $HOME", buildSkillRegistry([]));
    assert.equal(out, "$PATH and $HOME");
  });

  it("escaped \\$", () => {
    const r = buildSkillRegistry([skillCmd({ name: "skill-a", path: f1, baseDir: d1 })]);
    const out = simulateExpansion("Price \\$100, not $skill-a", r);
    assert.match(out, /^<skill name="skill-a"/);
    assert.match(out, /\n\nPrice \$100, not$/);
  });

  it("unknown skills keep $ as-is", () => {
    const r = buildSkillRegistry([]);
    assert.equal(simulateExpansion("Use $unknown", r), "Use $unknown");
  });

  it("overlapping names (longest wins)", () => {
    const sd = mkdtempSync(join(tmpdir(), "short-"));
    const sf = join(sd, "SKILL.md");
    writeFileSync(sf, "---\nname: code\ndescription: C\n---\n\n# Code");

    const ld = mkdtempSync(join(tmpdir(), "long-"));
    const lf = join(ld, "SKILL.md");
    writeFileSync(lf, "---\nname: code-review\ndescription: CR\n---\n\n# Code Review");

    const r = buildSkillRegistry([
      skillCmd({ name: "code", path: sf, baseDir: sd }),
      skillCmd({ name: "code-review", path: lf, baseDir: ld }),
    ]);
    const out = simulateExpansion("$code-review and $code", r);

    assert.equal(out.match(/<skill name=/g).length, 1);
    assert.match(out, /Code Review/);
    assert.match(out, /# Code/);
    assert.match(out, /\n\nand$/);
  });
});
