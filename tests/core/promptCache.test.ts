/**
 * Prompt caching (#343): Anthropic gets cache breakpoints on the stable parts
 * of a request and none on the new Question; every provider gets a prompt whose
 * start is the same from one Question of a conversation to the next; OpenAI gets
 * a cache key per conversation; and the cached tokens each provider reports are
 * recorded with the Answer's usage. The providers are the real AI SDK ones,
 * against a stand-in for `fetch` that records each request and replies as the
 * provider's API does (with the cache fields it reports).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type AnswerEngineEvent,
  type AnswerRequest,
  type AnswerTools,
  createAiSdkAnswerEngine,
} from "../../src/core/answers/engine";
import {
  answerInstructions,
  documentInstructions,
  languageInstruction,
} from "../../src/core/answers/prompt";
import type { ChatProviderKind } from "../../src/core/api";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { breakpointsOf, cacheProviderOptions } from "../../src/core/providers/promptCache";

type Json = Record<string, unknown>;

interface Captured {
  url: string;
  body: Json;
}

/** The cached share of every reply's input, and how much of it the provider says it wrote. */
const CACHED = 1_200;
const WRITTEN = 300;
const INPUT = 1_500;

const sse = (events: readonly object[], done = false) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } },
  );

/** What each provider's API says in reply to a streamed request, with its cache fields. */
const replies: Record<string, (text: string, cached: number) => Response> = {
  anthropic: (text, cached) =>
    sse([
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: INPUT - cached - WRITTEN,
            cache_creation_input_tokens: WRITTEN,
            cache_read_input_tokens: cached,
            output_tokens: 1,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]),
  openai: (text, cached) => {
    const item = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const response = {
      id: "resp_1",
      object: "response",
      created_at: 1_790_000_000,
      model: "gpt-5.4-nano",
      status: "completed",
      output: [item],
      usage: {
        input_tokens: INPUT,
        input_tokens_details: { cached_tokens: cached },
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: INPUT + 4,
      },
    };
    return sse([
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ]);
  },
  deepseek: (text, cached) => {
    const chunk = (delta: object, finish: string | null, usage?: object) => ({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1_790_000_000,
      model: "deepseek-chat",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage && { usage }),
    });
    return sse(
      [
        chunk({ role: "assistant", content: text }, null),
        chunk({}, "stop", {
          prompt_tokens: INPUT,
          completion_tokens: 4,
          total_tokens: INPUT + 4,
          prompt_cache_hit_tokens: cached,
          prompt_cache_miss_tokens: INPUT - cached,
        }),
      ],
      true,
    );
  },
  google: (text, cached) =>
    sse([
      {
        candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: INPUT,
          candidatesTokenCount: 4,
          cachedContentTokenCount: cached,
          totalTokenCount: INPUT + 4,
        },
      },
    ]),
};

/** Stands in for the provider's API: records every request and answers from `replies`. */
function fakeProvider(kind: keyof typeof replies, cached = CACHED) {
  const requests: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Json });
      return (replies[kind] as (text: string, cached: number) => Response)("Yes.", cached);
    }),
  );
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

const MODELS: Record<string, string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-5.4-nano",
  deepseek: "deepseek-chat",
  google: "gemini-3.8-flash",
};

const modelOf = (kind: keyof typeof replies) =>
  createAiSdkChatModel({
    kind: kind as ChatProviderKind,
    baseUrl: null,
    apiKey: "key-test",
    modelId: MODELS[kind] as string,
  });

const documents: AnswerTools = {
  documentCount: 2,
  async searchDocuments() {
    return { text: "No Passages found.", passageCount: 0 };
  },
  cite: () => "Recorded.",
};

/** A Mind read with the Question (#564), as it starts the conversation's first message. */
const MIND = `<mind name="Tides">\n${"Spring tides come at new and full moon. ".repeat(80)}\n</mind>`;
const WITH_MIND = [
  {
    role: "user" as const,
    content: `${MIND}\n\nWhat causes the tides?`,
    stablePrefix: MIND.length,
  },
];

const names = { total: 2, names: ["Tides.pdf", "Moon.pdf"] };

