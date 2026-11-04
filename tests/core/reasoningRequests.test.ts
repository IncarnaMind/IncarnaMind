import { generateText } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type AnswerEngineEvent, createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import type { ChatProviderKind } from "../../src/core/api";
import { type ChatModelSpec, createAiSdkChatModel } from "../../src/core/providers/models";

/**
 * What an Answer's request asks of a model that thinks (#391): its provider's
 * summary of the reasoning (Anthropic's summarized thinking, the Responses
 * API's reasoning summary), never thinking turned on for a model that doesn't
 * think by default, and nothing for a provider whose reasoning is raw. The
 * providers are the real AI SDK ones, against a stand-in for `fetch` that
 * records each request and replies as the provider's API does.
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
  // protects=Claude 5 models are asked for their summarized thinking, at the default effort for a call of no kind and for a Task's but on Haiku 5.5, low for an Answer and Haiku 5.5's Task, and high for an Answer that checks or calculates, and older ones get no thinking turned on; fails_when=a call of no kind or Sonnet's Task carries an effort, an Answer or Haiku's Task lacks its effort, or Claude 4.8's carries thinking; no_claim=the fake API doesn't check what Anthropic accepts.
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

  // protects=DeepSeek's thinking models are asked for low effort on an Answer, and for none (its default) on a careful Answer, a Task's or a call of no kind, while its reasoning stays raw (no summary); fails_when=an Answer lacks reasoning_effort low, or another kind carries one; no_claim=the fake API doesn't check what DeepSeek accepts.
  test.each([
    ["answer", "low"],
    ["task", undefined],
    ["careful", undefined],
    ["summary", undefined],
  ] as const)("DeepSeek Flash, %s: reasoning_effort %s", async (thinking, effort) => {
    const bodies = fakeApi(() =>
      Response.json({
        id: "c1",
        object: "chat.completion",
        created: 1_790_000_000,
        model: "deepseek-flash",
        choices: [
          { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    await generateText({ model: modelOf("deepseek", "deepseek-flash", thinking), prompt: "OK?" });
    expect(bodies[0]?.reasoning_effort).toBe(effort);
    expect(bodies[0]?.thinking).toBeUndefined();
  });

  // protects=a DeepSeek model that refuses reasoning_effort still answers, asked again once without it, and its later calls leave it out from the start; fails_when=the call fails with the refusal, or a later call sends reasoning_effort again; no_claim=the refusal's wording is a stand-in, not DeepSeek's recorded one.
  test("a DeepSeek model that refuses the effort is asked again without it, and then from the start", async () => {
    const bodies: Json[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Json;
        bodies.push(body);
        if (body.reasoning_effort !== undefined) {
          return Response.json(
            {
              error: {
                message: "Unknown parameter: reasoning_effort",
                type: "invalid_request_error",
              },
            },
            { status: 422 },
          );
        }
        return Response.json({
          id: "c1",
          object: "chat.completion",
          created: 1_790_000_000,
          model: "deepseek-v4-pro",
          choices: [
            { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }),
    );
    const model = modelOf("deepseek", "deepseek-v4-pro", "answer");
    expect((await generateText({ model, prompt: "OK?", maxRetries: 0 })).text).toBe("OK");
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(["low", undefined]);
    bodies.length = 0;
    await generateText({ model: modelOf("deepseek", "deepseek-v4-pro", "answer"), prompt: "OK?" });
    expect(bodies.map((body) => body.reasoning_effort)).toEqual([undefined]);
  });

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
    // A model the catalog doesn't know to reason gets no effort either: it could turn thinking on.
    await generateText({ model: modelOf("deepseek", "deepseek-chat", "answer"), prompt: "OK?" });
    expect(deepseek).toHaveLength(2);
    for (const body of deepseek) {
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
    }
  });
});
