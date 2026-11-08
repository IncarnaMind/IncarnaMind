import { afterEach, expect, test, vi } from "vitest";
import { costOf, inCurrency } from "../../src/core/cost/price";
import { catalogModel } from "../../src/core/providers/catalog";
import { endpointUrl } from "../../src/core/providers/kinds";
import { type ChatModelSpec, createAiSdkChatModel } from "../../src/core/providers/models";
import gate from "../fixtures/meetings/fill-structured-gate.json";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  createRequestLedger,
  observationReceipt,
  structuredControls,
} from "../helpers/meetingFillObservation";
import { drain } from "../helpers/streams";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const controls = {
  INCARNAMIND_STRUCTURED_RECEIPT: "/isolated/observation.json",
  INCARNAMIND_STRUCTURED_CANDIDATE: "a".repeat(40),
  INCARNAMIND_STRUCTURED_CAP_USD: "0.25",
  INCARNAMIND_DATA_DIR: "/isolated/data",
  INCARNAMIND_LIVE_REPORT: "/isolated/observation.md",
  INCARNAMIND_LIVE_REPLIES: "1",
  INCARNAMIND_LIVE_DEEPSEEK_KEY: "made-up-deepseek-key",
  INCARNAMIND_LIVE_DEEPSEEK_MODEL: "deepseek-flash",
  INCARNAMIND_LIVE_CALLS: "reserved-en-structured-m",
};
const spec: ChatModelSpec = {
  kind: "deepseek",
  modelId: "deepseek-flash",
  apiKey: controls.INCARNAMIND_LIVE_DEEPSEEK_KEY,
  baseUrl: endpointUrl("deepseek"),
  endpoint: "global",
};
const prompt = [
  { role: "user" as const, content: [{ type: "text" as const, text: "Toy request" }] },
];
const tokens = {
  prompt_tokens: 12,
  prompt_cache_hit_tokens: 4,
  prompt_cache_miss_tokens: 8,
  completion_tokens: 2,
  total_tokens: 14,
};

function response(streamed: boolean, usage: Record<string, unknown>) {
  const base = {
    id: "toy-completion",
    object: streamed ? "chat.completion.chunk" : "chat.completion",
    created: 1,
    model: spec.modelId,
  };
  if (!streamed)
    return Response.json({
      ...base,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage,
    });
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...base, choices: [], usage },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("the replacement gate registers six once-only DeepSeek observations, not two tiers", () => {
  expect(gate).toMatchObject({
    schemaVersion: 1,
    provider: "deepseek",
    model: "deepseek-flash",
    label: "DeepSeek V4.1 Flash 1017",
    repliesPerCall: 1,
    perObservationCapUsd: 0.25,
    independentRawAuditAfterEach: true,
    stopOnFirstFailure: true,
    retries: 0,
    extraSemanticReviewGenerations: 0,
    releasePriorReserves: false,
  });
  expect(gate.callIds).toEqual(
    ["en", "zh"].flatMap((language) =>
      ["m", "n", "o"].map((call) => `reserved-${language}-structured-${call}`),
    ),
  );
  expect(new Set(gate.callIds).size).toBe(6);
  expect(structuredControls(controls)).toMatchObject({ provider: "deepseek", model: gate.model });
});

test.each([
  { INCARNAMIND_LIVE_DEEPSEEK_MODEL: "deepseek-v4.1-flash" },
  { INCARNAMIND_LIVE_DEEPSEEK_MODEL: "deepseek-v4-pro" },
  { INCARNAMIND_LIVE_DEEPSEEK_MODEL: undefined },
  { INCARNAMIND_LIVE_DEEPSEEK_KEY: undefined },
  { INCARNAMIND_LIVE_ANTHROPIC_KEY: "other-made-up-key" },
  { INCARNAMIND_LIVE_ANTHROPIC_MODEL: "claude-haiku-5-5" },
  { INCARNAMIND_LIVE_OLLAMA_MODEL: "local-model" },
  { INCARNAMIND_LIVE_CALLS: "reserved-en-structured-unregistered" },
])("DeepSeek controls reject a missing key or substituted route before any request: %j", (over) => {
  expect(() => structuredControls({ ...controls, ...over })).toThrow();
});

test.each([
  { INCARNAMIND_LIVE_DEEPSEEK_KEY: controls.INCARNAMIND_LIVE_DEEPSEEK_KEY },
  { INCARNAMIND_LIVE_DEEPSEEK_MODEL: controls.INCARNAMIND_LIVE_DEEPSEEK_MODEL },
  { ...controls, INCARNAMIND_STRUCTURED_RECEIPT: undefined },
])("DeepSeek cannot downgrade to non-strict observation controls: %j", (environment) => {
  expect(() => structuredControls(environment)).toThrow();
});

