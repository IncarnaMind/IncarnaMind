import { createHash } from "node:crypto";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory, ClaimCheckResult, SaveChatProviderInput } from "../../src/core";
import { listedSentences, sentenceOf } from "../../tests/helpers/checks";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { addAndProcess } from "../../tests/helpers/documents";
import { scriptedModel } from "../../tests/helpers/models";
import { percentile } from "../speed/report";
import frozen from "./cases.json";
import { attributionInput, scoreAttributionSet } from "./scoring";

export const ATTRIBUTION_SHA256 =
  "a62d633b30fdd0413498378f83472b526db0bd6c2092a82f6953cf112c64e4ce";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function attributionUsage(value: unknown) {
  const input = record(value) && record(value.inputTokens) ? value.inputTokens : {};
  const output = record(value) && record(value.outputTokens) ? value.outputTokens : {};
  return {
    input: count(input.total),
    output: count(output.total),
    cacheRead: count(input.cacheRead),
    cacheWrite: count(input.cacheWrite),
    known:
      count(input.total) !== null &&
      count(output.total) !== null &&
      [input.cacheRead, input.cacheWrite].every(
        (value) => value === undefined || count(value) !== null,
      ),
    cacheComplete: count(input.cacheRead) !== null && count(input.cacheWrite) !== null,
  };
}

export interface AttributionRequest {
  number: number;
  caseId: string | null;
  mode: "generate" | "stream";
  kind: "sort" | "check" | "strict" | "other";
  status: "running" | "complete" | "missing-usage" | "error" | "aborted";
  ms: number;
  usage: ReturnType<typeof attributionUsage>;
  reply: string;
  messages: { role: string; text: string }[];
  tools: { name: string; input: unknown }[];
  results: { name: string; text: string }[];
  temperature: number | null;
  outputTokens: number | null;
  seed: number | null;
  error: { name: string; status: number | null } | null;
}

function failure(error: unknown) {
  const name =
    error instanceof Error &&
    ["AbortError", "TypeError", "Error", "AI_APICallError"].includes(error.name)
      ? error.name
      : "Error";
  return { name, status: record(error) ? count(error.statusCode) : null };
}

type AttributionParams = Parameters<
  NonNullable<LanguageModelMiddleware["wrapGenerate"]>
>[0]["params"];

export interface AttributionObserverHooks {
  prepare?(params: AttributionParams): AttributionParams;
  before?(request: AttributionRequest, params: AttributionParams): void;
  failed?(error: unknown): void;
  settled?(request: AttributionRequest): void;
}

export function observeAttribution(inner: ChatModelFactory, hooks: AttributionObserverHooks = {}) {
  const requests: AttributionRequest[] = [];
  let caseId: string | null = null;
  type Params = AttributionParams;
  function start(mode: AttributionRequest["mode"], params: Params) {
    const messages = params.prompt.map((message) => ({
      role: message.role,
      text:
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    }));
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.text)
      .join("\n");
    const results = params.prompt.flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result"
              ? [
                  {
                    name: part.toolName,
                    text:
                      part.output.type === "text" || part.output.type === "error-text"
                        ? part.output.value
                        : JSON.stringify(part.output),
                  },
                ]
              : [],
          )
        : [],
    );
    const request: AttributionRequest = {
      number: requests.length + 1,
      caseId,
      mode,
      kind: system.startsWith("You sort the sentences")
        ? "sort"
        : system.startsWith("Compare a sentence")
          ? "strict"
          : system.startsWith("You check one sentence")
            ? "check"
            : "other",
      status: "running",
      ms: 0,
      usage: attributionUsage(null),
      reply: "",
      messages,
      tools: [],
      results,
      temperature: params.temperature ?? null,
      outputTokens: params.maxOutputTokens ?? null,
      seed: params.seed ?? null,
      error: null,
    };
    requests.push(request);
    const began = performance.now();
    return {
      request,
      end: (status: AttributionRequest["status"]) => {
        if (request.status === "error" || request.status === "aborted") return;
        request.status = status;
        request.ms = performance.now() - began;
      },
    };
  }
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    transformParams: async ({ params }) => hooks.prepare?.(params) ?? params,
    wrapGenerate: async ({ doGenerate, params }) => {
      const { request, end } = start("generate", params);
      try {
        hooks.before?.(request, params);
        const result = await doGenerate();
        request.reply = result.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        request.tools = result.content.flatMap((part) =>
          part.type === "tool-call" ? [{ name: part.toolName, input: part.input }] : [],
        );
        request.usage = attributionUsage(result.usage);
        end("complete");
        hooks.settled?.(request);
        return result;
      } catch (error) {
        hooks.failed?.(error);
        request.error = failure(error);
        end(request.error.name === "AbortError" ? "aborted" : "error");
        hooks.settled?.(request);
        throw error;
      }
    },
    wrapStream: async ({ doStream, params }) => {
      const { request, end } = start("stream", params);
      try {
        hooks.before?.(request, params);
        const result = await doStream();
        const reader = result.stream.getReader();
        let cancelled = false;
        return {
          ...result,
          stream: new ReadableStream({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (cancelled) return;
                if (next.done) {
                  if (request.status === "running") end("missing-usage");
                  hooks.settled?.(request);
                  controller.close();
                  return;
                }
                const part = next.value;
                if (part.type === "text-delta") request.reply += part.delta;
                if (part.type === "tool-call")
                  request.tools.push({ name: part.toolName, input: part.input });
                if (part.type === "finish") {
                  request.usage = attributionUsage(part.usage);
                  end("complete");
                  hooks.settled?.(request);
                }
                if (part.type === "error") {
                  hooks.failed?.(part.error);
                  request.error = failure(part.error);
                  end("error");
                }
                controller.enqueue(part);
              } catch (error) {
                if (cancelled) return;
                hooks.failed?.(error);
                request.error = failure(error);
                end(request.error.name === "AbortError" ? "aborted" : "error");
                hooks.settled?.(request);
                controller.error(error);
              }
            },
            async cancel(reason) {
              cancelled = true;
              if (request.status === "running") end("aborted");
              hooks.settled?.(request);
              await reader.cancel(reason);
            },
          }),
        };
      } catch (error) {
        hooks.failed?.(error);
        request.error = failure(error);
        end(request.error.name === "AbortError" ? "aborted" : "error");
        hooks.settled?.(request);
        throw error;
      }
    },
  };
  return {
    requests,
    setCase: (id: string | null) => {
      caseId = id;
    },
    factory: ((spec) =>
      wrapLanguageModel({ model: inner(spec), middleware })) satisfies ChatModelFactory,
  };
}

