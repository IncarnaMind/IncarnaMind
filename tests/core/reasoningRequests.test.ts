import { generateText } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type AnswerEngineEvent, createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import type { ChatProviderKind } from "../../src/core/api";
import { type ChatModelSpec, createAiSdkChatModel } from "../../src/core/providers/models";

/**
 * What an Answer's request asks of a model that thinks (#391): its provider's
 * summary of the reasoning (Anthropic's summarized thinking, the Responses
 * API's reasoning summary), never thinking turned on for a model that doesn't
 * think by default, and on a provider whose reasoning is raw, only the effort
 * its catalog entry names for the model (#1631). The providers are the real AI
 * SDK ones, against a stand-in for `fetch` that records each request and
 * replies as the provider's API does.
 */

type Json = Record<string, unknown>;

const sse = (events: readonly object[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const SUMMARY = ["**Finding the tides**\n\nThe Question asks when", " spring tides happen."];

/** Anthropic's stream: a thinking block with its summary, then the text. */
const anthropicReply = () =>
  sse([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    ...SUMMARY.map((thinking) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking },
    })),
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "s" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "At full moon." } },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
  ]);

/** The Responses API's stream: a reasoning item with a summary in two parts, then the message. */
const openaiReply = () => {
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "At full moon.", annotations: [] }],
  };
  const reasoning = {
    id: "rs_1",
    type: "reasoning",
    summary: SUMMARY.map((text) => ({ type: "summary_text", text })),
    encrypted_content: "e",
  };
  const response = {
    id: "resp_1",
    object: "response",
    created_at: 1_790_000_000,
    model: "gpt-6-luna",
    status: "completed",
    output: [reasoning, message],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 9,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 19,
    },
  };
  return sse([
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", summary: [], encrypted_content: null },
    },
    ...SUMMARY.flatMap((delta, index) => [
      {
        type: "response.reasoning_summary_part.added",
        item_id: "rs_1",
        output_index: 0,
        summary_index: index,
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        output_index: 0,
        summary_index: index,
        delta,
      },
      {
        type: "response.reasoning_summary_part.done",
        item_id: "rs_1",
        output_index: 0,
        summary_index: index,
        part: { type: "summary_text", text: delta },
      },
    ]),
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_1",
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 1,
      content_index: 0,
      delta: "At full moon.",
    },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.completed", response },
  ]);
};

/** Stands in for the provider's API: records every request body and replies as `reply` does. */
function fakeApi(reply: () => Response): Json[] {
  const bodies: Json[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Json);
      return reply();
    }),
  );
  return bodies;
}

afterEach(() => vi.unstubAllGlobals());

const modelOf = (kind: ChatProviderKind, modelId: string, thinking?: ChatModelSpec["thinking"]) =>
  createAiSdkChatModel({
    kind,
    baseUrl: null,
    apiKey: "key-test",
    modelId,
    ...(thinking && { thinking }),
  });

