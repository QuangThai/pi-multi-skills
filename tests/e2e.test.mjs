import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import multiSkillsExtension from "../index.ts";

const execFile = promisify(execFileCallback);

function skillCommand({
  name,
  path,
  baseDir,
  description = `Description for ${name}`,
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
      baseDir,
    },
  };
}

function createContext() {
  const notifications = [];
  const widgetCalls = [];
  const autocompleteFactories = [];
  const theme = { fg: (_color, text) => text };
  const ui = {
    theme,
    notify(message, level) {
      notifications.push({ message, level });
    },
    setWidget(key, content) {
      widgetCalls.push({ key, content });
    },
    addAutocompleteProvider(factory) {
      autocompleteFactories.push(factory);
    },
  };

  return {
    ctx: { ui },
    notifications,
    widgetCalls,
    autocompleteFactories,
  };
}

function createHarness(skillCommands) {
  const handlers = new Map();
  const commands = new Map();
  const metrics = { getCommandsCalls: 0 };
  const api = {
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    getCommands() {
      metrics.getCommandsCalls += 1;
      return skillCommands;
    },
  };

  multiSkillsExtension(api);

  return {
    commands,
    handlers,
    metrics,
    async dispatch(eventName, event, ctx) {
      let result;
      for (const handler of handlers.get(eventName) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

async function startHarness(skillCommands) {
  const harness = createHarness(skillCommands);
  const context = createContext();
  await harness.dispatch("session_start", { type: "session_start" }, context.ctx);
  return { ...harness, ...context };
}

async function submit(harness, ctx, text, overrides = {}) {
  return harness.dispatch(
    "input",
    {
      type: "input",
      text,
      source: "interactive",
      ...overrides,
    },
    ctx,
  );
}

function requireParsedSkill(result) {
  assert.equal(result?.action, "transform");
  const parsed = parseSkillBlock(result.text);
  assert.ok(parsed, "Pi's real parseSkillBlock must parse transformed output");
  return parsed;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let fixtureRoot;
let skillADir;
let skillAFile;
let skillBDir;
let skillBFile;
let digitSkillDir;
let digitSkillFile;

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "pi-multi-skills-e2e-"));

  skillADir = join(fixtureRoot, "skill-a");
  mkdirSync(skillADir);
  skillAFile = join(skillADir, "SKILL.md");
  writeFileSync(
    skillAFile,
    "---\nname: skill-a\ndescription: First skill\n---\n\n# Skill A\n\nRun `./scripts/a.js`.",
  );

  skillBDir = join(fixtureRoot, "skill-b");
  mkdirSync(skillBDir);
  skillBFile = join(skillBDir, "SKILL.md");
  writeFileSync(
    skillBFile,
    "---\nname: skill-b\ndescription: Second skill\n---\n\n# Skill B\n\nRun `./scripts/b.js`.",
  );

  digitSkillDir = join(fixtureRoot, "3d-modeling");
  mkdirSync(digitSkillDir);
  digitSkillFile = join(digitSkillDir, "SKILL.md");
  writeFileSync(
    digitSkillFile,
    "---\nname: 3d-modeling\ndescription: 3D skill\n---\n\n# 3D Modeling",
  );
});

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("Pi loader and runner E2E", () => {
  it("loads with Jiti and transforms through Pi's real event runner", async () => {
    const script = `
      import { resolve } from "node:path";
      import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
      const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
      const [{ loadExtensions }, { ExtensionRunner }] = await Promise.all([
        import(new URL("./core/extensions/loader.js", piEntry)),
        import(new URL("./core/extensions/runner.js", piEntry)),
      ]);
      const entryPath = resolve("index.ts");
      const loaded = await loadExtensions([entryPath], process.cwd());
      loaded.runtime.getCommands = () => [{
        name: "skill:skill-a",
        description: "First skill",
        source: "skill",
        sourceInfo: {
          path: process.env.E2E_SKILL_FILE,
          baseDir: process.env.E2E_SKILL_DIR,
          source: "local",
          scope: "temporary",
          origin: "top-level",
        },
      }];

      const uiCalls = [];
      const ui = {
        theme: { fg: (_color, text) => text },
        setWidget: (...args) => uiCalls.push(["widget", ...args]),
        addAutocompleteProvider: (factory) => uiCalls.push(["autocomplete", typeof factory]),
        notify: (...args) => uiCalls.push(["notify", ...args]),
      };
      const runner = new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        process.cwd(),
        {},
        {},
      );
      runner.setUIContext(ui, "interactive");
      await runner.emit({ type: "session_start", reason: "startup" });
      const result = await runner.emitInput(
        "Use $skill-a through Pi",
        undefined,
        "interactive",
      );
      const parsed = result.action === "transform"
        ? parseSkillBlock(result.text)
        : undefined;
      const extension = loaded.extensions[0];

      console.log(JSON.stringify({
        coverageDirectory: process.env.NODE_V8_COVERAGE,
        errors: loaded.errors,
        found: Boolean(extension),
        handlers: extension ? [...extension.handlers.keys()] : [],
        commands: extension ? [...extension.commands.keys()] : [],
        resultAction: result.action,
        parsed,
        uiCalls,
      }));
    `;
    const loaderCoverageDirectory = join(fixtureRoot, "loader-coverage");
    const childEnvironment = {
      ...process.env,
      E2E_SKILL_DIR: skillADir,
      E2E_SKILL_FILE: skillAFile,
      NODE_V8_COVERAGE: loaderCoverageDirectory,
    };
    delete childEnvironment.NODE_OPTIONS;
    const { stdout } = await execFile(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { cwd: process.cwd(), env: childEnvironment },
    );
    const smoke = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

    assert.equal(smoke.coverageDirectory, loaderCoverageDirectory);
    assert.deepEqual(smoke.errors, []);
    assert.equal(smoke.found, true);
    assert.ok(smoke.handlers.includes("session_start"));
    assert.ok(smoke.handlers.includes("input"));
    assert.ok(smoke.handlers.includes("turn_end"));
    assert.ok(smoke.commands.includes("skills"));
    assert.ok(smoke.commands.includes("skills-search"));
    assert.equal(smoke.resultAction, "transform");
    assert.equal(smoke.parsed.name, "skill-a");
    assert.equal(smoke.parsed.location, skillAFile);
    assert.match(smoke.parsed.content, /# Skill A/);
    assert.equal(smoke.parsed.userMessage, "Use skill-a through Pi");
    assert.ok(smoke.uiCalls.some(
      ([type, message]) => type === "notify" && message === "Loaded skills: $skill-a",
    ));
  });
});

describe("real input handler", () => {
  it("expands one skill into a block accepted by Pi", async () => {
    const runtime = await startHarness([
      skillCommand({ name: "skill-a", path: skillAFile, baseDir: skillADir }),
    ]);
    const result = await submit(runtime, runtime.ctx, "Use $skill-a please");
    const parsed = requireParsedSkill(result);

    assert.equal(parsed.name, "skill-a");
    assert.equal(parsed.location, skillAFile);
    assert.match(parsed.content, /# Skill A/);
    assert.match(parsed.content, new RegExp(`References are relative to ${escapeRegExp(skillADir)}`));
    assert.equal(parsed.userMessage, "Use skill-a please");
  });

  it("preserves multiline Markdown, indentation, blank lines, and repeated spaces", async () => {
    const runtime = await startHarness([
      skillCommand({ name: "skill-a", path: skillAFile, baseDir: skillADir }),
    ]);
    const input = [
      "Intro",
      "",
      "  ```ts",
      "  const first = 1;",
      "    const second = 2;",
      "  ```",
      "",
      "Use  $skill-a  exactly.",
      "",
      "Final paragraph.",
    ].join("\n");
    const expectedUserMessage = input.replace("$skill-a", "skill-a");

    const result = await submit(runtime, runtime.ctx, input);
    const parsed = requireParsedSkill(result);
    assert.equal(parsed.userMessage, expectedUserMessage);
  });

  it("keeps a separate relative-reference directory for every merged skill", async () => {
    const runtime = await startHarness([
      skillCommand({ name: "skill-a", path: skillAFile, baseDir: skillADir }),
      skillCommand({ name: "skill-b", path: skillBFile, baseDir: skillBDir }),
    ]);
    const result = await submit(runtime, runtime.ctx, "Run $skill-a then $skill-b");
    const parsed = requireParsedSkill(result);

    assert.equal(parsed.name, "skill-a, skill-b");
    assert.match(parsed.content, new RegExp(`Skill file: ${escapeRegExp(skillAFile)}`));
    assert.match(parsed.content, new RegExp(`relative to ${escapeRegExp(skillADir)}`));
    assert.match(parsed.content, new RegExp(`Skill file: ${escapeRegExp(skillBFile)}`));
    assert.match(parsed.content, new RegExp(`relative to ${escapeRegExp(skillBDir)}`));
    assert.match(parsed.content, /\.\/scripts\/a\.js/);
    assert.match(parsed.content, /\.\/scripts\/b\.js/);
    assert.equal(parsed.userMessage, "Run skill-a then skill-b");
    assert.equal(result.text.match(/<skill name=/g)?.length, 1);
  });

  it("loads successful skills only and leaves failed references unchanged", async () => {
    const missingFile = join(fixtureRoot, "missing", "SKILL.md");
    const runtime = await startHarness([
      skillCommand({ name: "skill-a", path: skillAFile, baseDir: skillADir }),
      skillCommand({ name: "missing-skill", path: missingFile, baseDir: join(fixtureRoot, "missing") }),
    ]);
    const result = await submit(runtime, runtime.ctx, "Use $skill-a and $missing-skill");
    const parsed = requireParsedSkill(result);

    assert.equal(parsed.name, "skill-a");
    assert.equal(parsed.userMessage, "Use skill-a and $missing-skill");
    assert.equal(runtime.notifications.filter(({ level }) => level === "error").length, 1);
    assert.match(runtime.notifications.at(-2)?.message ?? "", /Could not read skill file for \$missing-skill/);
    assert.deepEqual(runtime.widgetCalls.at(-1)?.content, ["Skills: $skill-a"]);
    assert.match(runtime.notifications.at(-1)?.message ?? "", /Loaded skills: \$skill-a/);
  });

  it("continues unchanged when every requested skill fails to load", async () => {
    const missingFile = join(fixtureRoot, "missing-all", "SKILL.md");
    const runtime = await startHarness([
      skillCommand({ name: "missing", path: missingFile, baseDir: join(fixtureRoot, "missing-all") }),
    ]);
    const result = await submit(runtime, runtime.ctx, "Use $missing exactly");

    assert.deepEqual(result, { action: "continue" });
    assert.match(runtime.notifications.at(-1)?.message ?? "", /Could not read skill file for \$missing/);
    assert.equal(runtime.widgetCalls.at(-1)?.content, undefined);
  });

  it("ignores unknown variables and skill-looking text in Markdown code", async () => {
    const runtime = await startHarness([
      skillCommand({ name: "skill-a", path: skillAFile, baseDir: skillADir }),
    ]);
    const input = "```sh\necho $skill-a $path\n```\n\nUnknown $not-installed";
    const result = await submit(runtime, runtime.ctx, input);

    assert.deepEqual(result, { action: "continue" });
    assert.equal(runtime.notifications.length, 0);
  });

  it("supports installed skill names beginning with a digit", async () => {
    const runtime = await startHarness([
      skillCommand({ name: "3d-modeling", path: digitSkillFile, baseDir: digitSkillDir }),
    ]);
    const parsed = requireParsedSkill(
      await submit(runtime, runtime.ctx, "Use $3d-modeling"),
    );
    assert.equal(parsed.name, "3d-modeling");
    assert.equal(parsed.userMessage, "Use 3d-modeling");
  });

  it("skips extension-injected input but supports RPC and preserves images", async () => {
    const runtime = await startHarness([
      skillCommand({ name: "skill-a", path: skillAFile, baseDir: skillADir }),
    ]);

    const extensionResult = await submit(runtime, runtime.ctx, "$skill-a", {
      source: "extension",
    });
    assert.deepEqual(extensionResult, { action: "continue" });

    const images = [{ type: "image", data: "abc", mimeType: "image/png" }];
    const rpcResult = await submit(runtime, runtime.ctx, "RPC $skill-a", {
      source: "rpc",
      images,
    });
    assert.equal(rpcResult?.action, "transform");
    assert.equal(rpcResult.images, images);
  });

  it("warns when aggregate skill instructions are unusually large", async () => {
    const directory = join(fixtureRoot, "large-skill");
    mkdirSync(directory);
    const file = join(directory, "SKILL.md");
    writeFileSync(
      file,
      `---\nname: large-skill\ndescription: Large\n---\n\n${"x".repeat(50_001)}`,
    );
    const runtime = await startHarness([
      skillCommand({ name: "large-skill", path: file, baseDir: directory }),
    ]);
    await submit(runtime, runtime.ctx, "$large-skill");
    assert.ok(runtime.notifications.some(
      ({ level, message }) => level === "warning" && message.includes("50,001"),
    ));
  });

  it("clears the transient skill widget when the turn ends", async () => {
    const runtime = await startHarness([
      skillCommand({ name: "skill-a", path: skillAFile, baseDir: skillADir }),
    ]);
    await submit(runtime, runtime.ctx, "$skill-a");
    assert.deepEqual(runtime.widgetCalls.at(-1)?.content, ["Skills: $skill-a"]);

    await runtime.dispatch("turn_end", { type: "turn_end" }, runtime.ctx);
    assert.equal(runtime.widgetCalls.at(-1)?.content, undefined);
  });
});

describe("real autocomplete provider and commands", () => {
  it("uses cached metadata, ranks prefix matches, and caps results", async () => {
    const commands = Array.from({ length: 25 }, (_, index) => skillCommand({
      name: `code-${String(index).padStart(2, "0")}`,
      path: join(fixtureRoot, `missing-${index}.md`),
      baseDir: fixtureRoot,
    }));
    commands.push(skillCommand({
      name: "my-code",
      path: join(fixtureRoot, "also-missing.md"),
      baseDir: fixtureRoot,
    }));

    const runtime = await startHarness(commands);
    const delegateResult = { prefix: "delegate", items: [] };
    const current = {
      async getSuggestions() {
        return delegateResult;
      },
      applyCompletion(lines, cursorLine, cursorCol) {
        return { lines, cursorLine, cursorCol };
      },
      shouldTriggerFileCompletion() {
        return true;
      },
    };
    const provider = runtime.autocompleteFactories[0](current);
    const line = "Use $code";
    const suggestions = await provider.getSuggestions(
      [line],
      0,
      line.length,
      { signal: new AbortController().signal },
    );

    assert.equal(suggestions.items.length, 20);
    assert.ok(suggestions.items.every(({ value }) => value.startsWith("$code-")));
    assert.equal(suggestions.prefix, "$code");
    assert.equal(runtime.metrics.getCommandsCalls, 1);

    const embedded = "email$code";
    assert.equal(
      await provider.getSuggestions(
        [embedded],
        0,
        embedded.length,
        { signal: new AbortController().signal },
      ),
      delegateResult,
    );
    assert.equal(
      await provider.getSuggestions(
        ["```sh", "$code"],
        1,
        5,
        { signal: new AbortController().signal },
      ),
      delegateResult,
    );
  });

  it("honors an aborted autocomplete request", async () => {
    const runtime = await startHarness([
      skillCommand({ name: "skill-a", path: skillAFile, baseDir: skillADir }),
    ]);
    const current = {
      async getSuggestions() {
        throw new Error("delegate should not run");
      },
      applyCompletion(lines, cursorLine, cursorCol) {
        return { lines, cursorLine, cursorCol };
      },
    };
    const provider = runtime.autocompleteFactories[0](current);
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await provider.getSuggestions(["$"], 0, 1, { signal: controller.signal }),
      null,
    );
  });

  it("delegates empty autocomplete results and completion behavior", async () => {
    const runtime = await startHarness([
      skillCommand({ name: "skill-a", path: skillAFile, baseDir: skillADir }),
    ]);
    const completion = { lines: ["completed"], cursorLine: 0, cursorCol: 9 };
    const delegateResult = { prefix: "delegate", items: [] };
    const current = {
      async getSuggestions() {
        return delegateResult;
      },
      applyCompletion() {
        return completion;
      },
      shouldTriggerFileCompletion() {
        return false;
      },
    };
    const provider = runtime.autocompleteFactories[0](current);

    assert.equal(
      await provider.getSuggestions(
        ["$not-found"],
        0,
        10,
        { signal: new AbortController().signal },
      ),
      delegateResult,
    );
    assert.equal(provider.applyCompletion(["$s"], 0, 2, {}, "$s"), completion);
    assert.equal(provider.shouldTriggerFileCompletion([""], 0, 0), false);
  });

  it("defaults file completion to enabled when the wrapped provider omits the hook", async () => {
    const runtime = await startHarness([]);
    const delegateResult = { prefix: "delegate", items: [] };
    const current = {
      async getSuggestions() {
        return delegateResult;
      },
      applyCompletion(lines, cursorLine, cursorCol) {
        return { lines, cursorLine, cursorCol };
      },
    };
    const provider = runtime.autocompleteFactories[0](current);

    assert.equal(provider.shouldTriggerFileCompletion([""], 0, 0), true);
    assert.equal(
      await provider.getSuggestions(
        ["$"],
        0,
        1,
        { signal: new AbortController().signal },
      ),
      delegateResult,
    );
  });

  it("handles empty list/search states and plain input", async () => {
    const runtime = await startHarness([]);

    await runtime.commands.get("skills").handler("", runtime.ctx);
    assert.deepEqual(runtime.notifications.at(-1), {
      message: "No skills found.",
      level: "warning",
    });

    await runtime.commands.get("skills-search").handler("   ", runtime.ctx);
    assert.match(runtime.notifications.at(-1)?.message ?? "", /Usage:/);

    await runtime.commands.get("skills-search").handler("absent", runtime.ctx);
    assert.match(runtime.notifications.at(-1)?.message ?? "", /No skills matching/);

    assert.deepEqual(
      await submit(runtime, runtime.ctx, "plain input"),
      { action: "continue" },
    );
    assert.equal(runtime.widgetCalls.at(-1)?.content, undefined);
  });

  it("lists and searches cached Pi metadata without reading skill bodies", async () => {
    const runtime = await startHarness([
      skillCommand({
        name: "missing-but-listed",
        path: join(fixtureRoot, "never-read.md"),
        baseDir: fixtureRoot,
        description: "Find this metadata",
      }),
    ]);

    await runtime.commands.get("skills").handler("", runtime.ctx);
    assert.match(runtime.notifications.at(-1)?.message ?? "", /\$missing-but-listed/);

    await runtime.commands.get("skills-search").handler("  metadata  ", runtime.ctx);
    assert.match(runtime.notifications.at(-1)?.message ?? "", /Skills matching "metadata"/);
  });
});
