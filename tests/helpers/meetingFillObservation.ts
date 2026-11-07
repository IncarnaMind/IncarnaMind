import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { APICallError, wrapLanguageModel } from "ai";
import type { MeetingFill } from "../../src/core/api";
import { costOf, inCurrency } from "../../src/core/cost/price";
import type { Cue } from "../../src/core/documents/formats/vtt";
import { catalogProviderOfKind } from "../../src/core/providers/catalog/providers";
import type { Price } from "../../src/core/providers/catalog/types";
import { endpointUrl } from "../../src/core/providers/kinds";
import type { ChatLanguageModel, ChatModelSpec } from "../../src/core/providers/models";
import { tokenUsageOf } from "../../src/core/providers/promptCache";
import structuredGate from "../fixtures/meetings/fill-structured-gate.json";

export interface StructuredControls {
  receipt: string;
  report: string;
  candidate: string;
  provider: "anthropic" | "deepseek";
  model: "claude-haiku-5-5" | "claude-sonnet-5-5" | "deepseek-flash";
  call: string;
  dataDir: string;
  key: string;
  cap: 0.25;
}

export function meetingFillCloud(environment: Readonly<Record<string, string | undefined>>) {
  const deepseek =
    environment.INCARNAMIND_LIVE_DEEPSEEK_KEY !== undefined ||
    environment.INCARNAMIND_LIVE_DEEPSEEK_MODEL !== undefined;
  if (deepseek) {
    if (
      environment.INCARNAMIND_LIVE_ANTHROPIC_KEY !== undefined ||
      environment.INCARNAMIND_LIVE_ANTHROPIC_MODEL !== undefined
    )
      throw new Error("Choose one Meeting fill provider, not two.");
    return {
      provider: "deepseek" as const,
      model: environment.INCARNAMIND_LIVE_DEEPSEEK_MODEL,
      key: environment.INCARNAMIND_LIVE_DEEPSEEK_KEY,
    };
  }
  return {
    provider: "anthropic" as const,
    model: environment.INCARNAMIND_LIVE_ANTHROPIC_MODEL,
    key: environment.INCARNAMIND_LIVE_ANTHROPIC_KEY,
  };
}

export function structuredControls(
  environment: Readonly<Record<string, string | undefined>>,
): StructuredControls | null {
  const receipt = environment.INCARNAMIND_STRUCTURED_RECEIPT;
  const { provider, model, key } = meetingFillCloud(environment);
  if (receipt === undefined) {
    if (provider === "deepseek")
      throw new Error("DeepSeek Meeting fill requires strict observation controls.");
    return null;
  }
  const report = environment.INCARNAMIND_LIVE_REPORT;
  const candidate = environment.INCARNAMIND_STRUCTURED_CANDIDATE;
  const call = environment.INCARNAMIND_LIVE_CALLS;
  const dataDir = environment.INCARNAMIND_DATA_DIR;
  if (
    !isAbsolute(receipt) ||
    !report ||
    !isAbsolute(report) ||
    report === receipt ||
    !candidate ||
    !/^[0-9a-f]{40}$/.test(candidate) ||
    (model !== "claude-haiku-5-5" && model !== "claude-sonnet-5-5" && model !== "deepseek-flash") ||
    (provider === "deepseek") !== (model === "deepseek-flash") ||
    !call ||
    !/^reserved-(?:en|zh)-structured-[a-z0-9-]+$/.test(call) ||
    (provider === "deepseek" &&
      (structuredGate.provider !== provider ||
        structuredGate.model !== model ||
        !structuredGate.callIds.includes(call))) ||
    !dataDir ||
    !isAbsolute(dataDir) ||
    !key?.trim() ||
    environment.INCARNAMIND_STRUCTURED_CAP_USD !== "0.25" ||
    environment.INCARNAMIND_LIVE_REPLIES !== "1" ||
    environment.INCARNAMIND_LIVE_OLLAMA_MODEL !== undefined
  )
    throw new Error("Invalid strict structured observation controls.");
  return { receipt, report, candidate, provider, model, call, dataDir, key, cap: 0.25 };
}

