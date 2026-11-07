import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, expect, test, vi } from "vitest";
import { endpointUrl } from "../../src/core/providers/kinds";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { createTempDataFolder } from "../helpers/core";
import {
  createRequestLedger,
  type ObservationEvidence,
  observationReceipt,
  startObservation,
  structuredControls,
  V5_CHECKS,
} from "../helpers/meetingFillObservation";
import { drain } from "../helpers/streams";

const controls = {
  INCARNAMIND_STRUCTURED_RECEIPT: "/isolated/observation.json",
  INCARNAMIND_STRUCTURED_CANDIDATE: "a".repeat(40),
  INCARNAMIND_STRUCTURED_CAP_USD: "0.25",
  INCARNAMIND_DATA_DIR: "/isolated/data",
  INCARNAMIND_LIVE_REPORT: "/isolated/observation.md",
  INCARNAMIND_LIVE_REPLIES: "1",
  INCARNAMIND_LIVE_ANTHROPIC_KEY: "made-up-key",
  INCARNAMIND_LIVE_ANTHROPIC_MODEL: "claude-haiku-5-5",
  INCARNAMIND_LIVE_CALLS: "reserved-en-structured-toy",
};

test("strict observations reject multiple selections before any provider attempt", () => {
  expect(() =>
    structuredControls({
      ...controls,
      INCARNAMIND_LIVE_CALLS: "reserved-en-structured-toy,reserved-zh-structured-toy",
    }),
  ).toThrow();
});

const spec: ChatModelSpec = {
  kind: "anthropic",
  modelId: "claude-haiku-5-5",
  baseUrl: null,
  apiKey: "made-up-key",
};

test("the request ledger counts physical stream attempts before any finish event", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: new ReadableStream({ start: () => undefined }) }),
  });
  const ledger = createRequestLedger({ model: spec.modelId });
  await ledger.model(spec, () => model).doStream({ prompt: [] });
  expect(model.doStreamCalls).toHaveLength(1);
  expect(ledger.snapshot().request_count).toBe(1);
});

const usage = (input = 100, cached = 20, written = 30, output = 10): LanguageModelV4Usage => ({
  inputTokens: {
    total: input,
    noCache: input - cached - written,
    cacheRead: cached,
    cacheWrite: written,
  },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const price = {
  currency: "USD" as const,
  input: 2,
  output: 8,
  cacheRead: 0.2,
  tiers: [{ above: 100, input: 4, output: 16, cacheRead: 0.4 }],
};

function stream(parts: readonly LanguageModelV4StreamPart[]) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

test("stream and Generate requests retain actual tool inputs and settle each cache tier separately", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: stream([
        { type: "tool-call", toolCallId: "citation", toolName: "cite", input: '{"citations":[1]}' },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() },
      ]),
    }),
    doGenerate: async () => ({
      content: [{ type: "text", text: '{"supported":true}' }],
      finishReason: { unified: "stop", raw: undefined },
      usage: usage(200, 50, 20, 5),
      warnings: [],
    }),
  });
  const ledger = createRequestLedger({ model: spec.modelId, price });
  const wrapped = ledger.model(spec, () => model);
  await drain((await wrapped.doStream({ prompt: [] })).stream);
  await wrapped.doGenerate({ prompt: [] });
  expect(ledger.snapshot().requests).toMatchObject([
    { status: "completed", usage_complete: true, cost_usd: 0.000259 },
    { status: "completed", usage_complete: true, cost_usd: 0.00072, raw: '{"supported":true}' },
  ]);
  expect(JSON.parse(ledger.snapshot().requests[0]?.raw ?? "")).toEqual({
    type: "tool-call",
    toolName: "cite",
    input: '{"citations":[1]}',
  });
});

