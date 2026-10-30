import { generateText, jsonSchema, Output, streamText, tool } from "ai";
import { afterEach, expect, test, vi } from "vitest";
import { isRecord } from "../../src/core/errors";
import * as catalog from "../../src/core/providers/catalog";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { searchWeb } from "../../src/core/providers/webSearch";
import { createAiSdkRunEngine } from "../../src/core/runs/aiSdkEngine";
import { searchesTheWeb } from "../../src/shared/webSearch";

const schema = {
  type: "object" as const,
  properties: { quote: { type: "string" } },
  required: ["quote"],
  additionalProperties: false,
};
const cite = tool({ description: "Record evidence", inputSchema: jsonSchema(schema) });
const endpoint = {
  tag: "capable",
  supported_parameters: ["tools", "response_format", "structured_outputs"],
  supports_tool_choice: { function: false, required: false },
};
const makeModel = (id = "anthropic/claude-haiku-5.5") =>
  createAiSdkChatModel({ kind: "openrouter", baseUrl: null, apiKey: "test-key", modelId: id });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function server(
  endpoints: unknown[] = [endpoint],
  options: { status?: number; malformed?: boolean } = {},
) {
  const sent: Record<string, unknown>[] = [];
  const lookups: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/endpoints")) {
        lookups.push(String(url));
        return Response.json(options.malformed ? {} : { data: { endpoints } }, {
          status: options.status ?? 200,
        });
      }
      const body: unknown = JSON.parse(String(init?.body));
      if (!isRecord(body)) throw Error("Not a request object");
      sent.push(body);
      const forced = isRecord(body.tool_choice) || body.tool_choice === "required";
      if (
        forced &&
        isRecord(body.provider) &&
        body.provider.require_parameters === true &&
        !endpoints.some(
          (e) =>
            isRecord(e) &&
            isRecord(e.supports_tool_choice) &&
            e.supports_tool_choice[body.tool_choice === "required" ? "required" : "function"] ===
              true,
        )
      )
        return Response.json(
          {
            error: {
              message: "No endpoints found that support the provided 'tool_choice' value",
              code: 404,
            },
          },
          { status: 404 },
        );
      const nativeSearch =
        Array.isArray(body.tools) &&
        body.tools.some((offered) => isRecord(offered) && offered.type === "openrouter:web_search");
      const calls =
        forced && !nativeSearch
          ? [
              {
                id: "c1",
                type: "function",
                function: {
                  name:
                    isRecord(body.tool_choice) && isRecord(body.tool_choice.function)
                      ? body.tool_choice.function.name
                      : "cite",
                  arguments: JSON.stringify({ quote: "The river is blue." }),
                },
              },
            ]
          : undefined;
      const message = {
        role: "assistant",
        content: calls ? null : '{"quote":"The river is blue."}',
        ...(calls && { tool_calls: calls }),
        ...(nativeSearch && {
          annotations: [
            {
              type: "url_citation",
              url_citation: {
                url: "https://example.com/river",
                title: "River",
                content: "Blue river",
                start_index: 0,
                end_index: 0,
              },
            },
          ],
        }),
      };
      if (body.stream) {
        const chunk = {
          id: "reply",
          model: body.model,
          created: 1,
          choices: [{ index: 0, finish_reason: calls ? "tool_calls" : "stop", delta: message }],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "reply",
        model: body.model,
        created: 1,
        choices: [{ index: 0, finish_reason: calls ? "tool_calls" : "stop", message }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    }),
  );
  return { sent, lookups };
}

const policy = {
  data_collection: "deny",
  require_parameters: false,
  only: ["capable"],
  allow_fallbacks: false,
};

test("forced routing preserves additional catalog privacy restrictions", async () => {
  const provider = catalog.catalogProviderOfKind("openrouter");
  if (!provider) throw Error("Missing OpenRouter catalog entry");
  vi.spyOn(catalog, "catalogProviderOfKind").mockReturnValue({
    ...provider,
    request: {
      ...provider.request,
      body: { provider: { data_collection: "deny", require_parameters: true, zdr: true } },
    },
  });
  const { sent } = server();
  await generateText({
    model: makeModel(),
    prompt: "Record",
    tools: { cite },
    toolChoice: { type: "tool", toolName: "cite" },
    maxRetries: 0,
  });
  expect(sent[0]).toMatchObject({ provider: { ...policy, zdr: true } });
});

