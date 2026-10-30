import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { costOf, reservationOf } from "../../src/core/cost/price";
import type { Price } from "../../src/core/providers/catalog/types";
import { classifyProviderError } from "../../src/core/providers/providerErrors";
import { resultFromParts } from "../../src/shared/claimParts";
import { findQuote } from "../../src/shared/quoteMatch";
import {
  ATTRIBUTION_SHA256,
  type AttributionDryRow,
  type AttributionObserverHooks,
  type AttributionRequest,
} from "./adapter";
import frozen from "./cases.json";
import { scoreAttributionSet } from "./scoring";

export const ATTRIBUTION_PILOT_CASES = ["N01-en", "C03-zh-CN", "T02-en"] as const;
export const ATTRIBUTION_PILOT_CAP_USD = 2;
export const ATTRIBUTION_FULL_CAP_USD = 3.75;
export const ATTRIBUTION_FULL_SETTLED_STOP_USD = 2.8;
export const ATTRIBUTION_FULL_CASES = frozen.cases.map((sample) => sample.id);
export const ATTRIBUTION_PILOT_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
const PILOT_FACET_VERDICTS = [
  { caseId: "N01-en", kind: "source", verdict: "supported" },
  { caseId: "T02-en", kind: "time", verdict: "contradicted" },
] as const;
export const EMPTY_SOURCE_DIFF_SHA256 = createHash("sha256").update("").digest("hex");

export type AttributionPilotHashes = {
  adapter: string;
  scorer: string;
  host: string;
  entry: string;
};

type PilotModel = (typeof ATTRIBUTION_PILOT_MODELS)[number];
export interface AttributionPilotPlan {
  phase: string;
  arm: "before" | "after";
  model: PilotModel;
  capUSD: number;
  pins: { before: string; after: string };
  sourceHead: string;
  sourceDiffSHA256: string;
  fixtureSHA256: string;
  caseIds: readonly string[];
  sharedHashes: AttributionPilotHashes;
  expectedSharedHashes: AttributionPilotHashes;
  pilotReceiptHashes?: readonly string[];
}

export function validateAttributionPilot(plan: AttributionPilotPlan) {
  if (plan.phase !== "pilot" && plan.phase !== "full")
    throw new Error("Select an explicitly authorized attribution phase.");
  const ceiling = plan.phase === "full" ? ATTRIBUTION_FULL_CAP_USD : ATTRIBUTION_PILOT_CAP_USD;
  if (!Number.isFinite(plan.capUSD) || plan.capUSD <= 0 || plan.capUSD > ceiling)
    throw new Error("An explicit authorized pilot ceiling is required.");
  if (!ATTRIBUTION_PILOT_MODELS.includes(plan.model))
    throw new Error("The attribution pilot model is not approved.");
  if (
    (plan.arm !== "before" && plan.arm !== "after") ||
    !Object.values(plan.pins).every((head) => /^[a-f0-9]{40}$/.test(head)) ||
    plan.sourceHead !== plan.pins[plan.arm]
  )
    throw new Error("The attribution pilot source pin does not match.");
  if (plan.sourceDiffSHA256 !== EMPTY_SOURCE_DIFF_SHA256)
    throw new Error("The measured attribution source must be clean.");
  if (
    plan.fixtureSHA256 !== ATTRIBUTION_SHA256 ||
    JSON.stringify(plan.caseIds) !==
      JSON.stringify(plan.phase === "full" ? ATTRIBUTION_FULL_CASES : ATTRIBUTION_PILOT_CASES)
  )
    throw new Error("The frozen attribution pilot cases or fixture hash changed.");
  for (const name of ["adapter", "scorer", "host", "entry"] as const) {
    const actual = plan.sharedHashes?.[name];
    if (
      typeof actual !== "string" ||
      !/^[a-f0-9]{64}$/.test(actual) ||
      actual !== plan.expectedSharedHashes?.[name]
    )
      throw new Error("The shared attribution pilot host hash changed.");
  }
  if (
    plan.phase === "full" &&
    (!Array.isArray(plan.pilotReceiptHashes) ||
      plan.pilotReceiptHashes.length !== 2 ||
      new Set(plan.pilotReceiptHashes).size !== 2 ||
      plan.pilotReceiptHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)))
  )
    throw new Error("Two hashed candidate pilot reports are required.");
}