test("raw evidence retains reasoning and every streamed tool-input part without truncation", async () => {
  const input = JSON.stringify({ text: "实际工具输入".repeat(2_000) });
  const parts: LanguageModelV4StreamPart[] = [
    { type: "reasoning-delta", id: "reason", delta: "Actual reasoning" },
    { type: "tool-input-start", id: "tool", toolName: "cite" },
    { type: "tool-input-delta", id: "tool", delta: input },
    { type: "tool-input-end", id: "tool" },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() },
  ];
  const provider = new MockLanguageModelV4({ doStream: async () => ({ stream: stream(parts) }) });
  const ledger = createRequestLedger({ model: spec.modelId, price });
  await drain((await ledger.model(spec, () => provider).doStream({ prompt })).stream);
  expect(ledger.snapshot().requests[0]?.raw).toBe(
    JSON.stringify({ type: "reasoning-delta", text: "Actual reasoning" }) +
      JSON.stringify({ type: "tool-input-start", id: "tool", toolName: "cite" }) +
      JSON.stringify({ type: "tool-input-delta", id: "tool", delta: input }) +
      JSON.stringify({ type: "tool-input-end", id: "tool" }),
  );
});

test.each([
  "provider-throw",
  "stream-throw",
  "error-part",
  "missing-finish",
  "missing-usage",
] as const)(
  "%s latches the shared factory and refuses every later network attempt locally",
  async (kind) => {
    const fetch = vi.fn(async () => {
      if (kind === "provider-throw") throw new TypeError("made-up-key transport detail");
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetch);
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await toyRequest();
        if (kind === "stream-throw")
          return {
            stream: new ReadableStream({
              start(c) {
                c.error(new Error("private diagnostic"));
              },
            }),
          };
        if (kind === "error-part")
          return { stream: stream([{ type: "error", error: new Error("private diagnostic") }]) };
        const incomplete = usage();
        incomplete.inputTokens.total = undefined;
        return {
          stream: stream([
            { type: "text-delta", id: "answer", delta: "Partial actual reply" },
            ...(kind === "missing-finish"
              ? []
              : [
                  {
                    type: "finish" as const,
                    finishReason: { unified: "stop" as const, raw: undefined },
                    usage: incomplete,
                  },
                ]),
          ]),
        };
      },
    });
    const ledger = createRequestLedger({
      model: spec.modelId,
      price,
      strict: structuredControls(controls),
    });
    const restore = ledger.installTransportGuard();
    try {
      const wrapped = ledger.model(spec, () => model);
      await expect(
        (async () => drain((await wrapped.doStream({ prompt: [] })).stream))(),
      ).rejects.toThrow();
      await expect(wrapped.doStream({ prompt: [] })).rejects.toThrow();
      expect(model.doStreamCalls).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(ledger.snapshot()).toMatchObject({
        request_count: 1,
        retry_count: 1,
        physical_network_count: 1,
      });
    } finally {
      restore();
    }
  },
);

test.each([
  { INCARNAMIND_STRUCTURED_RECEIPT: "relative.json" },
  { INCARNAMIND_STRUCTURED_CANDIDATE: "not-a-candidate" },
  { INCARNAMIND_STRUCTURED_CAP_USD: "1" },
  { INCARNAMIND_DATA_DIR: "relative-data" },
  { INCARNAMIND_LIVE_REPORT: undefined },
  { INCARNAMIND_LIVE_REPLIES: undefined },
  { INCARNAMIND_LIVE_ANTHROPIC_KEY: undefined },
  { INCARNAMIND_LIVE_ANTHROPIC_MODEL: undefined },
  { INCARNAMIND_LIVE_ANTHROPIC_MODEL: "other-model" },
  { INCARNAMIND_LIVE_OLLAMA_MODEL: "local-model" },
  { INCARNAMIND_LIVE_CALLS: "reserved-en-historical" },
])("strict controls refuse missing or substituted runtime controls: %j", (invalid) => {
  expect(() => structuredControls({ ...controls, ...invalid })).toThrow();
});

test("absent strict mode keeps legacy selection and environment behavior", () => {
  expect(structuredControls({ INCARNAMIND_LIVE_CALLS: "historical-call" })).toBeNull();
  expect(structuredControls({ ...controls, INCARNAMIND_STRUCTURED_RECEIPT: undefined })).toBeNull();
  expect(structuredControls(controls)).toMatchObject({ model: "claude-haiku-5-5", cap: 0.25 });
});