export interface ObservedRequest {
  provider: string;
  model: string;
  status: "completed" | "failed" | "unsettled";
  usage_complete: boolean;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  priced_at: string;
  price_currency: Price["currency"] | null;
  provider_usage: NonNullable<LanguageModelV4Usage["raw"]> | null;
  text: string;
  raw: string;
  tools: string[];
  reasoning: number;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
let transportOwner: object | null = null;

export function createRequestLedger(options: {
  model: string;
  price?: Price;
  strict?: StructuredControls | null;
}) {
  if (
    options.strict &&
    (options.price?.currency !== (options.strict.provider === "deepseek" ? "CNY" : "USD") ||
      [options.price, ...(options.price.tiers ?? [])].some(
        (tier) =>
          ![tier.input, tier.output, tier.cacheRead].every(
            (rate) => typeof rate === "number" && Number.isFinite(rate) && rate > 0,
          ),
      ))
  ) {
    throw new Error("Structured observation requires known positive catalog pricing.");
  }
  const requests: ObservedRequest[] = [];
  const logicalRequests: ObservedRequest[] = [];
  const httpStatuses: (number | null)[] = [];
  const logical = new AsyncLocalStorage<ObservedRequest>();
  const sent = new WeakSet<ObservedRequest>();
  const provider = options.strict?.provider ?? "anthropic";
  const endpoint = endpointUrl(provider);
  const endpointId = catalogProviderOfKind(provider)?.endpoints[0]?.id;
  const route = provider === "deepseek" ? "chat/completions" : "messages";
  const messagesUrl = endpoint ? new URL(`${endpoint.replace(/\/+$/, "")}/${route}`).href : null;
  const abort = new AbortController();
  let transportActive = false;
  let logicalCount = 0;
  let physicalCount = 0;
  let failed = false;
  let retryCount = 0;
  let providerError: string | null = null;
  let networkError: string | null = null;
  let budgetError: string | null = null;
  const total = () => requests.reduce((sum, request) => sum + (request.cost_usd ?? 0), 0);
  const fault = (
    kind: "request" | "usage" | "budget" | "unfinished" | "identity" | "credential",
    error?: unknown,
  ) => {
    failed = true;
    if (kind === "budget") budgetError = "observation-cap-exceeded";
    else {
      providerError ??= kind === "request" ? "provider-request-failed" : kind;
      if (kind === "request" || kind === "unfinished") {
        networkError ??=
          APICallError.isInstance(error) && error.statusCode !== undefined
            ? null
            : "unknown-transport-failure";
      }
    }
    if (options.strict) abort.abort();
  };
  const stopped = () => new Error("Structured observation request stopped; inspect its receipt.");
  const guard = () => {
    if (options.strict && failed) {
      retryCount++;
      throw stopped();
    }
  };
  const sanitize = (text: string) => {
    const key = options.strict?.key;
    if (!key || !text.includes(key)) return text;
    fault("credential");
    return text.split(key).join("<REDACTED>");
  };
  const begin = (spec: ChatModelSpec) => {
    guard();
    if (options.strict && !transportActive) {
      fault("identity");
      throw stopped();
    }
    logicalCount++;
    const request: ObservedRequest = {
      provider: spec.kind,
      model: spec.modelId,
      status: "unsettled",
      usage_complete: false,
      input_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      output_tokens: null,
      cost_usd: null,
      priced_at: new Date().toISOString(),
      price_currency: options.price?.currency ?? null,
      provider_usage: null,
      text: "",
      raw: "",
      tools: [],
      reasoning: 0,
    };
    logicalRequests.push(request);
    if (!options.strict) requests.push(request);
    return request;
  };
  const settle = (request: ObservedRequest, usage: LanguageModelV4Usage) => {
    if (options.strict && !sent.has(request)) {
      fault("usage");
      throw stopped();
    }
    request.reasoning = count(usage.outputTokens.reasoning) ?? 0;
    if (request.provider === "deepseek") {
      const raw = usage.raw;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        fault("usage");
        return;
      }
      const input = count(raw.prompt_tokens);
      const cached = count(raw.prompt_cache_hit_tokens);
      const missed = count(raw.prompt_cache_miss_tokens);
      const output = count(raw.completion_tokens);
      const all = count(raw.total_tokens);
      request.provider_usage = structuredClone(raw);
      request.input_tokens = input;
      request.cache_read_tokens = cached;
      request.output_tokens = output;
      // DeepSeek bills cache misses at the input rate, not as Anthropic cache writes.
      request.cache_write_tokens = 0;
      if (
        input === null ||
        cached === null ||
        missed === null ||
        output === null ||
        all === null ||
        cached + missed !== input ||
        input + output !== all ||
        usage.inputTokens.total !== input ||
        usage.inputTokens.cacheRead !== cached ||
        usage.outputTokens.total !== output ||
        (usage.inputTokens.cacheWrite !== undefined && usage.inputTokens.cacheWrite !== 0)
      ) {
        fault("usage");
        return;
      }
    } else {
      request.input_tokens = count(usage.inputTokens.total);
      request.cache_read_tokens = count(usage.inputTokens.cacheRead);
      request.cache_write_tokens = count(usage.inputTokens.cacheWrite);
      request.output_tokens = count(usage.outputTokens.total);
    }
    const {
      input_tokens: input,
      cache_read_tokens: cached,
      cache_write_tokens: written,
      output_tokens: output,
    } = request;
    request.usage_complete =
      input !== null &&
      cached !== null &&
      written !== null &&
      output !== null &&
      cached + written <= input &&
      input + output > 0;
    if (request.usage_complete && options.price) {
      const cost = costOf(
        tokenUsageOf({
          inputTokens: input ?? undefined,
          outputTokens: output ?? undefined,
          inputTokenDetails: {
            cacheReadTokens: cached ?? undefined,
            cacheWriteTokens: written ?? undefined,
          },
        }),
        options.price,
        new Date(request.priced_at),
        { cacheWrites: request.provider === "anthropic" },
      );
      request.cost_usd = inCurrency(cost, options.price.currency, "USD");
    }
    request.usage_complete &&= request.cost_usd !== null;
    request.status = "completed";
    if (!request.usage_complete) {
      fault("usage");
    }
    if (options.strict && total() > options.strict.cap) {
      fault("budget");
    }
  };
  const capture = (
    request: ObservedRequest,
    part: LanguageModelV4StreamPart | LanguageModelV4Content,
  ) => {
    if (part.type === "text" || part.type === "text-delta") {
      const text = part.type === "text" ? part.text : part.delta;
      request.text = sanitize(request.text + text);
      request.raw = sanitize(request.raw + text);
    }
    if (part.type === "reasoning" || part.type === "reasoning-delta") {
      request.raw = sanitize(
        request.raw +
          JSON.stringify({
            type: part.type,
            text: part.type === "reasoning" ? part.text : part.delta,
          }),
      );
    }
    if (part.type === "tool-call") {
      request.tools.push(part.toolName);
      request.raw = sanitize(
        request.raw +
          JSON.stringify({ type: part.type, toolName: part.toolName, input: part.input }),
      );
    }
    if (part.type === "tool-result") {
      request.raw = sanitize(
        request.raw +
          JSON.stringify({ type: part.type, toolName: part.toolName, result: part.result }),
      );
    }
    if (part.type === "tool-input-start")
      request.raw = sanitize(
        request.raw + JSON.stringify({ type: part.type, id: part.id, toolName: part.toolName }),
      );
    if (part.type === "tool-input-delta")
      request.raw = sanitize(
        request.raw + JSON.stringify({ type: part.type, id: part.id, delta: part.delta }),
      );
    if (part.type === "tool-input-end")
      request.raw = sanitize(request.raw + JSON.stringify({ type: part.type, id: part.id }));
  };
  const failedRequest = (request: ObservedRequest, error: unknown) => {
    request.status = "failed";
    if (!failed) fault("request", error);
    return options.strict ? stopped() : error;
  };
  const snapshot = () => ({
    request_count: requests.length,
    logical_request_count: logicalCount,
    physical_network_count: physicalCount,
    requests: structuredClone(requests),
    unsettled_requests:
      requests.filter((request) => request.status === "unsettled" || !request.usage_complete)
        .length +
      (options.strict ? logicalRequests.filter((request) => !sent.has(request)).length : 0),
    retry_count: retryCount,
    extra_semantic_review_generations: 0,
    provider_error: providerError,
    network_error: networkError,
    budget_error: budgetError,
    http_statuses: [...httpStatuses],
    total_usd: total(),
    status:
      !failed &&
      requests.length > 0 &&
      (!options.strict || logicalCount === physicalCount) &&
      requests.every(
        (request) =>
          request.status === "completed" && request.usage_complete && request.raw.trim() !== "",
      )
        ? "pass"
        : "failed",
  });
  return {
    sanitize,
    snapshot,
    installTransportGuard() {
      if (!options.strict || transportOwner !== null || !messagesUrl)
        throw new Error("Strict transport guard is unavailable or already owned.");
      const strict = options.strict;
      const original = globalThis.fetch;
      const guarded: typeof fetch = async (input, init) => {
        guard();
        const current = logical.getStore();
        if (!current) {
          fault("identity");
          throw stopped();
        }
        let request: Request;
        let body: unknown;
        try {
          request = new Request(input, init);
          body = await request.clone().json();
        } catch {
          fault("identity");
          throw stopped();
        }
        if (
          request.url !== messagesUrl ||
          request.method !== "POST" ||
          (strict.provider === "deepseek"
            ? request.headers.get("authorization") !== `Bearer ${strict.key}` ||
              request.headers.has("x-api-key")
            : request.headers.get("x-api-key") !== strict.key ||
              request.headers.has("authorization")) ||
          typeof body !== "object" ||
          body === null ||
          !("model" in body) ||
          body.model !== strict.model
        ) {
          fault("identity");
          throw stopped();
        }
        guard();
        if (sent.has(current)) {
          retryCount++;
          fault("request");
          throw stopped();
        }
        sent.add(current);
        current.priced_at = new Date().toISOString();
        requests.push(current);
        physicalCount++;
        const index = httpStatuses.push(null) - 1;
        try {
          const response = await original(input, {
            ...init,
            redirect: "manual",
            signal: AbortSignal.any([abort.signal, request.signal]),
          });
          httpStatuses[index] = response.status;
          if (!response.ok) {
            current.status = "failed";
            providerError = "http-non-ok";
            fault("request", { statusCode: response.status });
            networkError = null;
          }
          return response;
        } catch {
          current.status = "failed";
          fault("request");
          throw stopped();
        }
      };
      transportOwner = abort;
      transportActive = true;
      globalThis.fetch = guarded;
      return () => {
        if (!transportActive) return;
        if (globalThis.fetch !== guarded) fault("identity");
        globalThis.fetch = original;
        transportOwner = null;
        transportActive = false;
      };
    },
    assertSettled() {
      if (snapshot().status !== "pass" || retryCount !== 0) {
        if (options.strict) fault("unfinished");
        throw stopped();
      }
    },
    get usage() {
      return {
        calls: requests.length,
        input: requests.reduce((sum, request) => sum + (request.input_tokens ?? 0), 0),
        cached: requests.reduce((sum, request) => sum + (request.cache_read_tokens ?? 0), 0),
        written: requests.reduce((sum, request) => sum + (request.cache_write_tokens ?? 0), 0),
        output: requests.reduce((sum, request) => sum + (request.output_tokens ?? 0), 0),
        dollars: total(),
        replies: requests.map((request) => ({
          text: request.text,
          raw: request.raw,
          reasoning: request.reasoning,
          tools: request.tools,
          output: request.output_tokens ?? 0,
        })),
      };
    },
    model: (spec: ChatModelSpec, build: () => ChatLanguageModel) => {
      guard();
      if (
        options.strict &&
        (!transportActive ||
          spec.kind !== options.strict.provider ||
          spec.modelId !== options.model ||
          spec.apiKey !== options.strict.key ||
          (spec.baseUrl !== null &&
            spec.baseUrl.replace(/\/+$/, "") !== endpoint?.replace(/\/+$/, "")) ||
          (spec.endpoint != null && spec.endpoint !== endpointId) ||
          spec.credentials != null ||
          endpointUrl(spec.kind, spec.endpoint, spec.catalogId) !== endpoint)
      ) {
        fault("identity");
        throw stopped();
      }
      return wrapLanguageModel({
        model: build(),
        middleware: {
          specificationVersion: "v4",
          transformParams: async ({ params }) => {
            guard();
            return options.strict
              ? {
                  ...params,
                  abortSignal: AbortSignal.any([
                    abort.signal,
                    ...(params.abortSignal ? [params.abortSignal] : []),
                  ]),
                }
              : params;
          },
          wrapStream: async ({ doStream }) => {
            const request = begin(spec);
            try {
              const result = await logical.run(request, doStream);
              const reader = result.stream.getReader();
              let finished = false;
              return {
                ...result,
                stream: new ReadableStream<LanguageModelV4StreamPart>({
                  async pull(controller) {
                    try {
                      const next = await reader.read();
                      if (next.done) {
                        if (!finished) {
                          fault("unfinished");
                          if (options.strict) {
                            controller.error(stopped());
                            return;
                          }
                        }
                        if (finished) request.status = "completed";
                        controller.close();
                        return;
                      }
                      const part = next.value;
                      if (part.type === "error" && options.strict) throw part.error;
                      if (part.type === "finish") {
                        finished = true;
                        settle(request, part.usage);
                        request.status = "unsettled";
                        if (part.finishReason.unified === "error" && options.strict)
                          throw stopped();
                      }
                      capture(request, part);
                      if (options.strict && failed) throw stopped();
                      controller.enqueue(part);
                    } catch (error) {
                      controller.error(failedRequest(request, error));
                    }
                  },
                  async cancel() {
                    request.status = finished ? "failed" : "unsettled";
                    fault("unfinished");
                    try {
                      await reader.cancel();
                    } catch (error) {
                      failedRequest(request, error);
                    }
                  },
                }),
              };
            } catch (error) {
              throw failedRequest(request, error);
            }
          },
          wrapGenerate: async ({ doGenerate }) => {
            const request = begin(spec);
            try {
              const result = await logical.run(request, doGenerate);
              for (const part of result.content) capture(request, part);
              settle(request, result.usage);
              if (options.strict && failed) throw stopped();
              if (result.finishReason.unified === "error" && options.strict) throw stopped();
              return result;
            } catch (error) {
              throw failedRequest(request, error);
            }
          },
        },
      });
    },
  };
}

