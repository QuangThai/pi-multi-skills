/**
 * Tests for multi-skills resolver.
 *
 * Run with: node --test tests/resolver.test.mjs
 */

import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// ── Inline the resolver logic for testing ──────────────────────

function parseFrontmatter(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return { body: content };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^\s*(\w[\w-]*)\s*:\s*(.*?)\s*$/);
    if (kv) {
      let val = kv[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      fm[kv[1]] = val;
    }
  }
  return { frontmatter: fm, body: content.slice(m[0].length) };
}

function scanSkillRoot(root, scope) {
  const skills = [];
  if (!existsSync(root)) return skills;
  for (const entry of readdirSync(root)) {
    const fp = join(root, entry);
    let st;
    try { st = statSync(fp); } catch { continue; }
    if (st.isDirectory()) {
      const smd = join(fp, "SKILL.md");
      if (existsSync(smd)) {
        try {
          const content = readFileSync(smd, "utf-8");
          const { frontmatter } = parseFrontmatter(content);
          skills.push({
            name: frontmatter?.name || entry,
            description: frontmatter?.description || "",
            dir: fp,
            skillMdPath: smd,
            scope,
          });
        } catch { /* skip */ }
      }
    }
  }
  return skills;
}

// ────────────────────────────────────────────────────────────────

describe("scanSkillRoot", () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "multi-skills-test-"));
    // Create standard skill dir
    mkdirSync(join(tmpDir, "my-skill"));
    writeFileSync(
      join(tmpDir, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: My test skill\n---\n\n# My Skill\nDo something.",
    );
    // Create another skill
    mkdirSync(join(tmpDir, "another"));
    writeFileSync(
      join(tmpDir, "another", "SKILL.md"),
      "---\nname: another\ndescription: Another test skill\n---\n\nDo stuff.",
    );
    // Create a dir without SKILL.md (should be skipped)
    mkdirSync(join(tmpDir, "empty-dir"));
    // Create a flat .md file (should be skipped by directory scanner)
    writeFileSync(join(tmpDir, "readme.md"), "# Not a skill");
  });

  it("finds skill directories with SKILL.md", () => {
    const skills = scanSkillRoot(tmpDir, "user");
    assert.equal(skills.length, 2);
    const names = skills.map((s) => s.name).sort();
    assert.deepEqual(names, ["another", "my-skill"]);
  });

  it("reads name from frontmatter", () => {
    const skills = scanSkillRoot(tmpDir, "user");
    const ms = skills.find((s) => s.name === "my-skill");
    assert.ok(ms);
    assert.equal(ms.description, "My test skill");
  });

  it("returns empty for missing directory", () => {
    const skills = scanSkillRoot("/nonexistent/path", "user");
    assert.equal(skills.length, 0);
  });

  it("sets scope correctly", () => {
    const skills = scanSkillRoot(tmpDir, "package");
    assert.ok(skills.every((s) => s.scope === "package"));
  });
});

describe("parseFrontmatter", () => {
  it("parses name and description", () => {
    const { frontmatter } = parseFrontmatter(
      "---\nname: test\ndescription: A test\n---\n\nBody",
    );
    assert.equal(frontmatter?.name, "test");
    assert.equal(frontmatter?.description, "A test");
  });

  it("strips quotes from values", () => {
    const { frontmatter } = parseFrontmatter(
      '---\nname: "quoted"\n---\n\nBody',
    );
    assert.equal(frontmatter?.name, "quoted");
  });

  it("returns body without frontmatter", () => {
    const { frontmatter, body } = parseFrontmatter(
      "---\nname: test\n---\n\n# Actual content",
    );
    assert.ok(frontmatter);
    assert.match(body, /Actual content/);
  });

  it("handles no frontmatter", () => {
    const { frontmatter, body } = parseFrontmatter("Just content");
    assert.equal(frontmatter, undefined);
    assert.equal(body, "Just content");
  });
});