export interface AttributionPilotReceipt {
  bytes: string;
  sha256: string;
}

function validatePromotion(
  plan: AttributionPilotPlan,
  receipts: readonly AttributionPilotReceipt[],
) {
  if (receipts.length !== 2) throw new Error("Two candidate pilot reports are required.");
  const models = new Set<string>();
  for (const [index, receipt] of receipts.entries()) {
    if (
      receipt.sha256 !== plan.pilotReceiptHashes?.[index] ||
      createHash("sha256").update(receipt.bytes).digest("hex") !== receipt.sha256
    )
      throw new Error("The candidate pilot report hash changed.");
    let report: {
      manifest: AttributionPilotPlan;
      rows: AttributionDryRow[];
      importedDocuments: { sourceId: string; documentId: string }[];
      ledger: Ledger;
      stopReason: string | null;
    };
    try {
      report = JSON.parse(receipt.bytes);
      validateAttributionPilot(report.manifest);
      const measured = report.manifest;
      if (
        measured.phase !== "pilot" ||
        measured.arm !== "after" ||
        measured.sourceHead !== plan.pins.after ||
        JSON.stringify(measured.pins) !== JSON.stringify(plan.pins) ||
        JSON.stringify(measured.sharedHashes) !== JSON.stringify(plan.sharedHashes) ||
        models.has(measured.model) ||
        report.stopReason !== null ||
        (report.ledger.phase ?? "pilot") !== "pilot" ||
        report.ledger.stopKind !== null ||
        report.ledger.version !== 1 ||
        report.ledger.task !== "attribution-pilot" ||
        report.ledger.capUSD !== measured.capUSD ||
        !finite(report.ledger.chargedUSD) ||
        report.ledger.chargedUSD > report.ledger.capUSD ||
        JSON.stringify(report.ledger.pins) !== JSON.stringify(plan.pins) ||
        report.ledger.fixtureSHA256 !== plan.fixtureSHA256 ||
        JSON.stringify(report.ledger.caseIds) !== JSON.stringify(ATTRIBUTION_PILOT_CASES) ||
        JSON.stringify(report.ledger.sharedHashes) !== JSON.stringify(plan.sharedHashes) ||
        report.ledger.entries.length === 0 ||
        report.ledger.entries.some((entry) => {
          const usage = entry.usage;
          return (
            entry.status !== "settled" ||
            entry.outcome !== "complete" ||
            usage?.known !== true ||
            usage.cacheComplete !== true ||
            !finite(usage.input) ||
            !finite(usage.output) ||
            !finite(usage.cacheRead) ||
            !finite(usage.cacheWrite) ||
            usage.cacheRead + usage.cacheWrite > usage.input
          );
        }) ||
        JSON.stringify(report.rows.map((row) => row.id)) !== JSON.stringify(ATTRIBUTION_PILOT_CASES)
      )
        throw new Error("Invalid candidate pilot completion.");
      if (
        Math.abs(
          report.ledger.entries.reduce((sum, entry) => sum + entry.chargedUSD, 0) -
            report.ledger.chargedUSD,
        ) > 1e-9 ||
        report.ledger.entries.some(
          (entry) => !finite(entry.chargedUSD) || !finite(entry.maximumUSD),
        )
      )
        throw new Error("Invalid candidate pilot billing.");
      const documents = new Map(
        report.importedDocuments.map((document) => [document.sourceId, document.documentId]),
      );
      if (
        documents.size !== frozen.sources.length ||
        new Set(documents.values()).size !== documents.size ||
        frozen.sources.some((source) => !documents.has(source.id))
      )
        throw new Error("Invalid pilot Source inventory.");
      const proofFound = (value: unknown, sample: (typeof frozen.cases)[number]) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("documentId" in value) ||
          !("quote" in value) ||
          typeof value.quote !== "string" ||
          value.quote.trim() === "" ||
          !("check" in value) ||
          value.check !== "found" ||
          !("contentHash" in value)
        )
          return false;
        const source = frozen.sources.find(
          (source) => documents.get(source.id) === value.documentId,
        );
        const profile = frozen.profiles.find((profile) => profile.id === sample.profileId);
        return Boolean(
          source &&
            profile?.inScopeSourceIds.includes(source.id) &&
            value.contentHash === source.sha256 &&
            findQuote(source.text, value.quote),
        );
      };
      const results = new Map<string, NonNullable<AttributionDryRow["result"]>>();
      for (const row of report.rows) {
        const sample = frozen.cases.find((sample) => sample.id === row.id);
        if (
          !sample ||
          row.status !== "returned" ||
          row.error !== null ||
          !row.result ||
          !["supported", "unsupported", "contradicted"].includes(row.result.verdict) ||
          !proofFound("evidence" in row.result ? row.result.evidence : null, sample) ||
          row.requests.length === 0 ||
          row.requests.some(
            (number) =>
              !report.ledger.entries.some(
                (entry) =>
                  entry.request === number &&
                  entry.caseId === row.id &&
                  entry.arm === "after" &&
                  entry.model === measured.model &&
                  entry.sourceHead === plan.pins.after,
              ),
          )
        )
          throw new Error("The candidate pilot has an incomplete result.");
        if (resultFromParts(row.result.parts ?? []).verdict !== row.result.verdict)
          throw new Error("The candidate pilot has inconsistent part results.");
        for (const target of sample.gold.facetTargets) {
          const parts = row.result.parts?.filter(
            (part) =>
              part.span.start === target.span.start &&
              part.span.end === target.span.end &&
              part.facet?.kind === target.facet,
          );
          const part = parts?.length === 1 ? parts[0] : undefined;
          const focus = PILOT_FACET_VERDICTS.find(
            (focus) => focus.caseId === sample.id && focus.kind === target.facet,
          );
          if (
            part?.kind !== "fact" ||
            !["supported", "unsupported", "contradicted"].includes(part.verdict ?? "") ||
            (focus !== undefined && part.verdict !== focus.verdict) ||
            !Array.isArray(part.evidence) ||
            part.evidence.length === 0 ||
            part.evidence.some((citation) => !proofFound(citation, sample))
          )
            throw new Error("The candidate pilot is missing a checked facet.");
        }
        results.set(row.id, row.result);
      }
      const scores = scoreAttributionSet(frozen, documents, results);
      if (
        scores.rows
          .filter((row) => ATTRIBUTION_PILOT_CASES.some((id) => id === row.id))
          .some(
            (row) =>
              row.native !== "hit" ||
              !row.evidence.expectedSource ||
              !row.evidence.physicallyFound ||
              !row.evidence.scoped,
          )
      )
        throw new Error("The candidate pilot does not meet its frozen golds.");
      models.add(measured.model);
    } catch {
      throw new Error("A candidate pilot report is incomplete, mismatched or unsuccessful.");
    }
  }
  if (ATTRIBUTION_PILOT_MODELS.some((model) => !models.has(model)))
    throw new Error("Both candidate models must pass the pilot.");
}