test.each([false, true])(
  "non-strict observation preserves provider error results for existing consumers (streamed: %s)",
  async (streamed) => {
    const providerError = new Error("Toy provider failure");
    const finishReason = { unified: "error" as const, raw: undefined };
    const provider = new MockLanguageModelV4({
      doStream: async () => ({
        stream: stream([
          { type: "error", error: providerError },
          { type: "finish", finishReason, usage: usage() },
        ]),
      }),
      doGenerate: async () => ({
        content: [],
        finishReason,
        usage: usage(),
        warnings: [],
      }),
    });
    const ledger = createRequestLedger({ model: spec.modelId, price });
    const wrapped = ledger.model(spec, () => provider);
    if (streamed) {
      const reader = (await wrapped.doStream({ prompt })).stream.getReader();
      await expect(reader.read()).resolves.toMatchObject({
        value: { type: "error", error: providerError },
      });
      await expect(reader.read()).resolves.toMatchObject({ value: { type: "finish" } });
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } else await expect(wrapped.doGenerate({ prompt })).resolves.toMatchObject({ finishReason });
  },
);

test.each([
  undefined,
  { ...price, input: 0 },
  { ...price, cacheRead: undefined },
  { ...price, output: Number.NaN },
])("strict observations refuse unknown or free catalog prices before requests", (price) =>
  expect(() =>
    createRequestLedger({ model: spec.modelId, price, strict: structuredControls(controls) }),
  ).toThrow(),
);

test.each(["reader-error", "cancel"] as const)(
  "HTTP 200 then %s cannot publish a pass or send again",
  async (kind) => {
    vi.resetModules();
    const { createAiSdkChatModel } = await import("../../src/core/providers/models");
    let failRead: () => void = () => undefined;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              failRead = () => controller.error(new Error("private streaming diagnostic"));
              controller.enqueue(
                new TextEncoder().encode(
                  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...message, content: [], stop_reason: null } })}\n\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const ledger = createRequestLedger({
      model: spec.modelId,
      price,
      strict: structuredControls(controls),
    });
    const restore = ledger.installTransportGuard();
    try {
      const model = ledger.model(spec, () => createAiSdkChatModel(spec));
      const result = await model.doStream({ prompt, maxOutputTokens: 16 });
      if (kind === "reader-error") {
        failRead();
        await expect(drain(result.stream)).rejects.toThrow();
      } else await result.stream.cancel();
      await expect(model.doGenerate({ prompt, maxOutputTokens: 16 })).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(ledger.snapshot()).toMatchObject({
        status: "failed",
        physical_network_count: 1,
        request_count: 1,
        retry_count: 1,
        unsettled_requests: 1,
      });
      expect(ledger.snapshot().requests[0]?.cost_usd).toBeNull();
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(fetch);
  },
);

test.each([
  { baseUrl: "https://different.invalid/v1" },
  { baseUrl: `${endpointUrl("anthropic")}?extra=1` },
  { endpoint: "unknown-endpoint" },
  { modelId: "other-model" },
  { apiKey: "different-made-up-key" },
  { kind: "openai" as const },
])(
  "strict models refuse endpoint/model/provider/key substitution before building: %j",
  (change) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const ledger = createRequestLedger({
      model: spec.modelId,
      price,
      strict: structuredControls(controls),
    });
    const restore = ledger.installTransportGuard();
    const build = vi.fn(() => new MockLanguageModelV4());
    try {
      expect(() => ledger.model({ ...spec, ...change }, build)).toThrow();
      expect(build).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  },
);

test("strict transport ownership is exclusive, accepts the normalized catalog endpoint, and restores fetch", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const ledger = createRequestLedger({
    model: spec.modelId,
    price,
    strict: structuredControls(controls),
  });
  const other = createRequestLedger({
    model: spec.modelId,
    price,
    strict: structuredControls(controls),
  });
  const restore = ledger.installTransportGuard();
  try {
    expect(() => other.installTransportGuard()).toThrow();
    expect(() =>
      ledger.model(
        { ...spec, baseUrl: `${endpointUrl("anthropic")}/`, endpoint: "global" },
        () => new MockLanguageModelV4(),
      ),
    ).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    restore();
  }
  expect(globalThis.fetch).toBe(fetch);
});