export const V5_CHECKS = [
  "original_preserved",
  "all_facts_present",
  "in_place",
  "once",
  "citations",
  "decisions",
  "actions",
  "overview",
  "questions",
  "headings",
  "machine_addresses",
  "undo",
] as const;
export type V5Check = (typeof V5_CHECKS)[number];
export interface ObservationEvidence {
  fill: MeetingFill | null;
  fill_ms: number | null;
  data_dir: string;
  saved_cues: readonly Cue[];
  original_note_json: unknown;
  filled_note_json: unknown;
  undo_note_json: unknown;
}

export function observationReceipt(
  controls: StructuredControls,
  ledger: ReturnType<typeof createRequestLedger>,
  result: {
    assertionsPassed: boolean;
    checks: Partial<Record<V5Check, boolean>>;
    evidence: ObservationEvidence;
    reportHash?: string | null;
  },
) {
  const snapshot = ledger.snapshot();
  const { fill, ...evidence } = result.evidence;
  const checks = Object.fromEntries(V5_CHECKS.map((name) => [name, result.checks[name] === true]));
  const qualityPass =
    result.assertionsPassed &&
    V5_CHECKS.every((name) => checks[name]) &&
    fill?.state === "filled" &&
    fill.problem === null &&
    (fill.omitted ?? 0) === 0 &&
    (fill.unfinishedParts ?? 0) === 0;
  const object = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const evidenceComplete =
    object(evidence.original_note_json) &&
    object(evidence.filled_note_json) &&
    object(evidence.undo_note_json) &&
    isDeepStrictEqual(evidence.original_note_json, evidence.undo_note_json) &&
    !isDeepStrictEqual(evidence.original_note_json, evidence.filled_note_json) &&
    evidence.saved_cues.length > 0 &&
    evidence.fill_ms !== null &&
    evidence.fill_ms > 0 &&
    evidence.data_dir === controls.dataDir &&
    typeof result.reportHash === "string" &&
    /^[0-9a-f]{64}$/.test(result.reportHash);
  const pass =
    qualityPass &&
    evidenceComplete &&
    snapshot.status === "pass" &&
    snapshot.retry_count === 0 &&
    snapshot.total_usd <= controls.cap;
  return {
    schema_version: 1,
    contract: "structured-observation-v1",
    candidate: controls.candidate,
    provider: controls.provider,
    model: controls.model,
    call: controls.call,
    scoring: "cue-owner-subject-placement-v5",
    app_cap_usd: controls.cap,
    data_dir: evidence.data_dir,
    fill_ms: evidence.fill_ms,
    pipeline: {
      status: pass ? "pass" : "failed",
      request_count: snapshot.request_count,
      logical_request_count: snapshot.logical_request_count,
      physical_network_count: snapshot.physical_network_count,
      http_statuses: snapshot.http_statuses,
      unsettled_requests: snapshot.unsettled_requests,
      retry_count: snapshot.retry_count,
      extra_semantic_review_generations: snapshot.extra_semantic_review_generations,
      provider_error: snapshot.provider_error,
      network_error: snapshot.network_error,
      budget_error: snapshot.budget_error,
    },
    quality: {
      fill_state: fill?.state ?? null,
      problem: fill ? fill.problem : "unknown",
      omitted: fill ? (fill.omitted ?? 0) : null,
      unfinishedParts: fill ? (fill.unfinishedParts ?? 0) : null,
      v5_status: qualityPass ? "pass" : "failed",
      v5_checks: checks,
    },
    usage: {
      status:
        snapshot.requests.length > 0 && snapshot.unsettled_requests === 0 ? "settled" : "unsettled",
      total_usd: snapshot.total_usd,
      requests: snapshot.requests.map(
        ({
          provider,
          model,
          status,
          usage_complete,
          input_tokens,
          cache_read_tokens,
          cache_write_tokens,
          output_tokens,
          cost_usd,
          priced_at,
          price_currency,
          provider_usage,
        }) => ({
          provider,
          model,
          status,
          usage_complete,
          input_tokens,
          cache_read_tokens,
          cache_write_tokens,
          output_tokens,
          cost_usd,
          priced_at,
          price_currency,
          provider_usage,
        }),
      ),
    },
    evidence: {
      report_sha256: result.reportHash ?? null,
      raw_replies: snapshot.requests.map((request) => request.raw),
      saved_cues: evidence.saved_cues,
      original_note_json: evidence.original_note_json,
      filled_note_json: evidence.filled_note_json,
      undo_note_json: evidence.undo_note_json,
    },
  };
}