test.each([false, true])(
  "the real DeepSeek adapter settles known raw usage in USD without a cache-write surcharge (streamed: %s)",
  async (streamed) => {
    vi.setSystemTime(new Date("2026-11-05T02:00:00Z"));
    const network = vi.fn<typeof fetch>(async () => response(streamed, tokens));
    vi.stubGlobal("fetch", network);
    const price = catalogModel("deepseek", spec.modelId)?.price;
    if (!price) throw new Error("Missing DeepSeek catalog price");
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
      ledger.assertSettled();
      expect(network).toHaveBeenCalledTimes(1);
      const first = network.mock.calls[0];
      if (!first) throw new Error("No mocked DeepSeek request");
      const [input, init] = first;
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.deepseek.com/chat/completions");
      expect(request.headers.get("authorization")).toBe(`Bearer ${spec.apiKey}`);
      expect(request.headers.has("x-api-key")).toBe(false);
      expect(await request.json()).toMatchObject({ model: "deepseek-flash" });
      const observed = ledger.snapshot().requests[0];
      expect(observed).toMatchObject({
        provider: "deepseek",
        model: "deepseek-flash",
        usage_complete: true,
        input_tokens: 12,
        cache_read_tokens: 4,
        cache_write_tokens: 0,
        output_tokens: 2,
      });
      expect(observed?.cost_usd).toBeCloseTo(
        inCurrency(
          costOf({ inputTokens: 12, cachedInputTokens: 4, outputTokens: 2 }, price, new Date()),
          price.currency,
          "USD",
        ),
        12,
      );
    } finally {
      restore();
    }
  },
);

test("strict DeepSeek observation accepts the endpoint resolved by the public Core", async () => {
  const dataDir = await createTempDataFolder();
  const network = vi.fn<typeof fetch>(async () => response(false, tokens));
  vi.stubGlobal("fetch", network);
  const ledger = createRequestLedger({
    model: spec.modelId,
    price: catalogModel("deepseek", spec.modelId)?.price,
    strict: structuredControls(controls),
  });
  const restore = ledger.installTransportGuard();
  const seen: ChatModelSpec[] = [];
  const core = startCore(dataDir, {
    createChatModel: (resolved) => {
      seen.push(resolved);
      return ledger.model(resolved, () => createAiSdkChatModel(resolved));
    },
  });
  try {
    await expect(
      core.testChatConnection({
        kind: "deepseek",
        modelId: "deepseek-flash",
        apiKey: controls.INCARNAMIND_LIVE_DEEPSEEK_KEY,
      }),
    ).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.baseUrl).toBe(endpointUrl("deepseek"));
    expect(network).toHaveBeenCalledTimes(1);
    ledger.assertSettled();
  } finally {
    core.close();
    restore();
  }
});

test.each([
  { kind: "openai" as const },
  { modelId: "deepseek-v4.1-flash" },
  { modelId: "deepseek-v4-pro" },
  { apiKey: "different-made-up-key" },
  { baseUrl: "https://another.invalid" },
  { baseUrl: "https://api.deepseek.com?extra=1" },
  { endpoint: "another-endpoint" },
])("strict DeepSeek identity rejects substitution before provider construction: %j", (over) => {
  const network = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", network);
  const ledger = createRequestLedger({
    model: spec.modelId,
    price: catalogModel("deepseek", spec.modelId)?.price,
    strict: structuredControls(controls),
  });
  const restore = ledger.installTransportGuard();
  try {
    const build = vi.fn(() => createAiSdkChatModel(spec));
    expect(() => ledger.model({ ...spec, ...over }, build)).toThrow();
    expect(build).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    restore();
  }
});

test.each([400, 429, 503])(
  "DeepSeek HTTP %s stops once and blocks another request",
  async (status) => {
    const network = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { message: "Synthetic provider failure" } }, { status }),
    );
    vi.stubGlobal("fetch", network);
    const ledger = createRequestLedger({
      model: spec.modelId,
      price: catalogModel("deepseek", spec.modelId)?.price,
      strict: structuredControls(controls),
    });
    const restore = ledger.installTransportGuard();
    try {
      const model = ledger.model(spec, () => createAiSdkChatModel(spec));
      await expect(model.doGenerate({ prompt })).rejects.toThrow();
      await expect(model.doGenerate({ prompt })).rejects.toThrow();
      expect(network).toHaveBeenCalledTimes(1);
      expect(ledger.snapshot()).toMatchObject({
        status: "failed",
        request_count: 1,
        physical_network_count: 1,
        retry_count: 1,
        http_statuses: [status],
      });
      expect(ledger.snapshot().requests[0]?.cost_usd).toBeNull();
    } finally {
      restore();
    }
  },
);