/** A request as the Answers module makes it: the instructions as it composes them, Question by Question. */
function request(
  model: AnswerRequest["model"],
  messages: AnswerRequest["messages"],
  overrides: Partial<AnswerRequest> = {},
): AnswerRequest {
  const question = messages.at(-1)?.content ?? "";
  return {
    instructions: () =>
      [
        answerInstructions(),
        documentInstructions("tools", names),
        languageInstruction(question, "en", names.names),
      ]
        .filter(Boolean)
        .join("\n\n"),
    messages,
    question,
    model,
    documents,
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function run(answer: AnswerRequest): Promise<AnswerEngineEvent[]> {
  const events: AnswerEngineEvent[] = [];
  for await (const event of createAiSdkAnswerEngine().generate(answer)) events.push(event);
  return events;
}

const FIRST = [{ role: "user" as const, content: "What causes the tides?" }];
const SECOND = [
  ...FIRST,
  { role: "assistant" as const, content: "The Moon's pull." },
  { role: "user" as const, content: "And the Sun?" },
];

/** Every string in a request body, in order. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** Whether `part` is in `whole`, in order, with anything between. */
function inOrder(part: readonly string[], whole: readonly string[]): boolean {
  let at = 0;
  for (const each of whole) if (each === part[at]) at++;
  return at === part.length;
}

describe("Where Anthropic's cache breakpoints go", () => {
  const message = (role: "system" | "user" | "assistant" | "tool") =>
    ({ role, content: role === "system" ? "s" : [] }) as Parameters<
      typeof breakpointsOf
    >[0][number];

  test("the instructions and the earlier turns, never the Question", () => {
    expect(breakpointsOf([message("system"), message("user")])).toEqual([0]);
    expect(
      breakpointsOf([message("system"), message("user"), message("assistant"), message("user")]),
    ).toEqual([0, 2]);
    expect(breakpointsOf([message("user"), message("assistant"), message("user")])).toEqual([1]);
    expect(breakpointsOf([message("user")])).toEqual([]);
  });

  test("in a Tool loop, the last message too: the history that grows", () => {
    const prompt = [
      message("system"),
      message("user"),
      message("assistant"),
      message("tool"),
      message("assistant"),
      message("tool"),
    ];
    expect(breakpointsOf(prompt)).toEqual([0, 5]);
    expect(breakpointsOf([...prompt.slice(0, 2), message("assistant"), message("tool")])).toEqual([
      0, 3,
    ]);
  });
});

describe("Anthropic requests", () => {
  /** The `cache_control` marks of a request body: where they are, in the order the API reads it. */
  function marks(body: Json) {
    const found: string[] = [];
    (body.tools as { name: string; cache_control?: unknown }[] | undefined)?.forEach(
      (tool, at, all) => {
        if (tool.cache_control) found.push(`tool ${at + 1}/${all.length}`);
      },
    );
    for (const block of (body.system ?? []) as { cache_control?: unknown }[]) {
      if (block.cache_control) found.push("system");
    }
    (body.messages as { role: string; content: { cache_control?: unknown }[] }[]).forEach(
      (each, at) => {
        for (const block of each.content) {
          if (block.cache_control) found.push(`message ${at + 1} (${each.role})`);
        }
      },
    );
    return found;
  }

  test("the first Question marks the Tools and the instructions, not the Question", async () => {
    const requests = fakeProvider("anthropic");

    await run(request(modelOf("anthropic"), FIRST));

    const body = (requests[0] as Captured).body;
    const tools = body.tools as unknown[];
    expect(tools.length).toBeGreaterThan(0);
    expect(marks(body)).toEqual([`tool ${tools.length}/${tools.length}`, "system"]);
  });

  test("the next Question also marks the earlier turns, not the new Question", async () => {
    const requests = fakeProvider("anthropic");

    await run(request(modelOf("anthropic"), SECOND));

    const body = (requests[0] as Captured).body;
    // Message 2 is the earlier Answer; message 3 is the new Question.
    expect(marks(body).filter((mark) => mark.startsWith("message"))).toEqual([
      "message 2 (assistant)",
    ]);
    expect(marks(body).length).toBeLessThanOrEqual(4);
  });

  // protects=a turn holding no text, as Claude's empty reply comes back, is never sent to Anthropic, so the mark on the turn before the newest message can't land on an empty text block, which Anthropic refuses; fails_when=the blank turn is sent with a cache mark; no_claim=other providers, whose requests this doesn't touch (#2701).
  test("a turn that said nothing isn't sent, so no empty text block carries a mark", async () => {
    const requests = fakeProvider("anthropic");

    await run(
      request(modelOf("anthropic"), [
        ...FIRST,
        { role: "assistant", content: " \n" },
        { role: "user", content: "Your reply is empty. Say what causes the tides." },
      ]),
    );

    const body = (requests[0] as Captured).body;
    const messages = body.messages as {
      role: string;
      content: { type: string; text?: string }[];
    }[];
    expect(messages.map((each) => each.role)).toEqual(["user"]);
    expect(strings(messages)).toEqual(
      expect.arrayContaining([
        "What causes the tides?",
        "Your reply is empty. Say what causes the tides.",
      ]),
    );
    expect(marks(body).filter((mark) => mark.startsWith("message"))).toEqual(["message 1 (user)"]);
    const marked = messages.flatMap((each) =>
      (each.content as { text?: string; cache_control?: unknown }[]).filter(
        (block) => block.cache_control,
      ),
    );
    expect(marked.map((block) => block.text)).toEqual(["What causes the tides?"]);
  });

  test("in a Tool loop, the history so far is marked at every step, within four breakpoints", async () => {
    const requests: Captured[] = [];
    let step = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: "", body: JSON.parse(String(init?.body)) as Json });
        if (step++ > 0) return (replies.anthropic as (t: string, c: number) => Response)("Yes.", 0);
        const start = {
          type: "message_start",
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "claude-haiku-5-5",
            content: [],
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        };
        return sse([
          start,
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: "search_documents", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"query":"tides"}' },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]);
      }),
    );

    const events = await run(request(modelOf("anthropic"), FIRST));

    expect(events.at(-1)).toEqual({ type: "finished" });
    expect(requests).toHaveLength(2);
    const [first, second] = requests.map((each) => marks(each.body));
    expect(first?.filter((mark) => mark.startsWith("message"))).toEqual([]);
    // The Tool result, the last message, which the next step repeats.
    expect(second?.filter((mark) => mark.startsWith("message"))).toEqual(["message 3 (user)"]);
    expect(second?.length).toBeLessThanOrEqual(4);
  });
});

