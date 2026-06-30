/**
 * Tests for multi-skills parser.
 *
 * Run with: npm test
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { parseSkillRefs, replaceSkillRefs } from "../parser.ts";

// ────────────────────────────────────────────────────────────────

describe("parseSkillRefs", () => {
  it("finds single skill reference", () => {
    const refs = parseSkillRefs("Use $code-review");
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, "code-review");
  });

  it("finds multiple lowercase skill references", () => {
    const refs = parseSkillRefs("Use $skilla and $skillb");
    assert.equal(refs.length, 2);
    assert.equal(refs[0].name, "skilla");
    assert.equal(refs[1].name, "skillb");
  });

  it("returns empty for plain text", () => {
    assert.equal(parseSkillRefs("Just normal text").length, 0);
  });

  it("skips escaped dollar", () => {
    const refs = parseSkillRefs("Use \\$code-review");
    assert.equal(refs.length, 0);
  });

  it("deduplicates same skill", () => {
    const refs = parseSkillRefs("Use $skilla and $skilla");
    assert.equal(refs.length, 1);
  });

  it("ignores $ followed by digit (not a letter)", () => {
    const refs = parseSkillRefs("Price $100");
    assert.equal(refs.length, 0);
  });

  it("ignores uppercase shell-style variables", () => {
    const refs = parseSkillRefs("Path $PATH and $HOME");
    assert.equal(refs.length, 0);
  });

  it("handles $ at start of line", () => {
    const refs = parseSkillRefs("$skilla is good");
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, "skilla");
  });

  it("handles $ with trailing punctuation", () => {
    const refs = parseSkillRefs("Use $skilla, $skillb.");
    assert.equal(refs.length, 2);
  });

  it("ignores mixed-case skill-like tokens instead of partially matching them", () => {
    assert.equal(parseSkillRefs("Use $skillA").length, 0);
  });

  it("handles empty string", () => {
    assert.equal(parseSkillRefs("").length, 0);
  });
});

// ────────────────────────────────────────────────────────────────

describe("replaceSkillRefs", () => {
  it("replaces single skill", () => {
    const result = replaceSkillRefs("Use $code-review", [
      { name: "code-review", marker: "[skill: code-review]" },
    ]);
    assert.equal(result, "Use [skill: code-review]");
  });

  it("does not replace uppercase variants", () => {
    const result = replaceSkillRefs("Use $skillA and $skillB", [
      { name: "skilla", marker: "[skill: skillA]" },
      { name: "skillb", marker: "[skill: skillB]" },
    ]);
    assert.equal(result, "Use $skillA and $skillB");
  });

  it("replaces multiple lowercase skills", () => {
    const result = replaceSkillRefs("Use $skilla and $skillb", [
      { name: "skilla", marker: "[skill: skillA]" },
      { name: "skillb", marker: "[skill: skillB]" },
    ]);
    assert.equal(result, "Use [skill: skillA] and [skill: skillB]");
  });

  it("handles overlapping names (longest first)", () => {
    const result = replaceSkillRefs("Use $code-review and $code", [
      { name: "code", marker: "[skill: code]" },
      { name: "code-review", marker: "[skill: code-review]" },
    ]);
    assert.equal(result, "Use [skill: code-review] and [skill: code]");
  });

  it("preserves escaped dollar", () => {
    const result = replaceSkillRefs("Use \\$skillA", [
      { name: "skilla", marker: "[skill: skillA]" },
    ]);
    assert.equal(result, "Use $skillA");
  });

  it("returns original text when no replacements", () => {
    const result = replaceSkillRefs("Just text", []);
    assert.equal(result, "Just text");
  });

  it("replaces multiple occurrences of same skill", () => {
    const result = replaceSkillRefs("$code $code", [
      { name: "code", marker: "[skill: code]" },
    ]);
    assert.equal(result, "[skill: code] [skill: code]");
  });
});