export function requireAttributionDry(mode = "dry") {
  if (mode !== "dry")
    throw new Error(
      "Paid attribution measurement is disabled. A funded host with explicit opt-in and a shared conservative budget guard is required.",
    );
}

export interface AttributionDryRow {
  id: string;
  language: string;
  status: "not-executed" | "returned" | "error";
  result: ClaimCheckResult | null;
  ms: number;
  requests: number[];
  error: ReturnType<typeof failure> | null;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export async function runAttributionDry(options: {
  arm: "before" | "after";
  mode?: string;
  onCase?: (row: AttributionDryRow, requests: readonly AttributionRequest[]) => Promise<void>;
}) {
  requireAttributionDry(options.mode);
  const model = scriptedModel(
    (call) => ({
      text: `Parts: ${JSON.stringify([{ kind: "fact", text: sentenceOf(call) }])}\nVerdict: unsupported\nCalculation: none\nEvidence: []`,
    }),
    {
      generate: (call) =>
        call.system.startsWith("You sort the sentences")
          ? {
              text: JSON.stringify({
                sentences: listedSentences(call.prompt).map(({ number, text }) => ({
                  number,
                  parts: [{ kind: "fact", text }],
                })),
              }),
            }
          : { text: "same" },
    },
  );
  return runAttributionCases({
    ...options,
    mode: "dry",
    model: "scripted/local-model",
    createChatModel: () => model,
    provider: { kind: "ollama", modelId: "local-model" },
  });
}

export async function runAttributionCases(options: {
  arm: "before" | "after";
  mode: "dry" | "pilot";
  model: string;
  createChatModel: ChatModelFactory;
  provider: SaveChatProviderInput;
  caseIds?: readonly string[];
  hooks?: AttributionObserverHooks;
  stopped?: () => boolean;
  onCase?: (row: AttributionDryRow, requests: readonly AttributionRequest[]) => Promise<void>;
}) {
  const bytes = await readFile(new URL("./cases.json", import.meta.url), "utf8");
  if (hash(bytes) !== ATTRIBUTION_SHA256)
    throw new Error("The frozen attribution fixture hash changed.");
  const selected = options.caseIds
    ? options.caseIds.map((id) => {
        const sample = frozen.cases.find((sample) => sample.id === id);
        if (!sample) throw new Error("An attribution case ID is not in the frozen set.");
        return sample;
      })
    : frozen.cases;
  if (new Set(selected.map((sample) => sample.id)).size !== selected.length)
    throw new Error("Attribution case IDs must be unique.");
  const observed = observeAttribution(options.createChatModel, options.hooks);
  const dataDir = await createTempDataFolder();
  const sourcesDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: observed.factory,
    now: () => new Date(frozen.checkAtISO),
  });
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, automatic: false });
  await core.saveChatProvider(options.provider);
  const documents = new Map<string, string>();
  const metadata = [];
  for (const source of frozen.sources) {
    if (hash(source.text) !== source.sha256) throw new Error("A frozen Source hash changed.");
    const folder = join(sourcesDir, source.id);
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${source.title}.md`);
    await writeFile(path, source.text);
    const modified = "fileModifiedAt" in source ? source.fileModifiedAt : null;
    if (modified) await utimes(path, new Date(modified), new Date(modified));
    const [document] = await addAndProcess(core, [path]);
    if (document?.status !== "ready" || document.contentHash !== source.sha256)
      throw new Error("A frozen Source was not imported byte-for-byte.");
    documents.set(source.id, document.id);
    const actualFile = await stat(path);
    metadata.push({
      sourceId: source.id,
      documentId: document.id,
      declaredCreatedAt: "fileCreatedAt" in source ? source.fileCreatedAt : null,
      declaredModifiedAt: modified,
      actualFileCreatedAt: actualFile.birthtime.toISOString(),
      actualFileModifiedAt: actualFile.mtime.toISOString(),
      importedCreationDate: document.creationDate,
      importedModifiedAt: document.modifiedAt,
      createdAtApplied: false,
    });
  }
  const results = new Map<string, ClaimCheckResult>();
  const rows: AttributionDryRow[] = selected.map((sample) => ({
    id: sample.id,
    language: sample.language,
    status: "not-executed",
    result: null,
    ms: 0,
    requests: [],
    error: null,
  }));
  for (const [index, sample] of selected.entries()) {
    if (options.stopped?.()) break;
    const row = rows[index];
    if (!row) throw new Error("The frozen attribution case inventory changed.");
    const input = attributionInput(frozen, sample, documents);
    await core.updateSettings({ user: { language: input.language } });
    observed.setCase(sample.id);
    const began = performance.now();
    try {
      row.result = await core.checkClaim(input.check);
      row.status = "returned";
      results.set(sample.id, row.result);
    } catch (error) {
      row.error = failure(error);
      row.status = "error";
    } finally {
      row.ms = performance.now() - began;
      row.requests = observed.requests
        .filter((request) => request.caseId === sample.id)
        .map((request) => request.number);
      observed.setCase(null);
    }
    await options.onCase?.(
      row,
      observed.requests.filter((request) => request.caseId === sample.id),
    );
  }
  const scores = scoreAttributionSet(frozen, documents, results);
  const requestCounts = Object.fromEntries(
    (["sort", "check", "strict", "other"] as const).map((kind) => [
      kind,
      observed.requests.filter((request) => request.kind === kind).length,
    ]),
  );
  const byLanguage = ["en", "zh-CN"].map((language) => {
    const cases = rows.filter((row) => row.language === language);
    const ids = new Set(cases.map((row) => row.id));
    const requests = observed.requests.filter(
      (request) => request.caseId !== null && ids.has(request.caseId),
    );
    const scoresOfLanguage = scores.rows.filter((row) => ids.has(row.id));
    const latency = cases.map((row) => row.ms);
    return {
      language,
      cases: cases.length,
      requests: requests.length,
      meanRequestsPerCheck: requests.length / Math.max(1, cases.length),
      strictRequests: requests.filter((request) => request.kind === "strict").length,
      latencyMs: {
        total: latency.reduce((sum, ms) => sum + ms, 0),
        mean: latency.reduce((sum, ms) => sum + ms, 0) / Math.max(1, cases.length),
        p50: percentile(latency, 0.5),
        p95: percentile(latency, 0.95),
      },
      nativeHits: scoresOfLanguage.filter((row) => row.native === "hit").length,
      falseSupported: scoresOfLanguage.filter(
        (row) => row.expected !== "supported" && row.actual?.verdict === "supported",
      ).length,
      falseContradicted: scoresOfLanguage.filter(
        (row) => row.expected !== "contradicted" && row.actual?.verdict === "contradicted",
      ).length,
    };
  });
  const facets = selected.flatMap((sample) =>
    sample.gold.facetTargets.map((target) => {
      const part = results
        .get(sample.id)
        ?.parts?.find(
          (part) =>
            part.facet?.kind === target.facet &&
            part.span.start === target.span.start &&
            part.span.end === target.span.end,
        );
      return {
        id: sample.id,
        facet: target.facet,
        span: target.span,
        present: part !== undefined,
        actualVerdict: part?.verdict ?? null,
      };
    }),
  );
  return {
    manifest: {
      arm: options.arm,
      mode: options.mode,
      model: options.model,
      qualityMeasurement: options.mode !== "dry",
      fixtureSHA256: ATTRIBUTION_SHA256,
      checkAtISO: frozen.checkAtISO,
      caseCount: selected.length,
      frozenCaseCount: frozen.cases.length,
      selectedCaseIds: selected.map((sample) => sample.id),
      sourceCount: frozen.sources.length,
      profileCount: frozen.profiles.length,
      scope: "standalone-public-checkClaim",
      paidEnabled: options.mode === "pilot",
      knownExternalCostUSD: options.mode === "dry" ? 0 : null,
      pricedForecast: null,
    },
    rows,
    requests: observed.requests,
    importedDocuments: metadata,
    scores,
    byLanguage,
    facets,
    summary: {
      retained: rows.length,
      executed: rows.filter((row) => row.status !== "not-executed").length,
      requests: observed.requests.length,
      requestsByKind: requestCounts,
      abortedOrFailedRequests: observed.requests.filter(
        (request) => request.status === "aborted" || request.status === "error",
      ).length,
      unknownUsageRequests: observed.requests.filter((request) => !request.usage.known).length,
      cacheIncompleteRequests: observed.requests.filter((request) => !request.usage.cacheComplete)
        .length,
      caseLatencyMs: rows.reduce((sum, row) => sum + row.ms, 0),
    },
  };
}