describe("Anthropic requests with a Mind read with the Question (#564)", () => {
  /** Where the `cache_control` marks of a request are, as `marks` above says them. */
  function marked(body: Json) {
    const found: string[] = [];
    (body.tools as { cache_control?: unknown }[] | undefined)?.forEach((tool) => {
      if (tool.cache_control) found.push("tool");
    });
    for (const block of (body.system ?? []) as { cache_control?: unknown }[]) {
      if (block.cache_control) found.push("system");
    }
    (body.messages as { role: string; content: { cache_control?: unknown }[] }[]).forEach(
      (each, at) => {
        each.content.forEach((block, part) => {
          if (block.cache_control) found.push(`message ${at + 1} part ${part + 1}`);
        });
      },
    );
    return found;
  }

  // protects=the first Question already writes the Mind to Anthropic's cache, as a part of its own, so the next Question reads it from there; fails_when=the Mind isn't marked, the Question is, or the text sent changes; no_claim=what Anthropic bills, the hand test's.
  test("the first Question marks the end of the Mind, and its text is sent as it was", async () => {
    const requests = fakeProvider("anthropic");

    await run(request(modelOf("anthropic"), WITH_MIND));

    const body = (requests[0] as Captured).body;
    const [first] = body.messages as { content: { text: string }[] }[];
    expect(first?.content.map((block) => block.text)).toEqual([MIND, "\n\nWhat causes the tides?"]);
    expect(marked(body)).toEqual(["tool", "system", "message 1 part 1"]);
  });

  // protects=in a Tool loop with a Mind, the marks stay within Anthropic's four: the Tools' own mark gives way, the instructions' still covers them; fails_when=a request has five marks (Anthropic refuses it) or loses the Mind's; no_claim=none beyond protects.
  test("in a Tool loop, the Mind's mark is kept within four, the Tools' giving way", async () => {
    const requests: Captured[] = [];
    let step = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: "", body: JSON.parse(String(init?.body)) as Json });
        if (step++ > 0) return (replies.anthropic as (t: string, c: number) => Response)("Yes.", 0);
        return sse([
          {
            type: "message_start",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              model: "claude-haiku-5-5",
              content: [],
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: "search_documents", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"query":"tides"}' },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]);
      }),
    );

    await run(
      request(modelOf("anthropic"), [
        ...WITH_MIND,
        { role: "assistant", content: "The Moon's pull." },
        { role: "user", content: "And the Sun?" },
      ]),
    );

    const [first, second] = requests.map((each) => marked(each.body));
    expect(first).toEqual(["tool", "system", "message 1 part 1", "message 2 part 1"]);
    expect(second).toEqual(["system", "message 1 part 1", "message 2 part 1", "message 5 part 1"]);
  });
});

