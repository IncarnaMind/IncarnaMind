import { mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import {
  ATTRIBUTION_SHA256,
  observeAttribution,
  runAttributionCases,
} from "../../eval/attribution/adapter";
import {
  ATTRIBUTION_PILOT_CASES,
  type AttributionPilotPlan,
  attributionPilotJSON,
  createAttributionPilotBudget,
  EMPTY_SOURCE_DIFF_SHA256,
  validateAttributionPilot,
} from "../../eval/attribution/pilot";
import type { Price } from "../../src/core/providers/catalog/types";
import { createTempDataFolder } from "../helpers/core";
import { failingModel, scriptedModel } from "../helpers/models";

const price: Price = { currency: "USD", input: 2, output: 10, cacheRead: 0.1 };
const plan: AttributionPilotPlan = {
  phase: "pilot",
  arm: "before",
  model: "claude-sonnet-5-5",
  capUSD: 2,
  pins: { before: "a".repeat(40), after: "b".repeat(40) },
  sourceHead: "a".repeat(40),
  sourceDiffSHA256: EMPTY_SOURCE_DIFF_SHA256,
  fixtureSHA256: ATTRIBUTION_SHA256,
  caseIds: ATTRIBUTION_PILOT_CASES,
  sharedHashes: {
    adapter: "c".repeat(64),
    scorer: "d".repeat(64),
    host: "e".repeat(64),
    entry: "f".repeat(64),
  },
  expectedSharedHashes: {
    adapter: "c".repeat(64),
    scorer: "d".repeat(64),
    host: "e".repeat(64),
    entry: "f".repeat(64),
  },
};
const spec = { kind: "anthropic" as const, modelId: plan.model, apiKey: null, baseUrl: null };
const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 5, cacheRead: 2, cacheWrite: 3 },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const finish = (reported = usage): LanguageModelV4StreamPart => ({
  type: "finish",
  finishReason: { unified: "stop", raw: undefined },
  usage: reported,
});
function mock(reported = usage, chunks: LanguageModelV4StreamPart[] = [finish(reported)]) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "Synthetic response." }],
      finishReason: { unified: "stop", raw: undefined },
      usage: reported,
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of chunks) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });
}
async function budget(overrides: Partial<AttributionPilotPlan> = {}) {
  const folder = await createTempDataFolder();
  const ledgerPath = join(folder, "pilot-ledger.json");
  const options = {
    plan: { ...plan, ...overrides },
    ledgerPath,
    price,
    reservationPrice: price,
    defaultOutputTokens: 128000,
    cacheWritePolicy: "5m" as const,
  };
  return { ...createAttributionPilotBudget(options), options, ledgerPath };
}

test.each([
  { phase: "full" },
  { capUSD: NaN },
  { capUSD: 0 },
  { sourceHead: "b".repeat(40) },
  { sourceDiffSHA256: "c".repeat(64) },
  { fixtureSHA256: "c".repeat(64) },
  { caseIds: ["N01-en"] },
  { caseIds: [...ATTRIBUTION_PILOT_CASES].reverse() },
])("pilot refuses changed admission before provider/ledger creation: %j", async (change) => {
  const folder = await createTempDataFolder();
  const ledgerPath = join(folder, "ledger.json");
  expect(() => validateAttributionPilot({ ...plan, ...change })).toThrow();
  expect(() =>
    createAttributionPilotBudget({
      plan: { ...plan, ...change },
      ledgerPath,
      price,
      reservationPrice: price,
      defaultOutputTokens: 128000,
      cacheWritePolicy: "5m" as const,
    }),
  ).toThrow();
  expect(() => readFileSync(ledgerPath)).toThrow();
});

test("both actual SDK entrypoints retain app limits, usage cost and restart history", async () => {
  const cost = await budget();
  const model = mock();
  const observed = observeAttribution(() => model, cost.hooks);
  const wrapped = observed.factory(spec);
  await wrapped.doGenerate({ prompt: [] });
  const streamed = await wrapped.doStream({ prompt: [], maxOutputTokens: 300 });
  for await (const part of streamed.stream) void part;
  expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(128000);
  expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(300);
  expect(observed.requests).toHaveLength(2);
  const ledger = cost.snapshot();
  expect(ledger.entries[0]?.maximumUSD).toBeGreaterThanOrEqual(1.28);
  expect(ledger.entries[1]?.maximumUSD).toBeLessThan(0.01);
  expect(ledger.entries.every((entry) => entry.status === "settled")).toBe(true);
  expect(ledger.chargedUSD).toBeCloseTo(0.0000754, 12);
  const bytes = readFileSync(cost.ledgerPath, "utf8");
  const restarted = createAttributionPilotBudget(cost.options);
  expect(restarted.snapshot()).toEqual(ledger);
  expect(readFileSync(cost.ledgerPath, "utf8")).toBe(bytes);
});

