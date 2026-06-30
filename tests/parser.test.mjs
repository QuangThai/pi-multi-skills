/**
 * Tests for multi-skills parser.
 *
 * Run with: node --test tests/parser.test.mjs
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Inline the parser logic for testing (avoids ESM/CJS interop issues).
// The regex is case-insensitive, so $PATH, $HOME, etc. ARE matched as
// skill references (looking up "path", "home" in registry).

const RE_SKILL = new RegExp("(?<!\\\\)\\$([a-z][a-z0-9_-]*)", "gi");

function parseSkillRefs(text) {
  const refs = [];
  RE_SKILL.lastIndex = 0;
  let m;
  while ((m = RE_SKILL.exec(text)) !== null) {
    refs.push({ raw: m[0], name: m[1].toLowerCase(), index: m.index });
  }
  const seen = new Set();
  return refs.filter((r) => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
}

function replaceSkillRefs(text, replacements) {
  const sorted = [...replacements].sort((a, b) => b.name.length - a.name.length);
  let result = text;
  for (const { name, marker } of sorted) {
    const re = new RegExp(
      "(?<!\\\\)\\$" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b",
      "gi",
    );
    result = result.replace(re, marker);
  }
  result = result.replace(/\\\$/g, "$");
  return result;
}

// ────────────────────────────────────────────────────────────────

describe("parseSkillRefs", () => {
  it("finds single skill reference", () => {
    const refs = parseSkillRefs("Dung $code-review");
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, "code-review");
  });

  it("finds multiple skill references", () => {
    const refs = parseSkillRefs("Dung $skillA va $skillB");
    assert.equal(refs.length, 2);
    assert.equal(refs[0].name, "skilla");
    assert.equal(refs[1].name, "skillb");
  });

  it("returns empty for plain text", () => {
    assert.equal(parseSkillRefs("Chi la text binh thuong").length, 0);
  });

  it("skips escaped dollar", () => {
    const refs = parseSkillRefs("Dung \\$code-review");
    assert.equal(refs.length, 0);
  });

  it("deduplicates same skill", () => {
    const refs = parseSkillRefs("Dung $skillA va $skillA");
    assert.equal(refs.length, 1);
  });

  it("ignores $ followed by digit (not a letter)", () => {
    const refs = parseSkillRefs("Gia $100");
    assert.equal(refs.length, 0);
  });

  it("matches $ followed by uppercase (case-insensitive)", () => {
    // The regex has /gi flag so $PATH matches and looks up skill "path"
    const refs = parseSkillRefs("Duong dan $PATH");
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, "path");
  });

  it("handles $ at start of line", () => {
    const refs = parseSkillRefs("$skillA la tot");
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, "skilla");
  });

  it("handles $ with trailing punctuation", () => {
    const refs = parseSkillRefs("Dung $skillA, $skillB.");
    assert.equal(refs.length, 2);
  });

  it("handles empty string", () => {
    assert.equal(parseSkillRefs("").length, 0);
  });
});

// ────────────────────────────────────────────────────────────────

describe("replaceSkillRefs", () => {
  it("replaces single skill", () => {
    const result = replaceSkillRefs("Dung $code-review", [
      { name: "code-review", marker: "[skill: code-review]" },
    ]);
    assert.equal(result, "Dung [skill: code-review]");
  });

  it("replaces multiple skills", () => {
    const result = replaceSkillRefs("Dung $skillA va $skillB", [
      { name: "skilla", marker: "[skill: skillA]" },
      { name: "skillb", marker: "[skill: skillB]" },
    ]);
    assert.equal(result, "Dung [skill: skillA] va [skill: skillB]");
  });

  it("handles overlapping names (longest first)", () => {
    const result = replaceSkillRefs("Dung $code-review va $code", [
      { name: "code", marker: "[skill: code]" },
      { name: "code-review", marker: "[skill: code-review]" },
    ]);
    // $code-review must NOT become [skill: code]-review
    assert.equal(result, "Dung [skill: code-review] va [skill: code]");
  });

  it("preserves escaped dollar", () => {
    const result = replaceSkillRefs("Dung \\$skillA", [
      { name: "skilla", marker: "[skill: skillA]" },
    ]);
    assert.equal(result, "Dung $skillA");
  });

  it("returns original text when no replacements", () => {
    const result = replaceSkillRefs("Chi la text", []);
    assert.equal(result, "Chi la text");
  });

  it("replaces multiple occurrences of same skill", () => {
    const result = replaceSkillRefs("$code $code", [
      { name: "code", marker: "[skill: code]" },
    ]);
    assert.equal(result, "[skill: code] [skill: code]");
  });
});