test("explicit zero cache counts settle, missing totals retain a known sibling cost and stay unsettled", async () => {
  let request = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const actual = usage(0, 0, 0, 5);
      if (request++ > 0) actual.inputTokens.total = undefined;
      return {
        content: [{ type: "text", text: "Actual reply" }],
        usage: actual,
        warnings: [],
        finishReason: { unified: "stop", raw: undefined },
      };
    },
  });
  const ledger = createRequestLedger({ model: spec.modelId, price });
  const wrapped = ledger.model(spec, () => model);
  await wrapped.doGenerate({ prompt });
  await wrapped.doGenerate({ prompt });
  expect(ledger.snapshot()).toMatchObject({
    request_count: 2,
    unsettled_requests: 1,
    total_usd: 0.00004,
    status: "failed",
  });
  expect(ledger.snapshot().requests).toMatchObject([
    {
      usage_complete: true,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.00004,
    },
    { usage_complete: false, input_tokens: null, cost_usd: null },
  ]);
});

test.each(["budget", "credential"] as const)(
  "observed %s failure preserves known cost, aborts and blocks another physical request",
  async (kind) => {
    const network = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", network);
    const ledger = createRequestLedger({
      model: spec.modelId,
      price,
      strict: structuredControls(controls),
    });
    const restore = ledger.installTransportGuard();
    try {
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          await toyRequest();
          return {
            content: [
              { type: "text", text: kind === "credential" ? "made-up-key" : "Actual reply" },
            ],
            usage: kind === "budget" ? usage(300_000, 0, 0, 5) : usage(),
            warnings: [],
            finishReason: { unified: "stop", raw: undefined },
          };
        },
      });
      const wrapped = ledger.model(spec, () => model);
      await expect(wrapped.doGenerate({ prompt })).rejects.toThrow();
      await expect(wrapped.doGenerate({ prompt })).rejects.toThrow();
      expect(network).toHaveBeenCalledTimes(1);
      expect(ledger.snapshot()).toMatchObject({
        status: "failed",
        request_count: 1,
        physical_network_count: 1,
        retry_count: 1,
      });
      expect(ledger.snapshot().requests[0]?.usage_complete).toBe(true);
      expect(ledger.snapshot().requests[0]?.cost_usd).toBeGreaterThan(0);
      if (kind === "budget")
        expect(ledger.snapshot().budget_error).toBe("observation-cap-exceeded");
      else {
        expect(ledger.snapshot().provider_error).toBe("credential");
        expect(JSON.stringify(ledger.snapshot())).not.toContain("made-up-key");
      }
    } finally {
      restore();
    }
  },
);

test("a physical fetch failure aborts a previously started sibling signal", async () => {
  let calls = 0;
  const network = vi.fn(async () => {
    if (++calls > 1) throw new TypeError("private diagnostic");
    return Response.json({});
  });
  vi.stubGlobal("fetch", network);
  const ledger = createRequestLedger({
    model: spec.modelId,
    price,
    strict: structuredControls(controls),
  });
  const restore = ledger.installTransportGuard();
  let siblingSignal: AbortSignal | undefined;
  try {
    const provider = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        siblingSignal = abortSignal;
        await toyRequest();
        return { stream: new ReadableStream<LanguageModelV4StreamPart>() };
      },
      doGenerate: async () => {
        await toyRequest();
        throw new Error("Unreachable toy result");
      },
    });
    const wrapped = ledger.model(spec, () => provider);
    const first = await wrapped.doStream({ prompt });
    expect(siblingSignal?.aborted).toBe(false);
    await expect(wrapped.doGenerate({ prompt })).rejects.toThrow();
    expect(siblingSignal?.aborted).toBe(true);
    await first.stream.cancel();
    await expect(wrapped.doGenerate({ prompt })).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(2);
    expect(ledger.snapshot()).toMatchObject({
      status: "failed",
      request_count: 2,
      physical_network_count: 2,
    });
  } finally {
    restore();
  }
});

function noteEvidence(dataDir: string): ObservationEvidence {
  return {
    fill: {
      state: "filled",
      mode: "notes",
      local: false,
      problem: null,
      omitted: 0,
      unfinishedParts: 0,
    },
    fill_ms: 1,
    data_dir: dataDir,
    saved_cues: [{ text: "Toy saved cue", startMs: 0, endMs: 1_000, speaker: null }],
    original_note_json: { type: "doc", content: [] },
    filled_note_json: { type: "doc", content: [{ type: "paragraph" }] },
    undo_note_json: { type: "doc", content: [] },
  };
}

