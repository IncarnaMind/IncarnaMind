import { MockLanguageModelV4 } from "ai/test";

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const textOf = (options: CallOptions) =>
  options.prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");

export type ScriptedChat = ReturnType<typeof scriptedChat>;

/**
 * A chat model for automatic tagging and Organize together: it tags every Document "Report",
 * files it in the first Folder offered, and records each request. `hold` keeps its answers
 * back until `release`; `fail` makes the requests that follow throw, `failNext` only the next.
 */
export function scriptedChat() {
  const calls: { purpose: "tags" | "organize"; text: string }[] = [];
  let organizeTags: string[] = [];
  let gate: Promise<void> | null = null;
  let open = () => {};
  let failure: Error | null = null;
  const failures: Error[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const schema =
        options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;
      const group = (schema as { properties?: { groupId?: { enum: string[] } } } | undefined)
        ?.properties?.groupId;
      calls.push({ purpose: group ? "organize" : "tags", text: textOf(options) });
      if (gate) await gate;
      if (failure) throw failure;
      const once = failures.shift();
      if (once) throw once;
      const reply = group ? { groupId: group.enum[0], tags: organizeTags } : { tags: ["Report"] };
      return {
        content: [{ type: "text", text: JSON.stringify(reply) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return {
    model,
    calls,
    purposesFor: (text: string) =>
      calls.filter((call) => call.text.includes(text)).map((call) => call.purpose),
    /** The Tags, by id, that Organize gives each Document. */
    organizeTags(ids: string[]) {
      organizeTags = ids;
    },
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
    fail(error: Error | null) {
      failure = error;
    },
    failNext(error: Error) {
      failures.push(error);
    },
  };
}