/** The body of one Answer's request, written by the Answer engine, and the reasoning it read. */
async function answer(
  kind: ChatProviderKind,
  modelId: string,
  reply: () => Response,
  thinking: ChatModelSpec["thinking"] = "summary",
) {
  const bodies = fakeApi(reply);
  const events: AnswerEngineEvent[] = [];
  for await (const event of createAiSdkAnswerEngine().generate({
    instructions: () => "Answer briefly.",
    messages: [{ role: "user", content: "When are spring tides?" }],
    question: "When are spring tides?",
    model: modelOf(kind, modelId, thinking),
    documents: {
      documentCount: 0,
      searchDocuments: async () => ({ text: "", passageCount: 0 }),
      cite: () => "",
    },
    tools: [],
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  const reasoning = events.flatMap((event) => (event.type === "reasoning" ? [event.text] : []));
  return { body: bodies[0] ?? {}, reasoning: reasoning.join("") };
}

describe("An Answer's request to a model that thinks", () => {
  // protects=Claude 5 models are asked for their summarized thinking, at the default effort for a call of no kind and for a Task's but on Haiku 5.5 (its id or dated id, not one it begins), low for an Answer and Haiku 5.5's Task, and high for an Answer that checks or calculates, and older ones get no thinking turned on; fails_when=a call of no kind, Sonnet's Task or another id's Task carries an effort, an Answer or Haiku's Task lacks its effort, or Claude 4.8's carries thinking; no_claim=the fake API doesn't check what Anthropic accepts.
  test.each([
    ["claude-sonnet-5-5", "summary", { type: "adaptive", display: "summarized" }, undefined],
    ["claude-sonnet-5-5", "answer", { type: "adaptive", display: "summarized" }, { effort: "low" }],
    ["claude-haiku-5-5", "answer", { type: "adaptive", display: "summarized" }, { effort: "low" }],
    ["claude-opus-5-5", "answer", { type: "adaptive", display: "summarized" }, { effort: "low" }],
    [
      "claude-sonnet-5-5",
      "careful",
      { type: "adaptive", display: "summarized" },
      { effort: "high" },
    ],
    ["claude-sonnet-5-5", "task", { type: "adaptive", display: "summarized" }, undefined],
    ["claude-haiku-5-5", "task", { type: "adaptive", display: "summarized" }, { effort: "low" }],
    [
      "claude-haiku-5-5-20261001",
      "task",
      { type: "adaptive", display: "summarized" },
      { effort: "low" },
    ],
    ["claude-haiku-5-50", "task", { type: "adaptive", display: "summarized" }, undefined],
    ["claude-opus-5-5", "task", { type: "adaptive", display: "summarized" }, undefined],
    ["claude-opus-4-8", "answer", undefined, undefined],
    ["claude-opus-4-8", "careful", undefined, undefined],
    ["claude-opus-4-8", "task", undefined, undefined],
  ] as const)(
    "Anthropic's %s, %s: thinking %j, %j",
    async (modelId, thinking, expected, outputConfig) => {
      const { body } = await answer("anthropic", modelId, anthropicReply, thinking);
      expect(body.thinking).toEqual(expected);
      expect(body.output_config).toEqual(outputConfig);
    },
  );

  // protects=OpenAI's reasoning models are asked for a reasoning summary, others for none; fails_when=gpt-6-luna lacks reasoning.summary or gpt-4.1 carries reasoning; no_claim=the fake API doesn't check what OpenAI accepts.
  test("OpenAI's reasoning models are asked for a reasoning summary; a model that doesn't reason, for none", async () => {
    expect((await answer("openai", "gpt-6-luna", openaiReply)).body.reasoning).toMatchObject({
      summary: "auto",
    });
    vi.unstubAllGlobals();
    expect((await answer("openai", "gpt-4.1", openaiReply)).body.reasoning).toBeUndefined();
  });

  // protects=the summary each provider streams reaches the Answer as reasoning, its parts as paragraphs; fails_when=the summary is lost, or reaches the text; no_claim=the replies are recorded shapes of the APIs, not live ones.
  test.each([
    ["anthropic", "claude-sonnet-5-5", anthropicReply, SUMMARY.join("")],
    ["openai", "gpt-6-luna", openaiReply, SUMMARY.join("\n\n")],
  ] as const)(
    "%s's summary reaches the Answer as reasoning",
    async (kind, modelId, reply, summary) => {
      expect((await answer(kind, modelId, reply)).reasoning).toBe(summary);
    },
  );

  // protects=calls that don't write the Answer, and providers whose reasoning is raw, ask for no summary; fails_when=a connection test or a DeepSeek Answer carries a summary option; no_claim=only the request body is checked.
  test("a call that doesn't write the Answer, and a provider whose reasoning is raw, ask for none", async () => {
    const bodies = fakeApi(() =>
      Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    await generateText({ model: modelOf("anthropic", "claude-sonnet-5-5"), prompt: "OK?" });
    expect(bodies[0]?.thinking).toBeUndefined();
    vi.unstubAllGlobals();
    const deepseek = fakeApi(() =>
      Response.json({
        id: "c1",
        object: "chat.completion",
        created: 1_790_000_000,
        model: "deepseek-chat",
        choices: [
          { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    await generateText({ model: modelOf("deepseek", "deepseek-chat", "summary"), prompt: "OK?" });
    expect(deepseek).toHaveLength(1);
    expect(deepseek[0]?.thinking).toBeUndefined();
    expect(deepseek[0]?.reasoning).toBeUndefined();
    expect(deepseek[0]?.reasoning_effort).toBeUndefined();
  });

  // protects=DeepSeek Flash, which thinks by default, keeps DeepSeek's default for every kind of call: low was measured and failed the gate twice (#1631); fails_when=any kind sends thinking, reasoning or reasoning_effort; no_claim=the fake API doesn't check what DeepSeek accepts.
  test.each(["answer", "careful", "task", "summary"] as const)(
    "DeepSeek Flash, %s: none of thinking, reasoning or reasoning_effort",
    async (thinking) => {
      const bodies = fakeApi(completion);
      await generateText({ model: modelOf("deepseek", "deepseek-flash", thinking), prompt: "OK?" });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.thinking).toBeUndefined();
      expect(bodies[0]?.reasoning).toBeUndefined();
      expect(bodies[0]?.reasoning_effort).toBeUndefined();
    },
  );
});

/** A chat completion as OpenAI-compatible APIs (Qwen, GLM, OpenRouter) give it, not streamed. */
const completion = () =>
  Response.json({
    id: "c1",
    object: "chat.completion",
    created: 1_790_000_000,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

/** Gemini's reply to `generateContent`, not streamed. */
const geminiReply = () =>
  Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });

/** The body of one small request on this model, at this kind of call. */
async function sent(
  kind: ChatProviderKind,
  modelId: string,
  thinking: ChatModelSpec["thinking"],
  reply: () => Response,
): Promise<Json> {
  const bodies = fakeApi(reply);
  await generateText({ model: modelOf(kind, modelId, thinking), prompt: "OK?" });
  expect(bodies).toHaveLength(1);
  return bodies[0] ?? {};
}

describe("Each provider's own effort control (#1631)", () => {
  // protects=GPT-6 Luna, measured at low and failing the gate (#1631), and GPT-6.1 Sol think at OpenAI's default for every kind of call, with the summary; fails_when=any kind carries an effort or loses the summary; no_claim=the fake API doesn't check what OpenAI accepts.
  test.each([
    ["gpt-6-luna", "answer"],
    ["gpt-6-luna", "task"],
    ["gpt-6-luna", "careful"],
    ["gpt-6.1-sol", "answer"],
  ] as const)("OpenAI's %s, %s: the summary, no effort", async (modelId, thinking) => {
    expect((await answer("openai", modelId, openaiReply, thinking)).body.reasoning).toEqual({
      summary: "auto",
    });
  });

  // protects=on a provider whose reasoning isn't summarized, each kind the catalog names for a model gets that provider's own control (Qwen3.7-Plus's Tasks), and every other kind and model, those measured and kept at the default included, gets none; fails_when=a named kind lacks its control, or another kind or model carries one; no_claim=the fake APIs don't check what each provider accepts.
  test.each([
    ["openrouter", "openai/gpt-6-luna", "answer", (b: Json) => b.reasoning, undefined],
    ["openrouter", "google/gemini-3.8-flash", "answer", (b: Json) => b.reasoning, undefined],
    ["openrouter", "google/gemini-3.8-flash", "task", (b: Json) => b.reasoning, undefined],
    ["openrouter", "z-ai/glm-5.3-flash", "answer", (b: Json) => b.reasoning, undefined],
    ["openrouter", "qwen/qwen3.7-plus", "task", (b: Json) => b.reasoning, { max_tokens: 512 }],
    ["openrouter", "qwen/qwen3.7-plus", "answer", (b: Json) => b.reasoning, undefined],
    ["openrouter", "qwen/qwen3.7-plus", "careful", (b: Json) => b.reasoning, undefined],
    ["openrouter", "qwen/qwen3.7-plus", "summary", (b: Json) => b.reasoning, undefined],
    ["openrouter", "anthropic/claude-sonnet-5.5", "answer", (b: Json) => b.reasoning, undefined],
    ["qwen", "qwen3.7-plus", "task", (b: Json) => b.thinking_budget, 512],
    ["qwen", "qwen3.7-plus", "answer", (b: Json) => b.thinking_budget, undefined],
    ["qwen", "qwen3.7-plus", "careful", (b: Json) => b.thinking_budget, undefined],
    ["qwen", "qwen3.8-max", "task", (b: Json) => b.thinking_budget, undefined],
    ["glm", "glm-5.3-flash", "answer", (b: Json) => b.reasoning_effort, undefined],
    ["glm", "glm-5.3-flash", "task", (b: Json) => b.reasoning_effort, undefined],
  ] as const)("%s's %s, %s", async (kind, modelId, thinking, read, expected) => {
    expect(read(await sent(kind, modelId, thinking, completion))).toEqual(expected);
  });

  // protects=Gemini 3.8 Flash, measured at low and failing the gate (#1631), and other Gemini models think at Google's default for every kind of call; fails_when=any kind carries a thinking config; no_claim=the fake API doesn't check what Google accepts.
  test.each([
    ["gemini-3.8-flash", "answer"],
    ["gemini-3.8-flash", "task"],
    ["gemini-3.1-pro-preview", "answer"],
  ] as const)("Google's %s, %s: no thinking config", async (modelId, thinking) => {
    const body = await sent("google", modelId, thinking, geminiReply);
    expect((body.generationConfig as Json | undefined)?.thinkingConfig).toBeUndefined();
  });
});

describe("A model that refuses its provider's own effort control", () => {
  /** Stands in for the API: refuses with `refusal` while a request carries `carries`, else replies. */
  function refusing(carries: (body: Json) => boolean, refusal: Json, reply: () => Response) {
    const bodies: Json[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Json;
        bodies.push(body);
        return carries(body) ? Response.json(refusal, { status: 400 }) : reply();
      }),
    );
    return bodies;
  }

  // protects=a Qwen model that refuses its thinking budget still answers, asked again once without it, and its later calls leave it out from the start; fails_when=the call fails with the refusal, is asked twice with the control, or a later call sends it again; no_claim=the refusals are the APIs' documented shapes, not live ones; each model is a dated id of its own, so the form it is made to remember reaches no other test.
  test.each([
    {
      kind: "qwen",
      modelId: "qwen3.7-plus-2026-10-31",
      thinking: "task",
      read: (body: Json) => body.thinking_budget,
      refusal: {
        error: {
          code: "InvalidParameter",
          message: "<400> InternalError.Algo.InvalidParameter: thinking_budget is not supported",
        },
      },
      reply: completion,
      sentFirst: 512,
    },
  ] as const)(
    "$kind, $modelId: asked again without it, then without it from the start",
    async (each) => {
      const bodies = refusing((body) => each.read(body) !== undefined, each.refusal, each.reply);
      const model = modelOf(each.kind, each.modelId, each.thinking);
      await generateText({ model, prompt: "OK?" });
      await generateText({ model, prompt: "OK again?" });
      expect(bodies.map(each.read)).toEqual([each.sentFirst, undefined, undefined]);
    },
  );
});
