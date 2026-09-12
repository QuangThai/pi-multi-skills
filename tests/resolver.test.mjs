import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { buildSkillRegistry, formatSkillTable } from "../resolver.ts";

function skillCommand({
  name,
  description = "Test skill",
  path,
  baseDir,
  scope = "user",
}) {
  return {
    name: `skill:${name}`,
    description,
    source: "skill",
    sourceInfo: {
      path,
      source: "local",
      scope,
      origin: "top-level",
      ...(baseDir ? { baseDir } : {}),
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

describe("buildSkillRegistry", () => {
  it("uses Pi's canonical file and base-directory metadata", () => {
    const file = join("root", "my-skill", "SKILL.md");
    const baseDir = join("root", "my-skill");
    const registry = buildSkillRegistry([
      extensionCommand(),
      skillCommand({
        name: "my-skill",
        description: "My test skill",
        path: file,
        baseDir,
      }),
    ]);

    assert.equal(registry.size, 1);
    assert.deepEqual(registry.get("my-skill"), {
      name: "my-skill",
      description: "My test skill",
      dir: baseDir,
      skillMdPath: file,
    });
  });

  it("supports older/synthetic directory paths without filesystem I/O", () => {
    const directory = join("root", "directory-skill");
    const registry = buildSkillRegistry([
      skillCommand({ name: "directory-skill", path: directory, baseDir: directory }),
    ]);
    assert.equal(
      registry.get("directory-skill")?.skillMdPath,
      join(directory, "SKILL.md"),
    );
  });

  it("derives a base directory when sourceInfo.baseDir is absent", () => {
    const file = join("root", "flat-skill.md");
    const registry = buildSkillRegistry([
      skillCommand({ name: "flat-skill", path: file, scope: "project" }),
    ]);
    const skill = registry.get("flat-skill");
    assert.equal(skill?.dir, "root");
  });

  it("keeps missing files for lazy invocation-time error reporting", () => {
    const missing = join("does-not-exist", "SKILL.md");
    const registry = buildSkillRegistry([
      skillCommand({ name: "missing", path: missing }),
    ]);
    assert.equal(registry.get("missing")?.skillMdPath, missing);
  });

  it("keeps Pi's first command when names collide", () => {
    const registry = buildSkillRegistry([
      skillCommand({ name: "same", description: "First", path: "first.md" }),
      skillCommand({ name: "same", description: "Second", path: "second.md" }),
    ]);
    assert.equal(registry.get("same")?.description, "First");
  });

  it("skips non-skill and malformed commands", () => {
    const registry = buildSkillRegistry([
      extensionCommand(),
      { ...skillCommand({ name: "bad-name", path: "bad.md" }), name: "bad-name" },
      skillCommand({ name: "", path: "empty.md" }),
      skillCommand({ name: "missing-path", path: "" }),
    ]);
    assert.equal(registry.size, 0);
  });
});

describe("formatSkillTable", () => {
  it("formats skill syntax and truncates long descriptions", () => {
    const registry = buildSkillRegistry([
      skillCommand({
        name: "my-skill",
        description: "x".repeat(80),
        path: "my-skill.md",
      }),
    ]);
    const table = formatSkillTable(registry);
    assert.match(table, /^  \$my-skill\s+x{60}\.\.\.$/);
  });
});
