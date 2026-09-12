import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  getSkillCompletionPrefix,
  parseSkillRefs,
  replaceSkillRefs,
} from "../parser.ts";

const known = (...names) => new Set(names);

describe("parseSkillRefs", () => {
  it("finds and deduplicates references in first-occurrence order", () => {
    const refs = parseSkillRefs("$skill-a then $skill-b and $skill-a");
    assert.deepEqual(refs.map(({ name }) => name), ["skill-a", "skill-b"]);
    assert.equal(refs[0].index, 0);
  });

  it("filters candidates against Pi's installed-skill registry", () => {
    const refs = parseSkillRefs("Price $100; shell $path; use $code-review", known("code-review"));
    assert.deepEqual(refs.map(({ name }) => name), ["code-review"]);
  });

  it("supports spec-valid names beginning with a digit", () => {
    const refs = parseSkillRefs("Use $3d-modeling", known("3d-modeling"));
    assert.deepEqual(refs.map(({ name }) => name), ["3d-modeling"]);
  });

  it("ignores uppercase and mixed-case shell-style variables", () => {
    assert.deepEqual(parseSkillRefs("$PATH $HOME $skillName"), []);
  });

  it("requires a token boundary before and after the reference", () => {
    assert.deepEqual(
      parseSkillRefs("email$skill foo_$skill café$skill 𐐀$skill $skill日本 $skill𐐀"),
      [],
    );
    assert.deepEqual(parseSkillRefs("($skill), [$other]").map(({ name }) => name), ["skill", "other"]);
  });

  it("skips escaped references but accepts dollars after an even slash run", () => {
    assert.deepEqual(parseSkillRefs("Use \\$code-review"), []);
    assert.deepEqual(
      parseSkillRefs("Use \\\\$code-review").map(({ name }) => name),
      ["code-review"],
    );
  });

  it("skips inline Markdown code without treating escaped backticks as delimiters", () => {
    const refs = parseSkillRefs("Use `$code-review`, \\` then $real-skill");
    assert.deepEqual(refs.map(({ name }) => name), ["real-skill"]);
  });

  it("skips backtick and tilde fenced Markdown code", () => {
    const text = [
      "```sh",
      "echo $code-review",
      "```",
      "$real-skill",
      "~~~php",
      "$another-skill",
      "~~~",
    ].join("\n");
    assert.deepEqual(parseSkillRefs(text).map(({ name }) => name), ["real-skill"]);
  });

  it("does not treat an invalid backtick fence opener as code", () => {
    const refs = parseSkillRefs("```bad`info```\n$skill-a");
    assert.deepEqual(refs.map(({ name }) => name), ["skill-a"]);
  });

  it("handles punctuation and an empty string", () => {
    assert.deepEqual(parseSkillRefs("Use $skill-a, $skill-b.").map(({ name }) => name), ["skill-a", "skill-b"]);
    assert.deepEqual(parseSkillRefs(""), []);
  });
});

describe("replaceSkillRefs", () => {
  it("replaces every known occurrence without changing whitespace", () => {
    const input = "Before\n\n  Use $code-review  here\nAfter";
    const result = replaceSkillRefs(input, [
      { name: "code-review", marker: "code-review" },
    ]);
    assert.equal(result, "Before\n\n  Use code-review  here\nAfter");
  });

  it("replaces overlapping names exactly", () => {
    const result = replaceSkillRefs("$code-review and $code", [
      { name: "code", marker: "code" },
      { name: "code-review", marker: "code-review" },
    ]);
    assert.equal(result, "code-review and code");
  });

  it("does not alter references inside Markdown code", () => {
    const input = "`$code-review`\n\n```sh\n$code-review\n```\n\nUse $code-review";
    const result = replaceSkillRefs(input, [
      { name: "code-review", marker: "code-review" },
    ]);
    assert.equal(result, "`$code-review`\n\n```sh\n$code-review\n```\n\nUse code-review");
  });

  it("unescapes only escaped references matching a transformed skill", () => {
    const input = "Price \\$100, path C:\\$Recycle.Bin, use $skill; literal \\$skill; keep `\\$inside`";
    assert.equal(
      replaceSkillRefs(input, [{ name: "skill", marker: "skill" }]),
      "Price \\$100, path C:\\$Recycle.Bin, use skill; literal $skill; keep `\\$inside`",
    );
    assert.equal(replaceSkillRefs("\\$skill", []), "\\$skill");
  });

  it("supports context-sensitive occurrence markers", () => {
    const result = replaceSkillRefs("$skill and `code`$skill", [
      {
        name: "skill",
        marker: (reference, source) => source[reference.index - 1] === "`"
          ? reference.raw
          : `<${reference.raw}>`,
      },
    ]);
    assert.equal(result, "<$skill> and `code`$skill");
  });

  it("leaves unknown and mixed-case references untouched", () => {
    const result = replaceSkillRefs("$known $unknown $skillName", [
      { name: "known", marker: "known" },
    ]);
    assert.equal(result, "known $unknown $skillName");
  });
});

describe("getSkillCompletionPrefix", () => {
  it("recognizes empty, partial, digit-leading, and punctuation-delimited triggers", () => {
    assert.equal(getSkillCompletionPrefix("Use $"), "");
    assert.equal(getSkillCompletionPrefix("Use $code-"), "code-");
    assert.equal(getSkillCompletionPrefix("($3d"), "3d");
  });

  it("rejects embedded, escaped, uppercase, and code triggers", () => {
    assert.equal(getSkillCompletionPrefix("email$code"), undefined);
    assert.equal(getSkillCompletionPrefix("Use \\$code"), undefined);
    assert.equal(getSkillCompletionPrefix("Use $CODE"), undefined);
    assert.equal(getSkillCompletionPrefix("Use `$code"), undefined);
    assert.equal(getSkillCompletionPrefix("```sh\n$code"), undefined);
  });
});