test("DeepSeek over-cap usage retains its known USD cost and stops the pipeline", async () => {
  const network = vi.fn<typeof fetch>(async () =>
    response(false, {
      ...tokens,
      prompt_tokens: 4_000_000,
      prompt_cache_miss_tokens: 3_999_996,
      total_tokens: 4_000_002,
    }),
  );
  vi.stubGlobal("fetch", network);
  const ledger = createRequestLedger({
    model: spec.modelId,
    price: catalogModel("deepseek", spec.modelId)?.price,
    strict: structuredControls(controls),
  });
  const restore = ledger.installTransportGuard();
  try {
    const model = ledger.model(spec, () => createAiSdkChatModel(spec));
    await expect(model.doGenerate({ prompt })).rejects.toThrow();
    await expect(model.doGenerate({ prompt })).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot().budget_error).toBe("observation-cap-exceeded");
    expect(ledger.snapshot().requests[0]?.cost_usd).toBeGreaterThan(0.25);
  } finally {
    restore();
  }
});

const rejectedUsage = [
  ...[
    ["prompt_tokens", "input_tokens"],
    ["prompt_cache_hit_tokens", "cache_read_tokens"],
    ["prompt_cache_miss_tokens", null],
    ["completion_tokens", "output_tokens"],
    ["total_tokens", null],
  ].map(([missing, normalized]) => {
    const usage: Record<string, unknown> = { ...tokens };
    if (missing) delete usage[missing];
    return { name: `missing ${missing}`, usage, normalized };
  }),
  { name: "empty usage", usage: {}, normalized: "input_tokens" },
  { name: "inconsistent total", usage: { ...tokens, total_tokens: 15 }, normalized: null },
  { name: "negative input", usage: { ...tokens, prompt_tokens: -1 }, normalized: "input_tokens" },
];

test.each(rejectedUsage.flatMap((row) => [false, true].map((streamed) => ({ ...row, streamed }))))(
  "DeepSeek retains rejected raw usage without inventing normalized counts: $name, streamed: $streamed",
  async ({ usage, normalized, streamed }) => {
    const network = vi.fn<typeof fetch>(async () => response(streamed, usage));
    vi.stubGlobal("fetch", network);
    const strict = structuredControls(controls);
    if (!strict) throw new Error("Missing strict toy controls");
    const ledger = createRequestLedger({
      model: spec.modelId,
      price: catalogModel("deepseek", spec.modelId)?.price,
      strict,
    });
    const restore = ledger.installTransportGuard();
    try {
      const model = ledger.model(spec, () => createAiSdkChatModel(spec));
      const run = async () => {
        if (streamed) await drain((await model.doStream({ prompt })).stream);
        else await model.doGenerate({ prompt });
      };
      await expect(run()).rejects.toThrow();
      await expect(run()).rejects.toThrow();
      expect(network).toHaveBeenCalledTimes(1);
      expect(ledger.snapshot()).toMatchObject({ status: "failed", retry_count: 1 });
      const request = ledger.snapshot().requests[0];
      if (!request) throw new Error("Missing toy request");
      if (normalized) expect(request).toHaveProperty(normalized, null);
      expect(request).toMatchObject({
        usage_complete: false,
        cost_usd: null,
        provider_usage: usage,
      });
      expect(request.provider_usage).toEqual(usage);
      const receipt = observationReceipt(strict, ledger, {
        assertionsPassed: false,
        checks: {},
        evidence: {
          fill: null,
          fill_ms: null,
          data_dir: strict.dataDir,
          saved_cues: [],
          original_note_json: null,
          filled_note_json: null,
          undo_note_json: null,
        },
      });
      expect(receipt.usage.status).toBe("unsettled");
      expect(receipt.usage.requests[0]?.provider_usage).toEqual(usage);
    } finally {
      restore();
    }
  },
);

test("DeepSeek keeps additional received usage fields for an independent raw audit", async () => {
  const usage = { ...tokens, completion_tokens_details: { reasoning_tokens: 1 } };
  const network = vi.fn<typeof fetch>(async () => response(false, usage));
  vi.stubGlobal("fetch", network);
  const ledger = createRequestLedger({
    model: spec.modelId,
    price: catalogModel("deepseek", spec.modelId)?.price,
    strict: structuredControls(controls),
  });
  const restore = ledger.installTransportGuard();
  try {
    const model = ledger.model(spec, () => createAiSdkChatModel(spec));
    await model.doGenerate({ prompt });
    ledger.assertSettled();
    expect(network).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot().requests[0]?.provider_usage).toEqual(usage);
  } finally {
    restore();
  }
});
