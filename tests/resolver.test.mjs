/**
 * Tests for multi-skills resolver.
 *
 * Run with: npm test
 */

import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSkillRegistry,
  formatSkillTable,
  parseFrontmatter,
} from "../resolver.ts";

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

function extensionCommand() {
  return {
    name: "skills",
    description: "List skills",
    source: "extension",
    sourceInfo: {
      path: "<test>",
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
  };
}

let tmpDir;
let skillDir;
let skillFile;
let flatSkillFile;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "multi-skills-test-"));

  skillDir = join(tmpDir, "my-skill");
  mkdirSync(skillDir);
  skillFile = join(skillDir, "SKILL.md");
  writeFileSync(
    skillFile,
    "---\nname: my-skill\ndescription: My test skill\n---\n\n# My Skill\nDo something.",
  );

  flatSkillFile = join(tmpDir, "flat-skill.md");
  writeFileSync(
    flatSkillFile,
    "---\nname: flat-skill\ndescription: Flat test skill\n---\n\n# Flat Skill",
  );
});

// ────────────────────────────────────────────────────────────────

describe("buildSkillRegistry", () => {
  it("builds a registry from Pi skill commands", () => {
    const registry = buildSkillRegistry([
      extensionCommand(),
      skillCommand({ name: "my-skill", description: "My test skill", path: skillFile, baseDir: skillDir }),
    ]);

    assert.equal(registry.size, 1);
    assert.equal(registry.get("my-skill")?.description, "My test skill");
    assert.equal(registry.get("my-skill")?.skillMdPath, skillFile);
    assert.equal(registry.get("my-skill")?.dir, skillDir);
  });

  it("resolves directory command paths to SKILL.md", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "my-skill", path: skillDir, baseDir: skillDir }),
    ]);

    assert.equal(registry.get("my-skill")?.skillMdPath, skillFile);
  });

  it("supports flat markdown skill paths exposed by Pi", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "flat-skill", path: flatSkillFile, baseDir: tmpDir, scope: "project" }),
    ]);

    const skill = registry.get("flat-skill");
    assert.ok(skill);
    assert.equal(skill.skillMdPath, flatSkillFile);
    assert.equal(skill.dir, tmpDir);
    assert.equal(skill.scope, "project");
  });

  it("keeps the first skill on duplicate names to preserve Pi command order", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "my-skill", description: "First", path: skillFile, baseDir: skillDir }),
      skillCommand({ name: "my-skill", description: "Second", path: skillFile, baseDir: skillDir }),
    ]);

    assert.equal(registry.get("my-skill")?.description, "First");
  });

  it("skips malformed skill command entries", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "missing", path: join(tmpDir, "missing.md") }),
      { ...skillCommand({ name: "bad", path: tmpDir }), name: "bad" },
    ]);

    assert.equal(registry.size, 0);
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

  it("parses boolean values", () => {
    const { frontmatter } = parseFrontmatter(
      "---\ndisable-model-invocation: true\n---\n\nBody",
    );
    assert.equal(frontmatter?.["disable-model-invocation"], true);
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

describe("formatSkillTable", () => {
  it("formats registered skills with $ syntax", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "my-skill", description: "My test skill", path: skillFile, baseDir: skillDir }),
    ]);

    assert.match(formatSkillTable(registry), /\$my-skill\s+My test skill/);
  });
});
