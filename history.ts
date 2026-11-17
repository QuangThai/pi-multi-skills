import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const SNAPSHOT_TYPE = "multi-skills:prompt-v1";

interface Snapshot {
  timestamp: number;
  original: string;
  expanded: string;
}

function isSnapshot(data: unknown): data is Snapshot {
  if (!data || typeof data !== "object") return false;
  const value = data as Partial<Snapshot>;
  return typeof value.timestamp === "number" &&
    typeof value.original === "string" && typeof value.expanded === "string";
}

function userText(message: AgentMessage): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  // Pi constructs prompts with one text block followed by any image blocks.
  const texts = message.content.filter((block) => block.type === "text");
  return texts.length === 1 ? texts[0]!.text : undefined;
}

function withText(message: AgentMessage, text: string): AgentMessage {
  if (message.role !== "user") return message;
  return {
    ...message,
    content: typeof message.content === "string" ? text : message.content.map(
      (block) => block.type === "text" ? { ...block, text } : block,
    ),
  };
}

function savedPrompts(entries: readonly SessionEntry[]): Map<string, string> {
  const saved = new Map<string, string>();
  let snapshot: Snapshot | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === SNAPSHOT_TYPE && isSnapshot(entry.data)) {
      snapshot = entry.data;
    } else if (entry.type === "message" && entry.message.role === "user") {
      const text = userText(entry.message);
      if (snapshot && snapshot.timestamp === entry.message.timestamp && text !== undefined) {
        const start = text.indexOf(snapshot.original);
        // Preserve later message_end handlers' prefixes/suffixes too. Do not
        // guess if another extension rewrites or duplicates the original.
        if (start >= 0 && start === text.lastIndexOf(snapshot.original)) {
          saved.set(entry.id, text.replace(snapshot.original, () => snapshot!.expanded));
        }
      }
      snapshot = undefined;
    }
  }
  return saved;
}

/** Keep editor history literal while projecting immutable expansions to the model. */
export function registerPromptHistory(pi: ExtensionAPI): (original: string, expanded: string) => string {
  let pending: { original: string; expanded: string; marked: string }[] = [];

  const project = (messages: AgentMessage[], entries: readonly SessionEntry[]): AgentMessage[] => {
    const saved = savedPrompts(entries);
    // Include unexpanded user entries when aligning the model's suffix. This
    // prevents an identical extension-sourced message from stealing a snapshot.
    const available = entries.filter((entry) => entry.type === "message" && entry.message.role === "user").reverse();
    return [...messages].reverse().map((message) => {
      const text = userText(message);
      if (text === undefined) return message;
      const index = available.findIndex((entry) => entry.type === "message" &&
        entry.message.timestamp === message.timestamp && userText(entry.message) === text
      );
      if (index < 0) return message;
      const [entry] = available.splice(index, 1);
      const expanded = saved.get(entry!.id);
      return expanded === undefined ? message : withText(message, expanded);
    }).reverse();
  };

  pi.on("session_start", () => { pending = []; });
  pi.on("session_shutdown", () => { pending = []; });

  pi.on("message_end", (event) => {
    const text = userText(event.message);
    if (text === undefined) return;
    // A per-submission marker prevents cancelled inputs and identical queued
    // prompts from claiming a different message. It never reaches the model.
    // Preserve prefixes/suffixes added by other input handlers; fail closed if
    // another handler rewrites or duplicates our marked expansion.
    const index = pending.findIndex(({ marked }) => {
      const start = text.indexOf(marked);
      return start >= 0 && start === text.lastIndexOf(marked);
    });
    if (index < 0) return;
    const [prompt] = pending.splice(index, 1);
    const original = text.replace(prompt!.marked, () => prompt!.original);
    pi.appendEntry(SNAPSHOT_TYPE, {
      timestamp: event.message.timestamp,
      original,
      expanded: text.replace(prompt!.marked, () => prompt!.expanded),
    } satisfies Snapshot);
    return { message: withText(event.message, original) };
  });

  pi.on("context", (event, ctx) => ({
    messages: project(event.messages, ctx.sessionManager.getBranch()),
  }));

  pi.on("session_before_compact", (event) => {
    const preparation = event.preparation;
    const count = preparation.messagesToSummarize.length;
    const keptIndex = event.branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
    // Retained messages are not summarized. Exclude them from matching so an
    // identical later prompt cannot supply the snapshot for an earlier one.
    const summarizedEntries = keptIndex < 0 ? event.branchEntries : event.branchEntries.slice(0, keptIndex);
    const projected = project([
      ...preparation.messagesToSummarize, ...preparation.turnPrefixMessages,
    ], summarizedEntries);
    preparation.messagesToSummarize = projected.slice(0, count);
    preparation.turnPrefixMessages = projected.slice(count);
  });

  pi.on("session_before_tree", (event, ctx: ExtensionContext) => {
    const saved = savedPrompts(ctx.sessionManager.getBranch());
    // Summary entries expose stable IDs, so even a partial branch with repeated
    // timestamps/text can be projected without guessing message identity.
    const projectedEntries = event.preparation.entriesToSummarize.map((entry) => {
      const expanded = saved.get(entry.id);
      return entry.type === "message" && expanded !== undefined
        ? { ...entry, message: withText(entry.message, expanded) } : entry;
    });
    event.preparation.entriesToSummarize.splice(0, projectedEntries.length, ...projectedEntries);
  });

  return (original, expanded) => {
    // Keep the marker inside the native collapsed skill block, not in the
    // visible prompt. message_end removes it before persistence and requests.
    const marked = expanded.replace("\n", `\n<!-- multi-skills:${randomUUID()} -->\n`);
    pending.push({ original, expanded, marked });
    return marked;
  };
}
