import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import {
  ATTRIBUTION_SHA256,
  attributionUsage,
  observeAttribution,
  requireAttributionDry,
  runAttributionDry,
} from "../../eval/attribution/adapter";
import frozen from "../../eval/attribution/cases.json";
import { attributionInput } from "../../eval/attribution/scoring";
import { failingModel, replyingModel, streamingModel } from "../helpers/models";

test.each([NaN, Infinity, -1])("invalid reported usage stays unknown: %s", (invalid) => {
  for (const input of [
    { total: invalid, cacheRead: 0, cacheWrite: 0 },
    { total: 1, cacheRead: invalid, cacheWrite: 0 },
    { total: 1, cacheRead: 0, cacheWrite: invalid },
  ])
    expect(attributionUsage({ inputTokens: input, outputTokens: { total: 0 } }).known).toBe(false);
  expect(
    attributionUsage({ inputTokens: { total: 1 }, outputTokens: { total: invalid } }).known,
  ).toBe(false);
});

test("known zero and explicit cache reads/writes are retained without inventing missing counts", () => {
  expect(
    attributionUsage({
      inputTokens: { total: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0 },
    }),
  ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, known: true, cacheComplete: true });
  expect(
    attributionUsage({
      inputTokens: { total: 10, cacheRead: 3, cacheWrite: 4 },
      outputTokens: { total: 2 },
    }),
  ).toMatchObject({ cacheRead: 3, cacheWrite: 4, known: true });
  expect(
    attributionUsage({ inputTokens: { total: 10 }, outputTokens: { total: 2 } }),
  ).toMatchObject({ cacheRead: null, cacheWrite: null, known: true, cacheComplete: false });
});

test("both provider entrypoints and unmatched setup requests remain counted", async () => {
  const model = replyingModel("ordinary response");
  const observed = observeAttribution(() => model);
  const wrapped = observed.factory({
    kind: "ollama",
    modelId: "local-model",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: null,
  });
  await wrapped.doGenerate({ prompt: [] });
  const stream = observeAttribution(() => streamingModel("streamed response"));
  stream.setCase("C01-en");
  const reply = await stream
    .factory({
      kind: "ollama",
      modelId: "local-model",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: null,
    })
    .doStream({ prompt: [] });
  for await (const part of reply.stream) void part;
  expect(observed.requests).toHaveLength(1);
  expect(observed.requests[0]).toMatchObject({
    caseId: null,
    mode: "generate",
    kind: "other",
    status: "complete",
    reply: "ordinary response",
  });
  expect(stream.requests).toHaveLength(1);
  expect(stream.requests[0]).toMatchObject({
    caseId: "C01-en",
    mode: "stream",
    status: "complete",
    reply: "streamed response",
  });
});

test("a failed first request is retained with unknown usage and no arbitrary error fields", async () => {
  const observed = observeAttribution(() => failingModel(402, "A synthetic account refusal."));
  const model = observed.factory({
    kind: "ollama",
    modelId: "local-model",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: null,
  });
  await expect(model.doGenerate({ prompt: [] })).rejects.toThrow("synthetic account refusal");
  expect(observed.requests[0]).toMatchObject({
    status: "error",
    usage: { known: false },
    error: { status: 402 },
  });
  expect(Object.keys(observed.requests[0]?.error ?? {}).sort()).toEqual(["name", "status"]);
});

test("cancelling an unfinished stream retains the aborted attempt", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        pull(controller) {
          controller.enqueue({ type: "text-delta", id: "answer", delta: "partial" });
        },
      }),
    }),
  });
  const observed = observeAttribution(() => model);
  const reply = await observed
    .factory({
      kind: "ollama",
      modelId: "local-model",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: null,
    })
    .doStream({ prompt: [] });
  const reader = reply.stream.getReader();
  await reader.read();
  await reader.cancel();
  expect(observed.requests[0]).toMatchObject({
    status: "aborted",
    reply: expect.stringContaining("partial"),
    usage: { known: false },
  });
});

test("a provider error chunk stays failed after finish without changing either chunk", async () => {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "error", error: new Error("A synthetic provider failure.") },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 7, noCache: 3, cacheRead: 2, cacheWrite: 2 },
        outputTokens: { total: 2, text: 2, reasoning: undefined },
      },
    },
  ];
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    }),
  });
  const observed = observeAttribution(() => model);
  const reply = await observed
    .factory({
      kind: "ollama",
      modelId: "local-model",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: null,
    })
    .doStream({ prompt: [] });
  const received: LanguageModelV4StreamPart[] = [];
  for await (const chunk of reply.stream) received.push(chunk);
  expect(received).toHaveLength(chunks.length);
  for (const [index, chunk] of chunks.entries()) expect(received[index]).toBe(chunk);
  expect(observed.requests).toHaveLength(1);
  expect(observed.requests[0]).toMatchObject({
    status: "error",
    error: { name: "Error", status: null },
    usage: { input: 7, output: 2, cacheRead: 2, cacheWrite: 2, known: true },
  });
});

test("paid execution refuses before opening a host and input contains no scorer data", async () => {
  expect(() => requireAttributionDry("paid")).toThrow("Paid attribution measurement is disabled");
  await expect(runAttributionDry({ arm: "before", mode: "paid" })).rejects.toThrow(
    "Paid attribution measurement is disabled",
  );
  const ids = new Map(frozen.sources.map((source) => [source.id, crypto.randomUUID()]));
  for (const sample of frozen.cases) {
    const input = attributionInput(frozen, sample, ids);
    expect(Object.keys(input.check).sort()).toEqual(["claim", "scope"]);
    expect(input.check.claim).toBe(sample.text);
    expect(JSON.stringify(input)).not.toContain(sample.gold.rationale);
  }
});

test("all40 frozen cases retain their public outcomes and every scripted provider request", async () => {
  const saved: string[] = [];
  const result = await runAttributionDry({
    arm: "after",
    onCase: async (row) => {
      saved.push(row.id);
    },
  });
  expect(result.manifest).toMatchObject({
    fixtureSHA256: ATTRIBUTION_SHA256,
    qualityMeasurement: false,
    caseCount: 40,
    sourceCount: 48,
    profileCount: 40,
    paidEnabled: false,
  });
  expect(saved).toEqual(frozen.cases.map((sample) => sample.id));
  expect(result.rows).toHaveLength(40);
  expect(result.scores.rows).toHaveLength(40);
  expect(result.summary.executed).toBe(40);
  expect(result.rows.every((row) => row.status === "returned")).toBe(true);
  expect(result.rows.flatMap((row) => row.requests)).toEqual(
    result.requests.filter((request) => request.caseId !== null).map((request) => request.number),
  );
  expect(result.importedDocuments).toHaveLength(48);
  expect(result.importedDocuments.every((document) => document.createdAtApplied === false)).toBe(
    true,
  );
  expect(result.requests.every((request) => request.status !== "running")).toBe(true);
  const actualInputs = JSON.stringify(result.requests.map((request) => request.messages));
  for (const sample of frozen.cases) expect(actualInputs).not.toContain(sample.gold.rationale);
  for (const source of frozen.sources) expect(actualInputs).not.toContain(source.id);
});