test.each([true, false])(
  "receipt output is once-only, bound to the actual report, and follows completed assertions: %s",
  async (passed) => {
    const directory = await createTempDataFolder();
    const strict = structuredControls({
      ...controls,
      INCARNAMIND_DATA_DIR: join(directory, "data"),
      INCARNAMIND_STRUCTURED_RECEIPT: join(directory, "receipt.json"),
      INCARNAMIND_LIVE_REPORT: join(directory, "report.md"),
    });
    if (!strict) throw new Error("Missing toy controls");
    const ledger = createRequestLedger({ model: spec.modelId, price, strict });
    const network = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", network);
    const observation = await startObservation(strict, ledger);
    const restore = ledger.installTransportGuard();
    try {
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          await toyRequest();
          return {
            content: [{ type: "text", text: "Actual generated reply" }],
            usage: usage(),
            warnings: [],
            finishReason: { unified: "stop", raw: undefined },
          };
        },
      });
      await ledger.model(spec, () => model).doGenerate({ prompt });
      const evidence = noteEvidence(strict.dataDir);
      observation.capture(evidence);
      for (const name of V5_CHECKS) {
        if (!passed && name === "once") {
          expect(() =>
            observation.check(name, () => {
              throw new Error("Toy scorer assertion failed");
            }),
          ).toThrow();
        } else observation.check(name, () => expect(ledger.snapshot().request_count).toBe(1));
      }
      const receipt = await observation.finish(passed);
      expect(receipt.pipeline.status).toBe(passed ? "pass" : "failed");
      expect(receipt.quality.v5_checks.once).toBe(passed);
      expect(receipt.evidence).toMatchObject({
        original_note_json: evidence.original_note_json,
        filled_note_json: evidence.filled_note_json,
        undo_note_json: evidence.undo_note_json,
        saved_cues: evidence.saved_cues,
        raw_replies: ["Actual generated reply"],
      });
      const report = await readFile(strict.report);
      expect(receipt.evidence.report_sha256).toBe(
        createHash("sha256").update(report).digest("hex"),
      );
      expect(report.toString()).toContain("Toy saved cue");
      expect(JSON.parse(await readFile(strict.receipt, "utf8"))).toEqual(receipt);
      await expect(observation.finish(passed)).rejects.toThrow("already finalized");
      await expect(startObservation(strict, ledger)).rejects.toThrow();
      expect(network).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  },
);

afterEach(() => vi.unstubAllGlobals());

function toyRequest(init: RequestInit = {}) {
  const base = endpointUrl("anthropic");
  if (!base) throw new Error("Missing catalog endpoint");
  return globalThis.fetch(`${base.replace(/\/+$/, "")}/messages`, {
    method: "POST",
    headers: { "x-api-key": "made-up-key" },
    body: JSON.stringify({ model: spec.modelId }),
    ...init,
  });
}