describe("The start of the prompt stays the same from one Question to the next", () => {
  for (const kind of Object.keys(replies)) {
    test(`${kind}: the second Question's request holds the first's, in order`, async () => {
      const requests = fakeProvider(kind);
      const model = modelOf(kind);

      await run(request(model, FIRST, { cacheKey: "conversation-1" }));
      await run(request(model, SECOND, { cacheKey: "conversation-1" }));

      expect(requests).toHaveLength(2);
      const [first, second] = requests.map((each) => strings(each.body));
      // Everything the first request sent, the Tools and the instructions included, is in
      // the second, in the same order, with the earlier turn and the new Question added.
      expect(inOrder(first as string[], second as string[])).toBe(true);
      expect(second).toContain("And the Sun?");
    });
  }

  test("a change of language changes only the last line of the instructions", () => {
    const shared = [answerInstructions(), documentInstructions("tools", names)].join("\n\n");
    const english = [shared, languageInstruction("What causes the tides?", "zh-CN", [])].join(
      "\n\n",
    );
    const chinese = [shared, languageInstruction("潮汐是什么？", "en", [])].join("\n\n");
    expect(english.startsWith(shared)).toBe(true);
    expect(chinese.startsWith(shared)).toBe(true);
    expect(english.slice(shared.length)).toContain("English");
    expect(chinese.slice(shared.length)).toContain("Chinese");
  });

  test("the instructions hold nothing that changes with the request", () => {
    const text = [answerInstructions(), documentInstructions("tools", names)].join("\n\n");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe("OpenAI's cache key", () => {
  test("one conversation sends one key, another sends another, and it is not the id", async () => {
    const requests = fakeProvider("openai");
    const model = modelOf("openai");

    await run(request(model, FIRST, { cacheKey: "mind-1" }));
    await run(request(model, SECOND, { cacheKey: "mind-1" }));
    await run(request(model, FIRST, { cacheKey: "mind-2" }));

    const keys = requests.map((each) => each.body.prompt_cache_key);
    expect(keys[0]).toBeTypeOf("string");
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(JSON.stringify(keys)).not.toContain("mind-");
  });

  test("a request with no conversation sends none", () => {
    expect(cacheProviderOptions(undefined)).toBeUndefined();
  });
});

describe("Cached tokens are recorded with an Answer's usage", () => {
  for (const kind of Object.keys(replies)) {
    test(`${kind}: the cached input tokens the provider reports`, async () => {
      fakeProvider(kind);

      const events = await run(request(modelOf(kind), SECOND));

      const usage = events.filter((event) => event.type === "usage");
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        usage: { inputTokens: INPUT, cachedInputTokens: CACHED },
      });
    });
  }

  test("Anthropic's writes are recorded too", async () => {
    fakeProvider("anthropic");

    const events = await run(request(modelOf("anthropic"), SECOND));

    expect(events.find((event) => event.type === "usage")).toMatchObject({
      usage: { cachedInputTokens: CACHED, cacheWriteTokens: WRITTEN },
    });
  });
});
