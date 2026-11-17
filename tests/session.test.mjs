import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionRuntime,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import multiSkillsExtension from "../index.ts";

const textOf = (message) => typeof message.content === "string" ? message.content
  : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

it("real Pi sessions preserve literal prompts through tree, fork, resume and resubmission", async () => {
  const root = mkdtempSync(join(tmpdir(), "multi-skills-session-"));
  let runtime;
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const skills = ["a", "b"].map((name) => {
      const dir = join(root, name);
      mkdirSync(dir);
      const filePath = join(dir, "SKILL.md");
      writeFileSync(filePath, `---\nname: ${name}\ndescription: Test ${name}\n---\nSAVED ${name} instructions\n`);
      return { name, description: `Test ${name}`, filePath, baseDir: dir, source: "user", disableModelInvocation: false,
        sourceInfo: { path: filePath, baseDir: dir, source: "local", scope: "user", origin: "top-level" } };
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey("anthropic", "test-not-a-real-key");
    const model = modelRuntime.getModels("anthropic").find((candidate) => candidate.input.includes("image"));
    assert.ok(model);
    const requests = [];
    const errors = [];
    let holdNextStream;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [multiSkillsExtension, (pi) => {
          pi.on("input", (event) => event.text.includes("chain")
            ? { action: "transform", text: `INPUT\n${event.text}` } : undefined);
          pi.on("message_end", (event) => event.message.role === "user" && textOf(event.message).includes("chain")
            ? { message: { ...event.message, content: `END\n${textOf(event.message)}` } } : undefined);
        }],
        skillsOverride: () => ({ skills, diagnostics: [] }),
      });
      await loader.reload();
      const services = { cwd: root, agentDir, settingsManager, modelRuntime, resourceLoader: loader, diagnostics: [] };
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: [] });
      result.session.agent.streamFunction = (_model, context) => {
        requests.push(structuredClone(context));
        const stream = createAssistantMessageEventStream();
        const message = {
          role: "assistant", content: [{ type: "text", text: "OK" }],
          api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const finish = () => {
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        };
        const hold = holdNextStream;
        holdNextStream = undefined;
        if (hold) hold(finish);
        else finish();
        return stream;
      };
      return { ...result, services, diagnostics: [] };
    };
    runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: root, agentDir, sessionManager: SessionManager.create(root, join(root, "sessions")),
    });
    const bind = async (session) => session.bindExtensions({
      onError: (error) => errors.push(error),
      uiContext: { theme: { fg: (_color, text) => text }, setWidget() {}, notify() {}, addAutocompleteProvider() {} },
    });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    const raw = "Use $a  and $b\n\n> **keep** \\$a and `literal`\n";
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
    await runtime.session.prompt(raw, { source: "rpc", images: [image] });
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 1);
    const modelPrompt = textOf(requests[0].messages.find((message) => message.role === "user"));
    assert.match(modelPrompt, /SAVED a instructions/);
    assert.match(modelPrompt, /SAVED b instructions/);
    assert.ok(requests[0].messages.find((message) => message.role === "user").content.some((block) => block.type === "image"), JSON.stringify(requests[0].messages));
    assert.doesNotMatch(modelPrompt, /multi-skills:[0-9a-f]/);
    let users = runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
    assert.equal(textOf(users[0].message), raw);
    const originalFile = runtime.session.sessionFile;
    assert.equal(textOf(JSON.parse(readFileSync(originalFile, "utf8").split("\n").find((line) => {
      if (!line) return false;
      const entry = JSON.parse(line);
      return entry.type === "message" && entry.message.role === "user";
    })).message), raw);

    // Recreate all extension state from JSONL and change the files: old context
    // must retain submission-time instructions, not reload the changed bodies.
    for (const skill of skills) writeFileSync(skill.filePath, `CHANGED ${skill.name}`);
    await runtime.switchSession(originalFile);
    await runtime.session.prompt("Continue");
    const resumedPrompt = textOf(requests.at(-1).messages.find((message) => message.role === "user"));
    assert.equal(resumedPrompt, modelPrompt);

    users = runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
    const tree = await runtime.session.navigateTree(users[0].id);
    assert.equal(tree.editorText, raw);
    await runtime.session.prompt(tree.editorText);
    const resubmitted = textOf(requests.at(-1).messages.filter((message) => message.role === "user").at(-1));
    assert.match(resubmitted, /CHANGED a/);
    assert.equal((resubmitted.match(/<skill /g) ?? []).length, 1);

    users = runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
    const fork = await runtime.fork(users.at(-1).id, { position: "before" });
    assert.equal(fork.cancelled, false);
    assert.equal(fork.selectedText, raw);
    await runtime.session.prompt(fork.selectedText);
    assert.equal(textOf(runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").at(-1).message), raw);
    // Both input and message_end handlers registered after this extension must
    // retain their edits without preventing model-only skill projection.
    await runtime.session.prompt("$a chain");
    const chained = textOf(requests.at(-1).messages.filter((message) => message.role === "user").at(-1));
    assert.match(chained, /^END\nINPUT\n<skill /);
    assert.match(chained, /CHANGED a/);
    assert.equal(textOf(runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").at(-1).message), "END\nINPUT\n$a chain");

    // Hold a real provider request while submitting steering and follow-up
    // inputs. Each queued prompt must keep its own submission-time snapshot.
    let finishStream;
    const started = new Promise((resolve) => {
      holdNextStream = (finish) => { finishStream = finish; resolve(); };
    });
    const active = runtime.session.prompt("Hold");
    await started;
    writeFileSync(skills[0].filePath, "FIRST QUEUED SNAPSHOT");
    await runtime.session.prompt("$a queued", { streamingBehavior: "steer" });
    writeFileSync(skills[0].filePath, "SECOND QUEUED SNAPSHOT");
    await runtime.session.prompt("$a queued", { streamingBehavior: "followUp" });
    finishStream();
    await active;
    const queued = requests.at(-1).messages.filter((message) => message.role === "user" && textOf(message).includes("queued"));
    assert.equal(queued.length, 2);
    assert.match(textOf(queued[0]), /FIRST QUEUED SNAPSHOT/);
    assert.match(textOf(queued[1]), /SECOND QUEUED SNAPSHOT/);
    const savedQueued = runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user" && textOf(entry.message).includes("queued"));
    assert.deepEqual(savedQueued.map((entry) => textOf(entry.message)), ["$a queued", "$a queued"]);
    assert.deepEqual(errors, []);
  } finally {
    await runtime?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
