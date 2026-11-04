/**
 * A model for Edit with AI tests: it rewrites each passage it is sent as the test says, streamed
 * a few characters at a time, and records what each request asked.
 */
import { MockLanguageModelV4 } from "ai/test";
import type { EditWithAiInput } from "../../src/core";
import type { MindClient } from "./mindClient";
import { readMind } from "./minds";
import { streamedReply } from "./models";

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** What an Edit with AI request asked: the passage, the action, the whole prompt and the instructions. */
export interface EditCall {
  passage: string;
  action: string;
  prompt: string;
  system: string;
}

type Prompt = MockLanguageModelV4["doStreamCalls"][number]["prompt"];

/** The text of a prompt's messages of one role. */
export const textOf = (prompt: Prompt, role: "user" | "system") =>
  prompt
    .filter((message) => message.role === role)
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .join("\n");

/**
 * A model that rewrites each passage with `edit`, streamed a few characters at a time; automatic
 * tagging gets no Tags. `finished: "length"`: each reply ends at its output limit, cut off.
 */
export function editingModel(
  edit: (call: EditCall) => string | Promise<string>,
  calls: EditCall[] = [],
  { finished = "stop", chunkSize = 4 }: { finished?: "stop" | "length"; chunkSize?: number } = {},
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ tags: [] }) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
    doStream: async ({ prompt, abortSignal }) => {
      const text = textOf(prompt, "user");
      const call = {
        passage: /<passage>\n([\s\S]*?)\n<\/passage>/.exec(text)?.[1] ?? "",
        action: /<task action="([^"]+)">/.exec(text)?.[1] ?? "",
        prompt: text,
        system: textOf(prompt, "system"),
      };
      calls.push(call);
      return { stream: streamedReply(await edit(call), abortSignal, { finished, chunkSize }) };
    },
  });
}

let requests = 0;

/** The editor's reading of a paragraph's text (an inline node as U+FFFC), for `EditWithAiInput.text`. */
export function plainOf(client: MindClient, blockId: string): string {
  let found = "";
  readMind(client).descendants((node) => {
    if (node.attrs.id !== blockId) return true;
    // An inline node is one character, a footnote's text none: what it holds isn't the paragraph's.
    node.forEach((child) => {
      found += child.isText ? (child.text ?? "") : "￼";
    });
    return false;
  });
  return found;
}

/** Edit with AI over all of the Mind's text, in the User's own words. */
export function wholeMind(
  client: MindClient,
  mindId: string,
  instruction: string,
): EditWithAiInput {
  const blocks: { id: string; size: number }[] = [];
  readMind(client).descendants((node) => {
    if (!node.isTextblock) return true;
    blocks.push({ id: String(node.attrs.id), size: node.content.size });
    return false;
  });
  const first = blocks[0] as { id: string };
  const last = blocks.at(-1) as { id: string; size: number };
  return {
    requestId: `whole-edit-${++requests}`,
    mindId,
    from: { blockId: first.id, offset: 0 },
    to: { blockId: last.id, offset: last.size },
    text: blocks.map((block) => plainOf(client, block.id)).join("\n"),
    action: "instruction",
    instruction,
  };
}

/** Edit with AI over the whole of one paragraph. */
export function wholeParagraph(
  client: MindClient,
  mindId: string,
  blockId: string,
  action: EditWithAiInput["action"],
  instruction?: string,
): EditWithAiInput {
  const plain = plainOf(client, blockId);
  return {
    requestId: `paragraph-edit-${++requests}`,
    mindId,
    from: { blockId, offset: 0 },
    to: { blockId, offset: plain.length },
    text: plain,
    action,
    ...(instruction !== undefined && { instruction }),
  };
}