export async function startObservation(
  controls: StructuredControls,
  ledger: ReturnType<typeof createRequestLedger>,
) {
  const evidence: ObservationEvidence = {
    fill: null,
    fill_ms: null,
    data_dir: controls.dataDir,
    saved_cues: [],
    original_note_json: null,
    filled_note_json: null,
    undo_note_json: null,
  };
  const checks: Partial<Record<V5Check, boolean>> = {};
  let finished = false;
  await mkdir(controls.dataDir, { recursive: true });
  await writeFile(
    controls.receipt,
    JSON.stringify(
      observationReceipt(controls, ledger, { assertionsPassed: false, checks, evidence }),
    ),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(controls.report, "", { flag: "wx", mode: 0o600 });
  return {
    capture(update: Partial<ObservationEvidence>) {
      Object.assign(evidence, update);
    },
    check(name: V5Check, assertion: () => void) {
      assertion();
      checks[name] = true;
    },
    async finish(assertionsPassed: boolean) {
      if (finished) throw new Error("Structured observation was already finalized.");
      finished = true;
      const raw = ledger.snapshot().requests.map((request) => request.raw);
      let reportHash: string | null = null;
      let reportFailed = false;
      try {
        await appendFile(
          controls.report,
          ledger.sanitize(
            `\n## Observation evidence\n\nSaved cues: ${JSON.stringify(evidence.saved_cues)}\n\nOriginal Note JSON: ${JSON.stringify(evidence.original_note_json)}\n\nFilled Note JSON: ${JSON.stringify(evidence.filled_note_json)}\n\nUndo Note JSON: ${JSON.stringify(evidence.undo_note_json)}\n\nFull raw replies: ${JSON.stringify(raw)}\n`,
          ),
        );
        reportHash = createHash("sha256")
          .update(await readFile(controls.report))
          .digest("hex");
      } catch {
        reportFailed = true;
      }
      const completed = assertionsPassed && !reportFailed;
      let receipt = observationReceipt(controls, ledger, {
        assertionsPassed: completed,
        checks,
        evidence,
        reportHash,
      });
      ledger.sanitize(JSON.stringify(receipt));
      receipt = observationReceipt(controls, ledger, {
        assertionsPassed: completed,
        checks,
        evidence,
        reportHash,
      });
      await writeFile(controls.receipt, ledger.sanitize(`${JSON.stringify(receipt, null, 2)}\n`), {
        mode: 0o600,
      });
      if (reportFailed || (assertionsPassed && receipt.pipeline.status !== "pass"))
        throw new Error("Structured observation evidence is incomplete or failed.");
      return receipt;
    },
  };
}