test("an insufficient ceiling refuses before either provider entrypoint", async () => {
  const cost = await budget({ capUSD: 0.01 });
  const model = mock();
  const observed = observeAttribution(() => model, cost.hooks);
  const wrapped = observed.factory(spec);
  await expect(wrapped.doGenerate({ prompt: [] })).rejects.toThrow("ceiling");
  await expect(wrapped.doStream({ prompt: [] })).rejects.toThrow("stopped");
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(model.doStreamCalls).toHaveLength(0);
  expect(cost.snapshot()).toMatchObject({ chargedUSD: 0, entries: [] });
  expect(observed.requests).toHaveLength(2);
  expect(observed.requests.every((request) => request.status === "error")).toBe(true);
});

test.each([undefined, NaN, Infinity, -1, 11])(
  "unknown or invalid cache billing keeps the maximum: %s",
  async (cacheWrite) => {
    const cost = await budget();
    const model = mock({ ...usage, inputTokens: { ...usage.inputTokens, cacheWrite } });
    const observed = observeAttribution(() => model, cost.hooks);
    await observed.factory(spec).doGenerate({ prompt: [] });
    const ledger = cost.snapshot();
    expect(ledger.entries[0]).toMatchObject({ status: "unknown" });
    expect(ledger.chargedUSD).toBe(ledger.entries[0]?.maximumUSD);
    expect(cost.stopped()).toBe(true);
    const bytes = readFileSync(cost.ledgerPath, "utf8");
    const restarted = createAttributionPilotBudget(cost.options);
    expect(restarted.stopped()).toBe(true);
    expect(restarted.snapshot()).toEqual(ledger);
    expect(readFileSync(cost.ledgerPath, "utf8")).toBe(bytes);
  },
);

test("cancellation retains the full unfinished reservation across restart", async () => {
  const cost = await budget();
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        pull(controller) {
          controller.enqueue({ type: "text-delta", id: "text", delta: "partial" });
        },
      }),
    }),
  });
  const observed = observeAttribution(() => model, cost.hooks);
  const reply = await observed.factory(spec).doStream({ prompt: [] });
  const reader = reply.stream.getReader();
  await reader.read();
  await reader.cancel();
  const ledger = cost.snapshot();
  expect(ledger.entries[0]).toMatchObject({ status: "unknown", outcome: "aborted" });
  expect(ledger.chargedUSD).toBe(ledger.entries[0]?.maximumUSD);
  expect(createAttributionPilotBudget(cost.options).stopped()).toBe(true);
});

test("an error chunk followed by finish stays failed and keeps the original chunks", async () => {
  const cost = await budget();
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "error", error: new Error("Synthetic failure.") },
    finish(),
  ];
  const model = mock(usage, chunks);
  const observed = observeAttribution(() => model, cost.hooks);
  const reply = await observed.factory(spec).doStream({ prompt: [] });
  const received: LanguageModelV4StreamPart[] = [];
  for await (const part of reply.stream) received.push(part);
  for (const [index, part] of chunks.entries()) expect(received[index]).toBe(part);
  expect(observed.requests[0]).toMatchObject({ status: "error", usage: { known: true } });
  expect(cost.snapshot().entries[0]).toMatchObject({ status: "settled", outcome: "error" });
  expect(cost.snapshot().chargedUSD).toBeCloseTo(0.0000377, 12);
});

test.each([401, 402])(
  "authentication/billing refusal stops the entire arm without serializing errors: %s",
  async (status) => {
    const cost = await budget();
    const model = failingModel(status, "Synthetic confidential response value.");
    const observed = observeAttribution(() => model, cost.hooks);
    const wrapped = observed.factory(spec);
    await expect(wrapped.doGenerate({ prompt: [] })).rejects.toThrow();
    await expect(wrapped.doGenerate({ prompt: [] })).rejects.toThrow("stopped");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(cost.stopped()).toBe(true);
    expect(cost.snapshot().entries).toHaveLength(1);
    const retained = JSON.stringify({ requests: observed.requests, ledger: cost.snapshot() });
    expect(retained).not.toContain("Synthetic confidential response value");
    expect(retained).not.toContain("requestBodyValues");
    expect(retained).not.toContain("responseHeaders");
  },
);