test.each(["timeout", "cancel"] as const)(
  "endpoint lookup stops on %s without sending a prompt",
  async (why) => {
    const deadline = new AbortController();
    const caller = new AbortController();
    const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let waiting: AbortSignal | null = null;
    const fetched = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      waiting = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        waiting?.addEventListener("abort", () => reject(waiting?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetched);
    const stopped = generateText({
      model: makeModel(),
      prompt: "Never send this",
      tools: { cite },
      toolChoice: { type: "tool", toolName: "cite" },
      maxRetries: 0,
      ...(why === "cancel" && { abortSignal: caller.signal }),
    });
    const failure = expect(stopped).rejects.toMatchObject(
      why === "timeout"
        ? { wording: { key: "error.provider.openrouterCapabilities" } }
        : { name: "AbortError" },
    );
    await vi.waitFor(() => expect(fetched).toHaveBeenCalled());
    const reason = new DOMException("Stopped", why === "cancel" ? "AbortError" : "TimeoutError");
    if (why === "cancel") caller.abort(reason);
    else deadline.abort(reason);
    expect(timer).toHaveBeenCalledWith(5_000);
    await failure;
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0]?.[0]).toMatch(/\/endpoints$/);
  },
);

// protects=forced choices keep their Tool and privacy/capability restrictions; fails_when=strict routing still refuses Claude or the fallback can reach an endpoint without Tools; no_claim=real provider acceptance.
test.each(["en", "zh-CN"] as const)(
  "a named Tool keeps its choice and capable endpoints (%s)",
  async (language) => {
    const { sent } = server([
      endpoint,
      { tag: "no-tools", supported_parameters: ["structured_outputs"] },
    ]);
    const result = await generateText({
      model: makeModel(),
      prompt: language === "en" ? "Cite the river." : "引用河流。",
      tools: { cite },
      toolChoice: { type: "tool", toolName: "cite" },
      maxOutputTokens: 100,
      maxRetries: 0,
    });
    expect(result.toolCalls[0]?.toolName).toBe("cite");
    expect(sent[0]).toMatchObject({
      tool_choice: { type: "function", function: { name: "cite" } },
      provider: policy,
    });
  },
);

test("required streaming calls preserve the full Tool set", async () => {
  const { sent } = server();
  const result = streamText({
    model: makeModel(),
    prompt: "Record evidence",
    tools: { cite, other: cite },
    toolChoice: "required",
    maxRetries: 0,
  });
  expect((await result.toolCalls)[0]?.toolName).toBe("cite");
  expect(sent[0]).toMatchObject({ tool_choice: "required", provider: policy });
  expect(sent[0]?.tools).toHaveLength(2);
});

