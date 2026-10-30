import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { costOf, reservationOf } from "../../src/core/cost/price";
import type { Price } from "../../src/core/providers/catalog/types";
import { classifyProviderError } from "../../src/core/providers/providerErrors";
import {
  ATTRIBUTION_SHA256,
  type AttributionObserverHooks,
  type AttributionRequest,
} from "./adapter";

export const ATTRIBUTION_PILOT_CASES = ["N01-en", "C03-zh-CN", "T02-en"] as const;
export const ATTRIBUTION_PILOT_CAP_USD = 2;
export const ATTRIBUTION_PILOT_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
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
}

export function validateAttributionPilot(plan: AttributionPilotPlan) {
  if (plan.phase !== "pilot")
    throw new Error(
      "Only the three-case attribution pilot is enabled; full execution is disabled.",
    );
  if (!Number.isFinite(plan.capUSD) || plan.capUSD <= 0 || plan.capUSD > ATTRIBUTION_PILOT_CAP_USD)
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
    JSON.stringify(plan.caseIds) !== JSON.stringify(ATTRIBUTION_PILOT_CASES)
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
}) {
  const { plan, ledgerPath } = options;
  validateAttributionPilot(plan);
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
      };
    const value: Ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    if (
      value.version !== 1 ||
      value.task !== "attribution-pilot" ||
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
      try {
        update((ledger) => {
          if (ledger.stopKind || ledger.entries.some(attempted))
            throw new Error("This attribution arm has stopped or was already attempted.");
          if (ledger.entries.some((entry) => entry.run !== run && entry.status !== "settled"))
            throw new Error("An earlier attribution reservation is unresolved.");
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
        });
      } catch (error) {
        stop("admission-refused");
        throw error;
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