test("the factored driver executes only fixed cases while preserving all40 scorer denominators", async () => {
  const saved: string[] = [];
  const model = scriptedModel(
    (call) => ({
      text: `Parts: ${JSON.stringify([{ kind: "fact", text: /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(call.prompt)?.[1] ?? "" }])}\nVerdict: unsupported\nAbsence: no\nCalculation: none\nEvidence: []`,
    }),
    { generate: () => ({ text: "same" }) },
  );
  const result = await runAttributionCases({
    arm: "after",
    mode: "dry",
    model: "scripted/local-model",
    createChatModel: () => model,
    provider: { kind: "ollama", modelId: "local-model" },
    caseIds: ATTRIBUTION_PILOT_CASES,
    onCase: async (row) => {
      saved.push(row.id);
    },
  });
  expect(saved).toEqual(ATTRIBUTION_PILOT_CASES);
  expect(result.manifest).toMatchObject({
    caseCount: 3,
    frozenCaseCount: 40,
    fixtureSHA256: ATTRIBUTION_SHA256,
  });
  expect(result.rows.map((row) => row.id)).toEqual(ATTRIBUTION_PILOT_CASES);
  expect(result.scores.rows).toHaveLength(40);
  const input = JSON.stringify(result.requests.map((request) => request.messages));
  expect(input).not.toContain("nativeVerdict");
  expect(input).not.toContain("facetTargets");
});

test("receipt serialization retains safe findings but removes credentials and whole errors", () => {
  const raw = {
    reply: "Synthetic token-123 result.",
    error: Object.assign(new Error("token-123"), { responseHeaders: { secret: "token-123" } }),
    apiKey: "token-123",
    headers: { authorization: "token-123" },
    providerOptions: { secret: "token-123" },
  };
  const retained = attributionPilotJSON(raw, "token-123");
  expect(JSON.parse(retained)).toEqual({
    reply: "Synthetic [redacted] result.",
    error: { name: "Error" },
  });
  expect(retained).not.toContain("token-123");
});

test("known zero usage settles zero without an unknown hold", async () => {
  const cost = await budget();
  const model = mock({
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: undefined },
  });
  await observeAttribution(() => model, cost.hooks)
    .factory(spec)
    .doGenerate({ prompt: [] });
  expect(cost.snapshot()).toMatchObject({
    chargedUSD: 0,
    entries: [{ status: "settled", chargedUSD: 0 }],
  });
  expect(cost.stopped()).toBe(false);
});

test("restart preserves an actually open provider reservation instead of resetting it", async () => {
  const cost = await budget();
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      entered?.();
      await held;
      return {
        content: [{ type: "text", text: "Synthetic response." }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  const pending = observeAttribution(() => model, cost.hooks)
    .factory(spec)
    .doGenerate({ prompt: [] });
  await began;
  const ledger = cost.snapshot();
  expect(ledger.entries[0]).toMatchObject({ status: "reserved", outcome: "running" });
  const bytes = readFileSync(cost.ledgerPath, "utf8");
  const reopened = createAttributionPilotBudget(cost.options);
  expect(reopened.stopped()).toBe(true);
  expect(reopened.snapshot()).toEqual(ledger);
  expect(readFileSync(cost.ledgerPath, "utf8")).toBe(bytes);
  release?.();
  await pending;
});

test("a settlement write failure stops further admissions and retains the reservation", async () => {
  const cost = await budget();
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      mkdirSync(`${cost.ledgerPath}.lock`);
      return {
        content: [{ type: "text", text: "Synthetic response." }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  const wrapped = observeAttribution(() => model, cost.hooks).factory(spec);
  try {
    await expect(wrapped.doGenerate({ prompt: [] })).rejects.toThrow("ledger");
  } finally {
    rmdirSync(`${cost.ledgerPath}.lock`);
  }
  expect(cost.stopped()).toBe(true);
  expect(cost.snapshot().entries[0]).toMatchObject({ status: "reserved" });
  await expect(wrapped.doGenerate({ prompt: [] })).rejects.toThrow("stopped");
  expect(model.doGenerateCalls).toHaveLength(1);
});

test("CJK and tool payload reserve byte exposure before sending near the ceiling", async () => {
  const cost = await budget({ capUSD: 0.009 });
  const model = mock({
    inputTokens: { total: 4000, noCache: 0, cacheRead: 0, cacheWrite: 4000 },
    outputTokens: { total: 2, text: 2, reasoning: undefined },
  });
  const wrapped = observeAttribution(() => model, cost.hooks).factory(spec);
  await expect(
    wrapped.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "甲".repeat(1000) }] }],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "查".repeat(200),
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
      responseFormat: {
        type: "json",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
      maxOutputTokens: 2,
    }),
  ).rejects.toThrow("ceiling");
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(cost.snapshot().entries).toHaveLength(0);
});