const message = {
  id: "msg_toy",
  type: "message",
  role: "assistant",
  model: spec.modelId,
  content: [{ type: "text", text: "Toy reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 2 },
};

function providerResponse(streamed: boolean) {
  if (!streamed) return Response.json(message);
  const events = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Toy reply" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function refusalThenReply(streamed: boolean) {
  let calls = 0;
  const fetch = vi.fn(async () =>
    ++calls === 1
      ? Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "output_config.effort: Extra inputs are not permitted",
            },
          },
          { status: 400 },
        )
      : providerResponse(streamed),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const prompt = [
  { role: "user" as const, content: [{ type: "text" as const, text: "Toy request" }] },
];

test.each([false, true])(
  "real provider factory hides two HTTP attempts under one logical wrapper (streamed: %s)",
  async (streamed) => {
    vi.resetModules();
    const { createAiSdkChatModel } = await import("../../src/core/providers/models");
    const fetch = refusalThenReply(streamed);
    const ledger = createRequestLedger({ model: spec.modelId, price });
    const answering = { ...spec, thinking: "answer" as const };
    const model = ledger.model(answering, () => createAiSdkChatModel(answering));
    if (streamed) await drain((await model.doStream({ prompt, maxOutputTokens: 16 })).stream);
    else await model.doGenerate({ prompt, maxOutputTokens: 16 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ledger.snapshot().request_count).toBe(1);
  },
);

test.each([false, true])(
  "strict transport settles the real provider's single physical request (streamed: %s)",
  async (streamed) => {
    vi.resetModules();
    const { createAiSdkChatModel } = await import("../../src/core/providers/models");
    const network = vi.fn(async () => providerResponse(streamed));
    vi.stubGlobal("fetch", network);
    const ledger = createRequestLedger({
      model: spec.modelId,
      price,
      strict: structuredControls(controls),
    });
    const restore = ledger.installTransportGuard();
    try {
      const model = ledger.model(spec, () => createAiSdkChatModel(spec));
      if (streamed) await drain((await model.doStream({ prompt, maxOutputTokens: 16 })).stream);
      else await model.doGenerate({ prompt, maxOutputTokens: 16 });
      expect(network).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.objectContaining({ redirect: "manual" }),
      );
      expect(ledger.snapshot()).toMatchObject({
        status: "pass",
        request_count: 1,
        logical_request_count: 1,
        physical_network_count: 1,
        unsettled_requests: 0,
        retry_count: 0,
        http_statuses: [200],
        provider_error: null,
        network_error: null,
        budget_error: null,
        requests: [{ raw: "Toy reply", usage_complete: true }],
      });
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(network);
  },
);

test.each([false, true])(
  "strict transport stops the real provider factory's hidden HTTP retry (streamed: %s)",
  async (streamed) => {
    vi.resetModules();
    const { createAiSdkChatModel } = await import("../../src/core/providers/models");
    const fetch = refusalThenReply(streamed);
    const ledger = createRequestLedger({
      model: spec.modelId,
      price,
      strict: structuredControls(controls),
    });
    const restore = ledger.installTransportGuard();
    try {
      const answering = { ...spec, thinking: "answer" as const };
      const model = ledger.model(answering, () => createAiSdkChatModel(answering));
      await expect(
        (async () => {
          if (streamed) await drain((await model.doStream({ prompt, maxOutputTokens: 16 })).stream);
          else await model.doGenerate({ prompt, maxOutputTokens: 16 });
        })(),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(ledger.snapshot()).toMatchObject({
        request_count: 1,
        retry_count: 1,
        status: "failed",
      });
      expect(ledger.snapshot().requests[0]).toMatchObject({
        status: "failed",
        usage_complete: false,
        cost_usd: null,
      });
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(fetch);
  },
);

test.each([
  { omitted: 1 },
  { unfinishedParts: 1 },
  { problem: { kind: "model" as const, message: "partial" } },
])(
  "exit-zero and asserted booleans cannot promote a partial fill to a receipt pass: %j",
  async (partial) => {
    const strict = structuredControls(controls);
    if (!strict) throw new Error("Missing toy controls");
    const ledger = createRequestLedger({ model: spec.modelId, price });
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "Actual toy reply" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    });
    await ledger.model(spec, () => model).doGenerate({ prompt });
    expect(ledger.snapshot().status).toBe("pass");
    const receipt = observationReceipt(strict, ledger, {
      assertionsPassed: true,
      checks: Object.fromEntries(V5_CHECKS.map((name) => [name, true])),
      evidence: {
        fill: { state: "filled", mode: "notes", local: false, problem: null, ...partial },
        fill_ms: 1,
        data_dir: strict.dataDir,
        saved_cues: [{ text: "Toy transcript", startMs: 0, endMs: 1_000, speaker: null }],
        original_note_json: { type: "doc", content: [] },
        filled_note_json: { type: "doc", content: [{ type: "paragraph" }] },
        undo_note_json: { type: "doc", content: [] },
      },
    });
    expect(receipt.quality.v5_status).toBe("failed");
    expect(receipt.pipeline).toMatchObject({
      status: "failed",
      provider_error: null,
      network_error: null,
      budget_error: null,
    });
  },
);