export function attributionPilotJSON(value: unknown, secret?: string): string {
  return JSON.stringify(value, (name, item: unknown) => {
    if (
      /^(?:apiKey|authorization|headers|responseHeaders|requestBodyValues|providerOptions)$/i.test(
        name,
      )
    )
      return undefined;
    if (item instanceof Error) return { name: "Error" };
    return typeof item === "string" && secret ? item.split(secret).join("[redacted]") : item;
  });
}

type Entry = {
  id: string;
  run: string;
  request: number;
  arm: string;
  model: string;
  sourceHead: string;
  caseId: string | null;
  maximumUSD: number;
  chargedUSD: number;
  status: "reserved" | "settled" | "unknown";
  outcome: AttributionRequest["status"];
  usage: AttributionRequest["usage"] | null;
};
type Ledger = {
  version: 1;
  task: "attribution-pilot";
  capUSD: number;
  chargedUSD: number;
  entries: Entry[];
  pins: AttributionPilotPlan["pins"];
  fixtureSHA256: string;
  caseIds: readonly string[];
  sharedHashes: AttributionPilotHashes;
  stopKind: string | null;
  phase?: string;
  pilotReceiptHashes?: readonly string[];
};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function promptByteBound(
  params: Parameters<NonNullable<AttributionObserverHooks["before"]>>[1],
): number {
  const inspect = (value: unknown) => {
    if (typeof value !== "object" || value === null || !("anthropic" in value)) return;
    const anthropic = value.anthropic;
    if (typeof anthropic !== "object" || anthropic === null)
      throw new Error("Unpriced attribution provider options.");
    if (
      ["advisor", "fallbacks", "compaction", "contextManagement", "container", "mcpServers"].some(
        (name) => Object.hasOwn(anthropic, name),
      ) ||
      ("serviceTier" in anthropic && anthropic.serviceTier !== "standard_only") ||
      ("inferenceGeo" in anthropic && anthropic.inferenceGeo !== "global")
    )
      throw new Error("The attribution pilot cannot price this provider feature.");
    if ("cacheControl" in anthropic) {
      const cache = anthropic.cacheControl;
      if (
        typeof cache !== "object" ||
        cache === null ||
        !("type" in cache) ||
        cache.type !== "ephemeral" ||
        ("ttl" in cache && cache.ttl !== "5m")
      )
        throw new Error("The attribution pilot requires known five-minute cache billing.");
    }
  };
  inspect(params.providerOptions);
  for (const message of params.prompt) {
    inspect(message.providerOptions);
    if (typeof message.content !== "string")
      for (const part of message.content) {
        // The Anthropic SDK drops its stream-start metadata from history (#2003).
        if (part.type === "custom" && part.kind === "anthropic.message_start") continue;
        if (!["text", "reasoning", "tool-call", "tool-result"].includes(part.type))
          throw new Error(`The attribution pilot cannot price input part ${part.type}.`);
        if (part.type === "tool-result" && part.output.type === "content")
          for (const content of part.output.value) {
            if (content.type !== "text")
              throw new Error(`The attribution pilot cannot price tool output ${content.type}.`);
            inspect(content.providerOptions);
          }
        if ("providerOptions" in part) inspect(part.providerOptions);
      }
  }
  for (const tool of params.tools ?? []) {
    if (tool.type !== "function")
      throw new Error("Provider-executed paid tools are not enabled for this pilot.");
    if ("providerOptions" in tool) inspect(tool.providerOptions);
  }
  const serialized = JSON.stringify(
    {
      prompt: params.prompt,
      tools: params.tools ?? [],
      responseFormat: params.responseFormat ?? null,
    },
    (_name, value: unknown) => {
      if (
        ["function", "symbol", "bigint"].includes(typeof value) ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw new Error("The attribution request is not serializable.");
      return value;
    },
  );
  // Byte fallback cannot use more tokens than UTF-8 bytes; reserve framing and tool wrappers too.
  return (
    Buffer.byteLength(serialized, "utf8") +
    1024 +
    params.prompt.length * 128 +
    (params.tools?.length ?? 0) * 256
  );
}

export function createAttributionPilotBudget(options: {
  plan: AttributionPilotPlan;
  ledgerPath: string;
  price: Price;
  reservationPrice: Price;
  longInputPrice?: Price;
  defaultOutputTokens: number;
  cacheWritePolicy: "5m" | "unknown";
  pilotReceipts?: readonly AttributionPilotReceipt[];
}) {
  const { plan, ledgerPath } = options;
  validateAttributionPilot(plan);
  if (plan.phase === "full") validatePromotion(plan, options.pilotReceipts ?? []);
  if (options.defaultOutputTokens !== 128000)
    throw new Error("The pinned models' proven app/SDK output limit is required.");
  for (const price of [options.price, options.reservationPrice, options.longInputPrice].filter(
    (price) => price !== undefined,
  )) {
    if (
      price.currency !== "USD" ||
      !finite(price.input) ||
      !finite(price.output) ||
      !finite(price.cacheRead)
    )
      throw new Error("Complete USD attribution pilot rates are required.");
  }
  if (plan.model === "claude-haiku-5-5" && !options.longInputPrice)
    throw new Error("The Haiku long-input billing tier is required.");
  for (const price of [options.price, options.longInputPrice].filter(
    (price) => price !== undefined,
  )) {
    if (
      options.reservationPrice.input < price.input ||
      options.reservationPrice.output < price.output ||
      (options.reservationPrice.cacheRead ?? 0) < (price.cacheRead ?? 0)
    )
      throw new Error("Reservation rates cannot be below an actual billing tier.");
  }
  const run = randomUUID();
  let stopped: string | null = null;
  function load(): Ledger {
    if (!existsSync(ledgerPath))
      return {
        version: 1,
        task: "attribution-pilot",
        capUSD: plan.capUSD,
        chargedUSD: 0,
        entries: [],
        pins: plan.pins,
        fixtureSHA256: plan.fixtureSHA256,
        caseIds: plan.caseIds,
        sharedHashes: plan.sharedHashes,
        stopKind: null,
        ...(plan.phase === "full" && {
          phase: "full",
          pilotReceiptHashes: plan.pilotReceiptHashes,
        }),
      };
    const value: Ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    if (
      value.version !== 1 ||
      value.task !== "attribution-pilot" ||
      (value.phase ?? "pilot") !== plan.phase ||
      (plan.phase === "full" &&
        JSON.stringify(value.pilotReceiptHashes) !== JSON.stringify(plan.pilotReceiptHashes)) ||
      value.capUSD !== plan.capUSD ||
      value.pins?.before !== plan.pins.before ||
      value.pins?.after !== plan.pins.after ||
      value.fixtureSHA256 !== plan.fixtureSHA256 ||
      JSON.stringify(value.caseIds) !== JSON.stringify(plan.caseIds) ||
      (["adapter", "scorer", "host", "entry"] as const).some(
        (name) => value.sharedHashes?.[name] !== plan.sharedHashes[name],
      ) ||
      (value.stopKind !== null && typeof value.stopKind !== "string") ||
      !Array.isArray(value.entries) ||
      !finite(value.chargedUSD) ||
      value.entries.some(
        (entry) =>
          !finite(entry.maximumUSD) ||
          !finite(entry.chargedUSD) ||
          !["reserved", "settled", "unknown"].includes(entry.status),
      ) ||
      Math.abs(value.entries.reduce((sum, entry) => sum + entry.chargedUSD, 0) - value.chargedUSD) >
        1e-9
    )
      throw new Error("The attribution pilot ledger is invalid or its ceiling changed.");
    return value;
  }
  function update<T>(change: (ledger: Ledger) => T): T {
    const lock = `${ledgerPath}.lock`;
    try {
      mkdirSync(lock);
    } catch {
      throw new Error("The attribution pilot ledger is busy; run one arm at a time.");
    }
    try {
      const ledger = load();
      const result = change(ledger);
      const temporary = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
      renameSync(temporary, ledgerPath);
      return result;
    } finally {
      rmdirSync(lock);
    }
  }
  const attempted = (entry: Entry) =>
    entry.run !== run &&
    entry.arm === plan.arm &&
    entry.model === plan.model &&
    entry.sourceHead === plan.sourceHead;
  const retained = load();
  stopped = retained.stopKind;
  if (!stopped && retained.entries.some((entry) => entry.status !== "settled"))
    stopped = "unresolved-reservation";
  if (!stopped && retained.entries.some(attempted)) stopped = "already-attempted";
  function stop(kind: string) {
    stopped = kind;
    update((ledger) => {
      ledger.stopKind ??= kind;
    });
  }
  const hooks: AttributionObserverHooks = {
    prepare: (params) =>
      params.maxOutputTokens === undefined
        ? { ...params, maxOutputTokens: options.defaultOutputTokens }
        : params,
    before(request, params) {
      if (stopped) throw new Error("The attribution pilot is stopped.");
      let promptTokens: number;
      try {
        if (options.cacheWritePolicy !== "5m")
          throw new Error("Known five-minute cache billing is required before sending.");
        promptTokens = promptByteBound(params);
      } catch (error) {
        stop("unpriced-request");
        throw error;
      }
      const outputTokens = params.maxOutputTokens;
      if (!finite(outputTokens)) {
        stop("invalid-output-limit");
        throw new Error("The actual output limit is invalid.");
      }
      const maximumUSD = reservationOf(
        { promptTokens, outputTokens, cacheWrites: true },
        options.reservationPrice,
        new Date(),
      );
      let admitted: boolean;
      try {
        admitted = update((ledger) => {
          if (ledger.stopKind || ledger.entries.some(attempted))
            throw new Error("This attribution arm has stopped or was already attempted.");
          if (ledger.entries.some((entry) => entry.run !== run && entry.status !== "settled"))
            throw new Error("An earlier attribution reservation is unresolved.");
          const settled = ledger.entries.reduce(
            (sum, entry) => sum + (entry.status === "settled" ? entry.chargedUSD : 0),
            0,
          );
          if (plan.phase === "full" && settled > ATTRIBUTION_FULL_SETTLED_STOP_USD) {
            ledger.stopKind = "settled-spend";
            return false;
          }
          if (ledger.chargedUSD + maximumUSD > ledger.capUSD)
            throw new Error("The attribution pilot ceiling cannot fund this request.");
          ledger.chargedUSD += maximumUSD;
          ledger.entries.push({
            id: randomUUID(),
            run,
            request: request.number,
            arm: plan.arm,
            model: plan.model,
            sourceHead: plan.sourceHead,
            caseId: request.caseId,
            maximumUSD,
            chargedUSD: maximumUSD,
            status: "reserved",
            outcome: "running",
            usage: null,
          });
          return true;
        });
      } catch (error) {
        stop("admission-refused");
        throw error;
      }
      if (!admitted) {
        stopped = "settled-spend";
        throw new Error("The attribution full phase has passed its settled-spend stop.");
      }
    },
    failed(error) {
      const kind = classifyProviderError(error).kind;
      if (["auth", "out-of-credit", "cost-cap", "plan-limit"].includes(kind)) {
        stopped = kind;
        update((ledger) => {
          ledger.stopKind ??= kind;
        });
      }
    },
    settled(request) {
      try {
        update((ledger) => {
          const entry = ledger.entries.find(
            (entry) => entry.run === run && entry.request === request.number,
          );
          if (!entry) return;
          if (entry.status !== "reserved") {
            if (request.status === "error" || request.status === "aborted")
              entry.outcome = request.status;
            return;
          }
          const { input, output, cacheRead, cacheWrite, known, cacheComplete } = request.usage;
          const price =
            input !== null && input > 100000 && plan.model === "claude-haiku-5-5"
              ? options.longInputPrice
              : options.price;
          let actual: number | null = null;
          if (
            price &&
            known &&
            cacheComplete &&
            input !== null &&
            output !== null &&
            cacheRead !== null &&
            cacheWrite !== null &&
            cacheRead + cacheWrite <= input
          )
            actual = costOf(
              {
                inputTokens: input,
                outputTokens: output,
                cachedInputTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
              },
              price,
              new Date(),
              { cacheWrites: true },
            );
          const charged = actual ?? entry.maximumUSD;
          ledger.chargedUSD += charged - entry.chargedUSD;
          entry.chargedUSD = charged;
          entry.status = actual === null ? "unknown" : "settled";
          entry.outcome = request.status;
          entry.usage = request.usage;
          if (actual === null || actual > entry.maximumUSD) {
            stopped ??= actual === null ? "unknown-usage" : "reservation-exceeded";
            ledger.stopKind ??= stopped;
          }
        });
      } catch (error) {
        stopped = "ledger-failure";
        throw error;
      }
    },
  };
  return { hooks, stopped: () => stopped !== null, stopReason: () => stopped, snapshot: load };
}
