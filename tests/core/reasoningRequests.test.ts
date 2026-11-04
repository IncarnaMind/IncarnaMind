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

  // protects=DeepSeek Flash, which thinks by default, is sent no effort for any kind of call: low was measured and kept out (#1631); fails_when=any kind carries reasoning_effort or a thinking setting; no_claim=the fake API doesn't check what DeepSeek accepts.
  test.each(["answer", "careful", "task", "summary"] as const)(
    "DeepSeek Flash, %s: no reasoning_effort",
    async (thinking) => {
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
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.reasoning_effort).toBeUndefined();
      expect(bodies[0]?.thinking).toBeUndefined();
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
    expect(Object.keys(deepseek[0] ?? {})).not.toEqual(
      expect.arrayContaining(["thinking", "reasoning", "reasoning_effort"]),
    );
  });
});