test("reservation rates cannot undercut either billing tier", async () => {
  const cost = await budget();
  expect(() =>
    createAttributionPilotBudget({ ...cost.options, reservationPrice: { ...price, output: 9 } }),
  ).toThrow("below");
  const longInputPrice: Price = { currency: "USD", input: 0.5, output: 2.5, cacheRead: 0.05 };
  const standard: Price = { currency: "USD", input: 0.1, output: 0.5, cacheRead: 0.01 };
  expect(() =>
    createAttributionPilotBudget({
      ...cost.options,
      plan: { ...plan, model: "claude-haiku-5-5" },
      price: standard,
      reservationPrice: standard,
      longInputPrice,
    }),
  ).toThrow("below");
});

test("an unpriced cache policy stops before the provider", async () => {
  const cost = await budget();
  const guarded = createAttributionPilotBudget({ ...cost.options, cacheWritePolicy: "unknown" });
  const model = mock();
  await expect(
    observeAttribution(() => model, guarded.hooks)
      .factory(spec)
      .doGenerate({ prompt: [] }),
  ).rejects.toThrow("five-minute");
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(guarded.stopped()).toBe(true);
});

test("one-hour cache and separately billed provider tools are not sent", async () => {
  for (const paidTool of [false, true]) {
    const cost = await budget();
    const model = mock();
    const wrapped = observeAttribution(() => model, cost.hooks).factory(spec);
    await expect(
      wrapped.doGenerate({
        prompt: [],
        ...(paidTool
          ? {
              tools: [
                {
                  type: "provider",
                  id: "anthropic.web_search_20250305",
                  name: "web_search",
                  args: {},
                },
              ],
            }
          : { providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } } }),
      }),
    ).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(cost.stopped()).toBe(true);
  }
});

test("known-zero auth finish still refuses a restarted arm", async () => {
  const cost = await budget();
  const zero: LanguageModelV4Usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: undefined },
  };
  const chunks: LanguageModelV4StreamPart[] = [
    {
      type: "error",
      error: new APICallError({
        message: "Synthetic authentication refusal.",
        url: "https://example.test",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      }),
    },
    finish(zero),
  ];
  const observed = observeAttribution(() => mock(zero, chunks), cost.hooks);
  const reply = await observed.factory(spec).doStream({ prompt: [] });
  for await (const part of reply.stream) void part;
  expect(cost.snapshot().entries[0]).toMatchObject({
    status: "settled",
    chargedUSD: 0,
    outcome: "error",
  });
  expect(createAttributionPilotBudget(cost.options).stopped()).toBe(true);
});

test("a declared shared-host hash mismatch refuses before the provider factory", async () => {
  const cost = await budget();
  const hashes = {
    adapter: "c".repeat(64),
    scorer: "d".repeat(64),
    host: "e".repeat(64),
    entry: "f".repeat(64),
  };
  const invalid = {
    ...plan,
    sharedHashes: hashes,
    expectedSharedHashes: { ...hashes, adapter: "0".repeat(64) },
  };
  let factories = 0;
  const open = () => {
    createAttributionPilotBudget({ ...cost.options, plan: invalid });
    factories++;
    return mock();
  };
  expect(open).toThrow("hash");
  expect(factories).toBe(0);
});

test("an attempted arm cannot be quality-rerun but a distinct source arm can proceed", async () => {
  const cost = await budget();
  await observeAttribution(() => mock(), cost.hooks)
    .factory(spec)
    .doGenerate({ prompt: [] });
  const restarted = createAttributionPilotBudget(cost.options);
  const model = mock();
  await expect(
    observeAttribution(() => model, restarted.hooks)
      .factory(spec)
      .doGenerate({ prompt: [] }),
  ).rejects.toThrow("stopped");
  expect(model.doGenerateCalls).toHaveLength(0);
  const other = createAttributionPilotBudget({
    ...cost.options,
    plan: { ...plan, arm: "after", sourceHead: plan.pins.after },
  });
  await observeAttribution(() => model, other.hooks)
    .factory(spec)
    .doGenerate({ prompt: [] });
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(other.snapshot().entries.map((entry) => entry.arm)).toEqual(["before", "after"]);
});

test("one ledger cannot silently change source pins or its shared host inventory", async () => {
  const cost = await budget();
  await observeAttribution(() => mock(), cost.hooks)
    .factory(spec)
    .doGenerate({ prompt: [] });
  const bytes = readFileSync(cost.ledgerPath, "utf8");
  expect(() =>
    createAttributionPilotBudget({
      ...cost.options,
      plan: { ...plan, pins: { ...plan.pins, after: "0".repeat(40) } },
    }),
  ).toThrow("ledger");
  const hashes = { ...plan.sharedHashes, adapter: "0".repeat(64) };
  expect(() =>
    createAttributionPilotBudget({
      ...cost.options,
      plan: { ...plan, sharedHashes: hashes, expectedSharedHashes: hashes },
    }),
  ).toThrow("ledger");
  expect(readFileSync(cost.ledgerPath, "utf8")).toBe(bytes);
});