// protects=the Run's forced first Tool, used by a check's second ask, reaches OpenRouter with its named choice; fails_when=that call still gets the routing refusal; no_claim=the model's verdict quality.
test("the check's forced first cite goes through the Run engine", async () => {
  const { sent } = server();
  const events = [];
  for await (const event of createAiSdkRunEngine().run({
    model: makeModel(),
    instructions: "Record evidence",
    messages: [
      {
        role: "user",
        text: "Your first reply was unreadable; record the deciding quote with cite.",
      },
    ],
    tools: [
      {
        name: "cite",
        description: "Record evidence",
        inputSchema: schema,
        call: async () => "Recorded",
      },
    ],
    maxSteps: 2,
    firstTool: "cite",
    gate: async () => ({ run: true }),
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(events.filter((e) => e.type === "failed")).toEqual([]);
  expect(sent[0]).toMatchObject({
    tool_choice: { type: "function", function: { name: "cite" } },
    provider: policy,
  });
});

// protects=OpenRouter search remains forced on the wire and accepts a server result without a client Tool-call part; fails_when=routing or SDK choice validation rejects the result; no_claim=live search quality.
test("OpenRouter's forced provider search returns its sources without a client Tool call", async () => {
  const { sent } = server();
  expect(searchesTheWeb("openrouter")).toBe(true);
  expect(await searchWeb(makeModel(), "openrouter", "river", new AbortController().signal)).toEqual(
    [{ url: "https://example.com/river", title: "River", age: null }],
  );
  expect(sent[0]).toMatchObject({
    tool_choice: "required",
    provider: policy,
    tools: [
      {
        type: "openrouter:web_search",
        parameters: { engine: "exa", max_uses: 1, max_results: 10, max_total_results: 10 },
      },
    ],
  });
});

test.each(["auto", "none"] as const)(
  "%s keeps strict routing without an endpoint lookup",
  async (toolChoice) => {
    const { sent, lookups } = server();
    await generateText({
      model: makeModel(),
      prompt: "Read",
      tools: { cite },
      toolChoice,
      maxRetries: 0,
    });
    expect(lookups).toEqual([]);
    expect(sent[0]).toMatchObject({
      provider: { data_collection: "deny", require_parameters: true },
    });
  },
);

test("schema-only calls keep strict routing and the strict schema", async () => {
  const { sent, lookups } = server();
  await generateText({
    model: makeModel(),
    prompt: "Read",
    output: Output.object({ schema: jsonSchema(schema) }),
    maxRetries: 0,
  });
  expect(lookups).toEqual([]);
  expect(sent[0]).toMatchObject({
    provider: { data_collection: "deny", require_parameters: true },
    response_format: {
      type: "json_schema",
      json_schema: { schema: { additionalProperties: false } },
    },
  });
});

test("a forced schema request excludes Tools-only endpoints", async () => {
  const { sent } = server([endpoint, { tag: "no-schema", supported_parameters: ["tools"] }]);
  await generateText({
    model: makeModel(),
    prompt: "Record",
    tools: { cite },
    toolChoice: { type: "tool", toolName: "cite" },
    output: Output.object({ schema: jsonSchema(schema) }),
    maxRetries: 0,
  });
  expect(sent[0]).toMatchObject({ provider: policy, response_format: { type: "json_schema" } });
});

test("a forced schema request fails closed when only Tools are supported", async () => {
  const { sent } = server([{ tag: "no-schema", supported_parameters: ["tools"] }]);
  await expect(
    generateText({
      model: makeModel(),
      prompt: "Never send this",
      tools: { cite },
      toolChoice: { type: "tool", toolName: "cite" },
      output: Output.object({ schema: jsonSchema(schema) }),
      maxRetries: 0,
    }),
  ).rejects.toThrow(/OpenRouter/);
  expect(sent).toEqual([]);
});

test("non-Claude endpoints that support forced choices retain strict routing", async () => {
  const { sent } = server([
    { ...endpoint, supports_tool_choice: { function: true, required: true } },
  ]);
  await generateText({
    model: makeModel("openai/gpt-6-luna"),
    prompt: "Record",
    tools: { cite },
    toolChoice: { type: "tool", toolName: "cite" },
    maxRetries: 0,
  });
  expect(sent[0]).toMatchObject({
    provider: { data_collection: "deny", require_parameters: true },
  });
});

// protects=unknown or unsupported endpoint capability never sends a prompt; fails_when=lookup errors are ignored or an empty allowlist reaches the API; no_claim=endpoint metadata accuracy.
test.each([
  { name: "no Tool support", endpoints: [{ tag: "bad", supported_parameters: [] }] },
  { name: "no endpoints", endpoints: [] },
  { name: "missing endpoint tag", endpoints: [{ ...endpoint, tag: " " }] },
  { name: "malformed metadata", endpoints: [], malformed: true },
  { name: "failed lookup", endpoints: [], status: 503 },
])("$name fails before sending the prompt", async ({ endpoints, ...options }) => {
  const { sent } = server(endpoints, options);
  await expect(
    generateText({
      model: makeModel(),
      prompt: "Never send this",
      tools: { cite },
      toolChoice: { type: "tool", toolName: "cite" },
      maxRetries: 0,
    }),
  ).rejects.toThrow(/OpenRouter/);
  expect(sent).toEqual([]);
});
