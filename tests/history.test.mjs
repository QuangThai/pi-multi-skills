import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerPromptHistory } from "../history.ts";

function harness(manager = SessionManager.inMemory()) {
  const handlers = new Map();
  const remember = registerPromptHistory({
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(type, data) { manager.appendCustomEntry(type, data); },
  });
  const ctx = { sessionManager: manager };
  const dispatch = (name, event) => handlers.get(name)(event, ctx);
  const finish = (text, timestamp = 1, content = text) => {
    const message = { role: "user", content, timestamp };
    const result = dispatch("message_end", { message });
    const stored = result?.message ?? message;
    const id = manager.appendMessage(stored);
    return { stored, id };
  };
  const project = (messages = manager.buildSessionContext().messages) =>
    dispatch("context", { messages }).messages;
  return { manager, remember, dispatch, finish, project };
}
const expansion = (body = "Instructions", suffix = "`$a`") =>
  `<skill name="a" location="/a/SKILL.md">\n${body}\n</skill>\n\n${suffix}`;
const textOf = (message) => typeof message.content === "string"
  ? message.content : message.content.find((block) => block.type === "text").text;

describe("literal prompt history and model snapshots", () => {
  it("stores the exact original while projecting a marker-free expansion without mutating history", () => {
    const h = harness();
    const raw = "  Use $a\n\n> keep  **Markdown** and \\$a\n";
    const expanded = expansion("Original body", "Use `$a` and $a");
    const marked = h.remember(raw, expanded);
    assert.match(marked, /<!-- multi-skills:/);
    const { stored } = h.finish(marked);
    assert.equal(stored.content, raw);
    const before = structuredClone(h.manager.getEntries());
    assert.equal(textOf(h.project()[0]), expanded);
    assert.deepEqual(h.manager.getEntries(), before);
    assert.equal(stored.content, raw);
  });

  it("preserves RPC images and all non-text properties", () => {
    const h = harness();
    const marked = h.remember("$a", expansion());
    const image = { type: "image", mimeType: "image/png", data: "AAAA" };
    const { stored } = h.finish(marked, 42, [{ type: "text", text: marked }, image]);
    assert.equal(textOf(stored), "$a");
    assert.equal(stored.content[1], image);
    const model = h.project()[0];
    assert.equal(textOf(model), expansion());
    assert.equal(model.content[1], image);
    assert.equal(model.timestamp, 42);
  });

  it("associates identical queued prompts by submission, even when delivered out of order", () => {
    const h = harness();
    const first = h.remember("$a", expansion("First snapshot"));
    const second = h.remember("$a", expansion("Second snapshot"));
    h.finish(second, 10);
    h.finish(first, 10);
    const messages = h.project();
    assert.match(textOf(messages[0]), /Second snapshot/);
    assert.match(textOf(messages[1]), /First snapshot/);
    assert.match(textOf(h.project([h.manager.buildSessionContext().messages[1]])[0]), /First snapshot/);
  });

  it("cannot claim a cancelled input or an extension message with identical expanded text", () => {
    const h = harness();
    h.remember("$a", expansion()); // another input handler consumes this submission
    const unmarked = h.finish(expansion());
    assert.equal(unmarked.stored.content, expansion());
    const marked = h.remember("new $a", expansion());
    assert.equal(h.finish(marked).stored.content, "new $a");
  });

  it("preserves other input transforms and does not guess after incompatible rewrites", () => {
    const h = harness();
    const marked = h.remember("$a", expansion());
    const { stored } = h.finish(`PREFIX\n${marked}\nSUFFIX`);
    assert.equal(stored.content, "PREFIX\n$a\nSUFFIX");
    assert.equal(textOf(h.project()[0]), `PREFIX\n${expansion()}\nSUFFIX`);
    const changed = h.remember("$a", expansion()).replace("Instructions", "Changed");
    assert.equal(h.finish(changed).stored.content, changed);
    const duplicated = h.remember("$a", expansion());
    assert.equal(h.finish(duplicated + duplicated).stored.content, duplicated + duplicated);
  });

  it("retains later message_end prefixes and does not expand an identical unrelated message", () => {
    const h = harness();
    const marked = h.remember("$a", expansion("Saved"));
    const result = h.dispatch("message_end", { message: { role: "user", content: marked, timestamp: 1 } });
    h.manager.appendMessage({ ...result.message, content: `PREFIX\n${result.message.content}\nSUFFIX` });
    h.finish("PREFIX\n$a\nSUFFIX", 1);
    const projected = h.project();
    assert.equal(textOf(projected[0]), `PREFIX\n${expansion("Saved")}\nSUFFIX`);
    assert.equal(textOf(projected[1]), "PREFIX\n$a\nSUFFIX");
  });

  it("projects repeated prompts across split summaries and exact branch entry IDs", () => {
    const h = harness();
    const first = h.finish(h.remember("$a", expansion("FIRST")), 1);
    h.finish(h.remember("$a", expansion("SECOND")), 1);
    const messages = h.manager.buildSessionContext().messages;
    const preparation = { messagesToSummarize: [messages[0]], turnPrefixMessages: [messages[1]] };
    h.dispatch("session_before_compact", { preparation, branchEntries: h.manager.getBranch() });
    assert.match(textOf(preparation.messagesToSummarize[0]), /FIRST/);
    assert.match(textOf(preparation.turnPrefixMessages[0]), /SECOND/);
    const entriesToSummarize = [h.manager.getEntry(first.id)];
    h.dispatch("session_before_tree", { preparation: { entriesToSummarize } });
    assert.match(textOf(entriesToSummarize[0].message), /FIRST/);
  });

  it("excludes retained prompts from compaction snapshot matching", () => {
    for (const expandRetained of [true, false]) {
      const h = harness();
      h.finish(h.remember("$a", expansion("FIRST")), 1);
      const kept = expandRetained ? h.finish(h.remember("$a", expansion("SECOND")), 1) : h.finish("$a", 1);
      const preparation = {
        firstKeptEntryId: kept.id,
        messagesToSummarize: [h.manager.buildSessionContext().messages[0]],
        turnPrefixMessages: [],
      };
      h.dispatch("session_before_compact", { preparation, branchEntries: h.manager.getBranch() });
      assert.match(textOf(preparation.messagesToSummarize[0]), /FIRST/);
    }
  });

  it("ignores plain, legacy, assistant, multi-text and malformed metadata messages", () => {
    const h = harness();
    for (const data of [null, false, {}, { timestamp: 1, original: "$a", expanded: 3 }]) {
      h.manager.appendCustomEntry("multi-skills:prompt-v1", data);
    }
    h.manager.appendCustomEntry("other-extension", { timestamp: 1, original: "$a", expanded: "WRONG" });
    const legacy = h.finish(expansion());
    h.finish("plain");
    const assistant = { role: "assistant", timestamp: 1, content: [] };
    assert.equal(h.dispatch("message_end", { message: assistant }), undefined);
    const multiText = [{ type: "text", text: "$a" }, { type: "text", text: "more" }];
    assert.equal(h.finish("", 1, multiText).stored.content, multiText);
    assert.equal(textOf(h.project()[0]), legacy.stored.content);
    assert.equal(h.project([assistant])[0], assistant);
  });

  it("clears undelivered submissions on session start and shutdown", () => {
    for (const lifecycle of ["session_start", "session_shutdown"]) {
      const h = harness();
      const marked = h.remember("$a", expansion());
      h.dispatch(lifecycle, {});
      assert.equal(h.finish(marked).stored.content, marked);
    }
  });

  it("restores snapshots in a new runtime without reading the skill file", () => {
    const first = harness();
    first.finish(first.remember("$a", expansion("Saved body")));
    const resumed = harness(first.manager);
    resumed.dispatch("session_start", {});
    assert.match(textOf(resumed.project()[0]), /Saved body/);
    const beforeId = resumed.manager.getLeafId();
    const newPrompt = resumed.remember("$a", expansion("New body"));
    resumed.finish(newPrompt, 2);
    assert.match(textOf(resumed.project()[1]), /New body/);
    resumed.manager.branch(beforeId);
    assert.equal(resumed.project().length, 1);
    assert.match(textOf(resumed.project()[0]), /Saved body/);
  });

  it("projects saved expansions into compaction and branch-summary preparation copies", () => {
    const h = harness();
    h.finish(h.remember("$a", expansion("Summary instructions")));
    const messages = h.manager.buildSessionContext().messages;
    const before = structuredClone(h.manager.getEntries());
    const preparation = { messagesToSummarize: messages, turnPrefixMessages: [] };
    h.dispatch("session_before_compact", { preparation, branchEntries: h.manager.getBranch() });
    assert.match(textOf(preparation.messagesToSummarize[0]), /Summary instructions/);
    const prefixPreparation = { messagesToSummarize: [], turnPrefixMessages: messages };
    h.dispatch("session_before_compact", { preparation: prefixPreparation, branchEntries: h.manager.getBranch() });
    assert.match(textOf(prefixPreparation.turnPrefixMessages[0]), /Summary instructions/);
    const entriesToSummarize = [...h.manager.getBranch()];
    h.dispatch("session_before_tree", { preparation: { entriesToSummarize } });
    const projected = entriesToSummarize.find((entry) => entry.type === "message");
    assert.match(textOf(projected.message), /Summary instructions/);
    assert.deepEqual(h.manager.getEntries(), before);
  });
});