test("undefined app limits become explicit128000 while defined300 is untouched", async () => {
  const cost = await budget();
  const model = mock();
  const observed = observeAttribution(() => model, cost.hooks);
  const wrapped = observed.factory(spec);
  await wrapped.doGenerate({ prompt: [] });
  const reply = await wrapped.doStream({ prompt: [], maxOutputTokens: 300 });
  for await (const part of reply.stream) void part;
  expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(128000);
  expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(300);
  expect(observed.requests.map((request) => request.outputTokens)).toEqual([128000, 300]);
});

test("an unproved positive model default and ceiling above two dollars refuse", async () => {
  const cost = await budget();
  expect(() =>
    createAttributionPilotBudget({ ...cost.options, defaultOutputTokens: 64000 }),
  ).toThrow("output limit");
  expect(() => validateAttributionPilot({ ...plan, capUSD: 2.01 })).toThrow("ceiling");
});

test("ordinary text tool results retain their shape and remain priced", async () => {
  const cost = await budget();
  const model = mock();
  const observed = observeAttribution(() => model, cost.hooks);
  const prompt = [
    {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "Parts: []" },
        {
          type: "tool-call" as const,
          toolCallId: "search-1",
          toolName: "search_documents",
          input: {},
        },
      ],
    },
    {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "search-1",
          toolName: "search_documents",
          output: { type: "text" as const, value: "A synthetic checked Passage." },
        },
      ],
    },
  ];
  await observed.factory(spec).doGenerate({ prompt });
  expect(model.doGenerateCalls[0]?.prompt).toEqual(prompt);
  expect(cost.snapshot().entries[0]?.status).toBe("settled");
  expect(observed.requests[0]?.inputKinds).toEqual([
    { role: "assistant", parts: ["text", "tool-call"] },
    { role: "tool", parts: ["tool-result"] },
  ]);
});

test("unsupported input is diagnosed and durably stops all arms before provider entry", async () => {
  const cost = await budget();
  const model = mock();
  const observed = observeAttribution(() => model, cost.hooks);
  await expect(
    observed.factory(spec).doGenerate({
      prompt: [{ role: "assistant", content: [{ type: "custom", kind: "anthropic.fallback" }] }],
    }),
  ).rejects.toThrow("input part custom");
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(observed.requests[0]?.inputKinds).toEqual([
    { role: "assistant", parts: ["custom:anthropic.fallback"] },
  ]);
  expect(cost.snapshot()).toMatchObject({
    stopKind: "unpriced-request",
    chargedUSD: 0,
    entries: [],
  });
  const restarted = createAttributionPilotBudget({
    ...cost.options,
    plan: { ...plan, arm: "after", sourceHead: plan.pins.after },
  });
  expect(restarted.stopped()).toBe(true);
});

test("a nested non-text tool output refuses before sending", async () => {
  const cost = await budget();
  const model = mock();
  const observed = observeAttribution(() => model, cost.hooks);
  await expect(
    observed.factory(spec).doGenerate({
      prompt: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "search-1",
              toolName: "search_documents",
              output: {
                type: "content",
                value: [
                  {
                    type: "file",
                    mediaType: "image/png",
                    data: { type: "data", data: new Uint8Array([1]) },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  ).rejects.toThrow("tool output file");
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(cost.snapshot().stopKind).toBe("unpriced-request");
});

test("response kind and model diagnostics retain neither response headers nor custom payloads", async () => {
  const cost = await budget();
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "response-metadata", modelId: "synthetic-response-model" },
    {
      type: "custom",
      kind: "anthropic.fallback",
      providerMetadata: { anthropic: { private: "synthetic-private-payload" } },
    },
    finish(),
  ];
  const observed = observeAttribution(() => mock(usage, chunks), cost.hooks);
  const reply = await observed.factory(spec).doStream({ prompt: [] });
  for await (const part of reply.stream) void part;
  expect(observed.requests[0]?.responseModel).toBe("synthetic-response-model");
  expect(observed.requests[0]?.responseKinds).toEqual([
    "response-metadata",
    "custom:anthropic.fallback",
    "finish",
  ]);
  expect(attributionPilotJSON(observed.requests)).not.toContain("synthetic-private-payload");
});
