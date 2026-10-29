/**
 * The one counter every cloud chat model request goes through (#83): Answers
 * and their Runs, the calls that don't write the Answer, tagging,
 * classification, suggestions and Edit with AI. `Chat.prepareModel` wraps
 * each model it hands out, so nothing above it needs to know.
 *
 * - A request billed per token (catalog/billing) with a known price is first
 *   reserved at its most: its prompt (estimated high) and its output limit.
 *   A reservation that would pass the monthly cap is refused with
 *   `CostCapError`, and nothing is sent. Reserving is one synchronous
 *   transaction, so requests made at once never pass the cap together.
 * - It settles at what the provider reported. With nothing reported (a
 *   provider that doesn't say, a stop, a failure halfway), at the prompt's
 *   estimate and the output that came, never above the reservation. One the
 *   provider never answered cost nothing, and its row is soft-deleted.
 *   Usage heard while a reply streams is kept on its open row. A reservation
 *   a crash left open settles at that usage at the next start (`settleOpen`),
 *   never at the reservation; with none heard, at nothing, marked
 *   "interrupted" so the cost line can say its cost isn't known (#636).
 * - A request that offers the provider's own web search (#128) also
 *   reserves a search's fee and the input its pages may add, and settles at
 *   the fee for each search it made.
 * - A ChatGPT plan request is recorded with its tokens and no price: the
 *   plan's own limit is its cap. An Ollama Cloud model's used-up allowance
 *   (HTTP 402) becomes a plan limit, the same stop as the ChatGPT plan's.
 * - A model on this computer is free and isn't recorded.
 * - Audio sent to a cloud transcription service (#141) is billed by the hour:
 *   it is counted before it is sent, and audio that would pass the cap isn't
 *   counted or sent (`audio`).
 *
 * Records stay in this computer's database; nothing here is sent anywhere.
 */
import { randomUUID } from "node:crypto";
import { APICallError, type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type {
  Billing,
  ChatProviderKind,
  CostSummary,
  Currency,
  DataFlowId,
  Money,
  MonthlyCap,
  ProviderCost,
  RunEstimate,
  RunEstimateInput,
} from "../api";
import type { Price } from "../providers/catalog/types";
import { ChatGptPlanError } from "../providers/chatgpt/errors";
import type { ChatLanguageModel } from "../providers/models";
import { tokenUsageOf } from "../providers/promptCache";
import { CostCapError, PlanLimitError } from "../providers/providerErrors";
import { retryAfterMs } from "../providers/retryAfter";
import { searchFee, searchFeeOf } from "../providers/webSearch";
import { currentTask } from "../runs/current";
import type { TokenUsage } from "../runs/engine";
import type { Database } from "../storage";
import type { Timings } from "../timing/timings";
import { costOf, inCurrency, promptTokensOf, reservationOf, TYPICAL_ANSWER } from "./price";

type Wrapped = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type CallOptions = Wrapped["params"];
type StreamPart =
  Awaited<ReturnType<Wrapped["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;
type Usage = Extract<StreamPart, { type: "finish" }>["usage"];

/** What is known of a model when it is handed out, for metering its requests. */
export interface MeteredModel {
  providerId: string;
  kind: ChatProviderKind;
  modelId: string;
  /** The data flow its requests go out on, or a connection test. */
  flow: DataFlowId | "test";
  billing: Billing;
  /** Its price, when known; a model billed per token without one is recorded, not reserved. */
  price: Price | undefined;
  /** Its output limit, for a request that sets none. */
  maxOutput: number | undefined;
  /** A model in Ollama that runs on ollama.com. */
  ollamaCloud: boolean;
  reasoning?: string;
}

/** The output reserved for a request that sets no limit, on a model whose limit isn't known. */
const DEFAULT_OUTPUT_TOKENS = 16_384;

interface ItemCost {
  calls: number;
  /** A call before this computer has recorded two items' worth on the model. */
  call: Required<TokenUsage>;
  flow: DataFlowId;
}

const ITEM_COSTS: Record<NonNullable<RunEstimateInput["each"]>, ItemCost> = {
  /** An Answer searches, then writes: a third of a typical Answer's tokens each, none cached. */
  answer: {
    calls: 3,
    call: {
      inputTokens: TYPICAL_ANSWER.inputTokens / 3,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: TYPICAL_ANSWER.outputTokens / 3,
    },
    flow: "chat",
  },
  /**
   * A sentence checked: it searches, cites and gives its verdict, with its
   * run's one call naming the claims shared out. Measured on a memo checked
   * with Claude Haiku 5.5 (tests/fixtures/cost/recorded-checks.json). Its own
   * recorded calls, not Answers', which carry more of the Documents: those made
   * one estimate seven times its run's cost (#973). A Supported reply also
   * classifies whether the sentence claims absence before it can stand.
   */
  check: {
    calls: 3.35,
    call: {
      inputTokens: 8_260,
      cachedInputTokens: 2_903,
      cacheWriteTokens: 4_362,
      outputTokens: 129,
    },
    flow: "checks",
  },
};
/** The recorded requests an estimate averages, once there are two items' worth. */
const RECORDED_CALLS = 100;

interface RequestRow {
  provider_id: string;
  billing: Billing;
  currency: Currency | null;
  requests: number;
  settled: number;
  set_aside: number;
  tokens: number | null;
  interrupted: number;
}

/** What streamed of a reply that reported no usage, to settle it by: about a token per three bytes. */
const streamedBytes = (part: { type: string; delta?: unknown }) =>
  (part.type === "text-delta" ||
    part.type === "reasoning-delta" ||
    part.type === "tool-input-delta") &&
  typeof part.delta === "string"
    ? Buffer.byteLength(part.delta)
    : 0;

const reported = (usage: Usage) =>
  usage.inputTokens.total !== undefined || usage.outputTokens.total !== undefined;

/** An Ollama Cloud model's refusal for a used-up allowance, as a plan limit; null for any other error. */
function ollamaLimit(model: MeteredModel, error: unknown): PlanLimitError | null {
  if (!model.ollamaCloud || !APICallError.isInstance(error)) return null;
  const said = `${error.message} ${error.responseBody ?? ""}`;
  if (error.statusCode !== 402 && !/\b402\b|usage limit/i.test(said)) return null;
  const wait = error.responseHeaders ? retryAfterMs(new Headers(error.responseHeaders)) : null;
  return new PlanLimitError(
    `Ollama Cloud: ${error.message}`,
    wait === null ? null : Date.now() + wait,
  );
}

/** Anthropic bills prompt-cache writes above the input price; the others don't. */
const writesCache = (model: MeteredModel) => model.kind === "anthropic";

/**
 * The input a web search's pages may add to its request, reserved for each:
 * the provider reads the pages it found as input before the model goes on.
 */
const SEARCH_INPUT_TOKENS = 30_000;

/** A request's own web searches (#128), by the name the request gives each, with what one costs. */
function searchesOffered(tools: CallOptions["tools"]): Map<string, Money> {
  const offered = new Map<string, Money>();
  for (const tool of tools ?? []) {
    const fee = tool.type === "provider" ? searchFee(tool.id) : undefined;
    if (fee) offered.set(tool.name, fee);
  }
  return offered;
}

/** The name of the search tool a reply's part shows the provider using, or null for any other part. */
function searchMade(offered: ReadonlyMap<string, Money>, part: object): string | null {
  if (!("type" in part) || part.type !== "tool-call") return null;
  if (!("providerExecuted" in part) || part.providerExecuted !== true) return null;
  const name = "toolName" in part ? part.toolName : null;
  return typeof name === "string" && offered.has(name) ? name : null;
}

/**
 * The provider never answered: it refused the request with an HTTP error or a
 * plan's limit, or couldn't be reached. It bills nothing.
 */
const neverAnswered = (error: unknown) =>
  APICallError.isInstance(error) ||
  error instanceof ChatGptPlanError ||
  error instanceof PlanLimitError;

export type Meter = ReturnType<typeof createMeter>;

const usageOf = (usage: Usage) => ({
  inputTokens: usage.inputTokens.total,
  cachedInputTokens: usage.inputTokens.cacheRead,
  outputTokens: usage.outputTokens.total,
});

const outcomeOf = (error: unknown) =>
  error instanceof Error && error.name === "AbortError" ? "stopped" : "failed";

const GENERATED: Readonly<Record<string, string>> = {
  text: "text-delta",
  reasoning: "reasoning-delta",
  "tool-call": "tool-call",
};

function timingMiddleware(timings: Timings, metered: MeteredModel): LanguageModelMiddleware {
  const about = {
    dataFlow: metered.flow,
    providerKind: metered.kind,
    modelId: metered.modelId,
    reasoning: metered.reasoning ?? null,
  };
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const timing = timings.request(about);
      try {
        const result = await doGenerate();
        for (const part of result.content) timing.heard(GENERATED[part.type] ?? part.type);
        timing.end("finished", usageOf(result.usage));
        return result;
      } catch (error) {
        timing.end(outcomeOf(error), null);
        throw error;
      }
    },
    wrapStream: async ({ doStream }) => {
      const timing = timings.request(about);
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        timing.end(outcomeOf(error), null);
        throw error;
      }
      const reader = result.stream.getReader();
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              timing.end("stopped", null);
              controller.close();
              return;
            }
            timing.heard(value.type);
            if (value.type === "finish") timing.end("finished", usageOf(value.usage));
            else if (value.type === "error") timing.end("failed", null);
            controller.enqueue(value);
          } catch (error) {
            timing.end(outcomeOf(error), null);
            controller.error(error);
          }
        },
        async cancel(reason) {
          timing.end("stopped", null);
          await reader.cancel(reason);
        },
      });
      return { ...result, stream };
    },
  };
}

export function createMeter(options: {
  db: Database;
  now: () => Date;
  /** The monthly cap, read at each reservation, so a change applies to the next request. */
  cap: () => MonthlyCap | null;
  /** A free model's requests, on this computer, are timed too. */
  timings?: Timings;
}) {
  const { db, now, timings } = options;

  /** The start of this calendar month, in the computer's time zone. */
  const monthStart = (at: Date) => new Date(at.getFullYear(), at.getMonth(), 1).toISOString();

  /** Per provider, billing and currency: requests, what the settled ones cost, what the open ones reserved, and tokens. */
  const monthRows = (since: string) =>
    db.all<RequestRow>(
      `SELECT provider_id, billing, currency, count(*) AS requests,
         coalesce(sum(CASE WHEN status <> 'reserved' THEN cost END), 0) AS settled,
         coalesce(sum(CASE WHEN status = 'reserved' THEN reserved END), 0) AS set_aside,
         sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) AS tokens,
         sum(status = 'interrupted') AS interrupted
       FROM model_requests
       WHERE deleted_at IS NULL AND created_at >= ?
       GROUP BY provider_id, billing, currency
       ORDER BY min(created_at)`,
      [since],
    );

  const monthIn = (currency: Currency, since: string) => {
    let settled = 0;
    let setAside = 0;
    for (const row of monthRows(since)) {
      if (row.billing !== "per-token" || !row.currency) continue;
      settled += inCurrency(row.settled, row.currency, currency);
      setAside += inCurrency(row.set_aside, row.currency, currency);
    }
    return { settled, setAside };
  };

  const againstCap = (currency: Currency, since: string) => {
    const { settled, setAside } = monthIn(currency, since);
    return settled + setAside;
  };

  const towardCap = (cap: MonthlyCap | null, since: string) => {
    if (!cap) return { spentTowardCap: null, setAsideTowardCap: null };
    const { settled, setAside } = monthIn(cap.currency, since);
    return {
      spentTowardCap: { currency: cap.currency, amount: settled },
      setAsideTowardCap: { currency: cap.currency, amount: setAside },
    };
  };

  /** Opens a request's record; throws `CostCapError`, recording nothing, when its reservation would pass the cap. */
  function begin(model: MeteredModel, params: CallOptions) {
    const at = now();
    const id = randomUUID();
    const promptTokens = promptTokensOf(params.prompt, params.tools);
    const { price } = model;
    const priced = model.billing === "per-token" && price !== undefined;
    const cacheWrites = writesCache(model);
    const offered = searchesOffered(params.tools);
    /** What searches with these tools cost, in the price's currency. */
    const feesOf = (tools: Iterable<string>) => {
      if (!priced || !price) return 0;
      let sum = 0;
      for (const name of tools) {
        const fee = offered.get(name);
        if (fee) sum += inCurrency(fee.amount, fee.currency, price.currency);
      }
      return sum;
    };
    const reserved = priced
      ? reservationOf(
          {
            promptTokens: promptTokens + offered.size * SEARCH_INPUT_TOKENS,
            outputTokens: params.maxOutputTokens ?? model.maxOutput ?? DEFAULT_OUTPUT_TOKENS,
            cacheWrites,
          },
          price,
          at,
        ) + feesOf(offered.keys())
      : null;
    const created = at.toISOString();
    db.transaction(() => {
      const cap = options.cap();
      if (cap && price && reserved !== null) {
        const after =
          againstCap(cap.currency, monthStart(at)) +
          inCurrency(reserved, price.currency, cap.currency);
        if (after > cap.amount) throw new CostCapError();
      }
      db.run(
        `INSERT INTO model_requests (id, provider_id, model_id, flow, billing, status, currency,
           reserved, run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?)`,
        [
          id,
          model.providerId,
          model.modelId,
          model.flow,
          model.billing,
          priced ? price.currency : null,
          reserved,
          currentTask.getStore() ?? null,
          created,
          created,
        ],
      );
    });

    let open = true;
    const close = (cost: number | null, usage: TokenUsage | null) => {
      if (!open) return;
      open = false;
      db.run(
        `UPDATE model_requests SET status = 'settled', cost = ?, input_tokens = ?,
           cached_input_tokens = ?, cache_write_tokens = ?, output_tokens = ?, updated_at = ?
         WHERE id = ?`,
        [
          cost,
          usage?.inputTokens ?? null,
          usage?.cachedInputTokens ?? null,
          usage?.cacheWriteTokens ?? null,
          usage?.outputTokens ?? null,
          now().toISOString(),
          id,
        ],
      );
    };
    /** The web searches the reply made, by their tool's name. */
    const searches: string[] = [];
    /** What a usage report costs, with the searches made so far. */
    const counted = (usage: Usage) =>
      tokenUsageOf({
        inputTokens: usage.inputTokens.total,
        outputTokens: usage.outputTokens.total,
        inputTokenDetails: {
          cacheReadTokens: usage.inputTokens.cacheRead,
          cacheWriteTokens: usage.inputTokens.cacheWrite,
        },
      });
    /** Keeps usage heard before the reply ended on the open row, for a crash to settle by. */
    const record = (usage: Usage) => {
      if (!open || !reported(usage)) return;
      const tokens = counted(usage);
      db.run(
        `UPDATE model_requests SET cost = ?, input_tokens = ?, cached_input_tokens = ?,
           cache_write_tokens = ?, output_tokens = ?, updated_at = ?
         WHERE id = ?`,
        [
          priced ? costOf(tokens, price, at, { cacheWrites }) + feesOf(searches) : null,
          tokens.inputTokens ?? null,
          tokens.cachedInputTokens ?? null,
          tokens.cacheWriteTokens ?? null,
          tokens.outputTokens ?? null,
          now().toISOString(),
          id,
        ],
      );
    };
    /** Settles at what came back when nothing was reported: the prompt's estimate and the output's bytes. */
    const estimated = (outputBytes: number) => {
      const outputTokens = Math.ceil(outputBytes / 3);
      const cost =
        priced && reserved !== null
          ? Math.min(
              reserved,
              reservationOf({ promptTokens, outputTokens, cacheWrites: false }, price, at) +
                feesOf(searches),
            )
          : null;
      close(cost, { inputTokens: promptTokens, outputTokens });
    };

    return {
      /** Hears a part of the reply: a web search the provider made is billed. */
      heard(part: object) {
        const search = searchMade(offered, part);
        if (search) searches.push(search);
        const usage = "usage" in part ? (part.usage as Usage | undefined) : undefined;
        if (usage && !("finishReason" in part)) record(usage);
      },
      settle(usage: Usage, outputBytes: number) {
        if (!reported(usage)) return estimated(outputBytes);
        const tokens = counted(usage);
        close(
          priced ? costOf(tokens, price, at, { cacheWrites }) + feesOf(searches) : null,
          tokens,
        );
      },
      /** It ended without a report: a failure after it began, a stop, or a provider that reports none. */
      end: estimated,
      /** It failed before any reply: refused or unreachable, or stopped while the provider may have read it. */
      failed(error: unknown) {
        if (!open) return;
        if (!neverAnswered(error)) return estimated(0);
        open = false;
        const at = now().toISOString();
        db.run("UPDATE model_requests SET deleted_at = ?, updated_at = ? WHERE id = ?", [
          at,
          at,
          id,
        ]);
      },
    };
  }

  /** Text of a whole reply, for one that reported no usage. */
  const contentBytes = (content: readonly { type: string; text?: unknown }[]) =>
    content.reduce(
      (sum, part) => sum + (typeof part.text === "string" ? Buffer.byteLength(part.text) : 0),
      0,
    );

  return {
    /** The model, with every request it makes counted (and, billed per token, reserved against the cap). */
    wrap(model: ChatLanguageModel, metered: MeteredModel): ChatLanguageModel {
      const timed = timings ? [timingMiddleware(timings, metered)] : [];
      if (metered.billing === "free") {
        return timed.length > 0 ? wrapLanguageModel({ model, middleware: timed }) : model;
      }
      return wrapLanguageModel({
        model,
        // The timing goes inside, around the model alone: a request the cap refuses was never made.
        middleware: [
          {
            specificationVersion: "v4",
            wrapGenerate: async ({ doGenerate, params }) => {
              const request = begin(metered, params);
              try {
                const result = await doGenerate();
                for (const part of result.content) request.heard(part);
                request.settle(result.usage, contentBytes(result.content));
                return result;
              } catch (error) {
                const limit = ollamaLimit(metered, error);
                request.failed(limit ?? error);
                throw limit ?? error;
              }
            },
            wrapStream: async ({ doStream, params }) => {
              const request = begin(metered, params);
              let result: Awaited<ReturnType<typeof doStream>>;
              try {
                result = await doStream();
              } catch (error) {
                const limit = ollamaLimit(metered, error);
                request.failed(limit ?? error);
                throw limit ?? error;
              }
              const reader = result.stream.getReader();
              let bytes = 0;
              const stream = new ReadableStream<StreamPart>({
                async pull(controller) {
                  try {
                    const { done, value } = await reader.read();
                    if (done) {
                      request.end(bytes);
                      controller.close();
                      return;
                    }
                    bytes += streamedBytes(value);
                    request.heard(value);
                    if (value.type === "finish") request.settle(value.usage, bytes);
                    const limit = value.type === "error" ? ollamaLimit(metered, value.error) : null;
                    controller.enqueue(limit ? { type: "error", error: limit } : value);
                  } catch (error) {
                    request.end(bytes);
                    controller.error(error);
                  }
                },
                async cancel(reason) {
                  request.end(bytes);
                  await reader.cancel(reason);
                },
              });
              return { ...result, stream };
            },
          },
          ...timed,
        ],
      });
    },

    /**
     * Audio sent to a cloud transcription service on one stretch of recording, one record a
     * month, its cost growing as audio is counted. `add` counts audio about to be sent, and
     * says false, counting nothing, when it would take the month past the cap.
     */
    audio(use: { providerId: string; modelId: string; perHour: Money }) {
      let row: { id: string; month: string } | null = null;
      return {
        add(ms: number): boolean {
          const at = now();
          const month = monthStart(at);
          const amount = (use.perHour.amount * Math.max(0, ms)) / 3_600_000;
          const { currency } = use.perHour;
          return db.transaction(() => {
            const cap = options.cap();
            if (cap) {
              const spent = againstCap(cap.currency, month);
              // A month already at the cap sends nothing more, however little.
              if (spent >= cap.amount) return false;
              if (spent + inCurrency(amount, currency, cap.currency) > cap.amount) return false;
            }
            const stamp = at.toISOString();
            if (row?.month === month) {
              db.run("UPDATE model_requests SET cost = cost + ?, updated_at = ? WHERE id = ?", [
                amount,
                stamp,
                row.id,
              ]);
            } else {
              row = { id: randomUUID(), month };
              db.run(
                `INSERT INTO model_requests (id, provider_id, model_id, flow, billing, status, currency,
                   cost, created_at, updated_at)
                 VALUES (?, ?, ?, 'transcription', 'per-token', 'settled', ?, ?, ?, ?)`,
                [row.id, use.providerId, use.modelId, currency, amount, stamp, stamp],
              );
            }
            return true;
          });
        },
      };
    },

    /**
     * Settles the reservations a crash left open: at the usage heard before it, else at
     * nothing, marked interrupted (what the provider billed isn't known, and no lookup is
     * made). Never at the reservation. Returns how many.
     */
    settleOpen(): number {
      const open = db.get<{ count: number }>(
        "SELECT count(*) AS count FROM model_requests WHERE status = 'reserved' AND deleted_at IS NULL",
      );
      if (!open?.count) return 0;
      db.run(
        `UPDATE model_requests
         SET status = CASE WHEN cost IS NOT NULL OR input_tokens IS NOT NULL OR output_tokens IS NOT NULL
                           THEN 'settled' ELSE 'interrupted' END,
             cost = CASE WHEN cost IS NULL AND currency IS NOT NULL THEN 0 ELSE cost END,
             updated_at = ?
         WHERE status = 'reserved' AND deleted_at IS NULL`,
        [now().toISOString()],
      );
      return open.count;
    },

    /** This month so far: what was spent, what is set aside, and each provider's use. */
    summary(): CostSummary {
      const since = monthStart(now());
      const rows = monthRows(since);
      const byProvider = new Map<string, ProviderCost>();
      const totals = new Map<Currency, number>();
      const asides = new Map<Currency, number>();
      for (const row of rows) {
        const provider = byProvider.get(row.provider_id) ?? {
          providerId: row.provider_id,
          billing: row.billing,
          requests: 0,
          spent: [],
          setAside: [],
          unpricedTokens: 0,
          interrupted: 0,
        };
        provider.requests += row.requests;
        provider.interrupted += row.interrupted;
        if (row.billing === "per-token" && row.currency === null) {
          provider.unpricedTokens += row.tokens ?? 0;
        } else if (row.billing === "per-token" && row.currency) {
          provider.spent.push({ currency: row.currency, amount: row.settled });
          totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.settled);
          if (row.set_aside > 0) {
            provider.setAside.push({ currency: row.currency, amount: row.set_aside });
            asides.set(row.currency, (asides.get(row.currency) ?? 0) + row.set_aside);
          }
        }
        byProvider.set(row.provider_id, provider);
      }
      const cap = options.cap();
      const moneys = (byCurrency: Map<Currency, number>): Money[] =>
        [...byCurrency].map(([currency, amount]) => ({ currency, amount }));
      return {
        monthStart: since,
        spent: moneys(totals),
        setAside: moneys(asides),
        cap,
        ...towardCap(cap, since),
        providers: [...byProvider.values()],
      };
    },

    /**
     * What a Task's settled model requests billed per token have cost, in the
     * currency of most of it (the other at the fixed rate); null when none was priced.
     */
    taskCost(taskId: string): Money | null {
      const rows = db.all<{ currency: Currency; amount: number }>(
        `SELECT currency, sum(cost) AS amount
         FROM model_requests
         WHERE run_id = ? AND deleted_at IS NULL AND billing = 'per-token'
           AND currency IS NOT NULL AND status <> 'reserved'
         GROUP BY currency ORDER BY amount DESC`,
        [taskId],
      );
      const [main] = rows;
      if (!main) return null;
      const amount = rows.reduce(
        (sum, row) => sum + inCurrency(row.amount ?? 0, row.currency, main.currency),
        0,
      );
      return { currency: main.currency, amount };
    },

    /**
     * The estimate before a large run of `items` on `model`: each item's calls
     * (`ITEM_COSTS`), each the average of this computer's recent requests to
     * the model for the same kind of item once it has made enough, else that
     * kind's measured call. On recorded Answers its tokens come within 15% of
     * the run's, and its price from 10% below to 2.5 times above: higher when
     * recent requests found the prompt cache cold, as the first of a session
     * does, and a run's later ones don't.
     */
    estimate(
      model: MeteredModel,
      items: number,
      searches = 0,
      kind: NonNullable<RunEstimateInput["each"]> = "answer",
    ): RunEstimate {
      if (model.billing !== "per-token") return { billing: model.billing };
      const item = ITEM_COSTS[kind];
      const recent = db.all<Required<TokenUsage>>(
        `SELECT input_tokens AS inputTokens, coalesce(cached_input_tokens, 0) AS cachedInputTokens,
           coalesce(cache_write_tokens, 0) AS cacheWriteTokens, output_tokens AS outputTokens
         FROM model_requests
         WHERE deleted_at IS NULL AND status = 'settled' AND provider_id = ? AND model_id = ?
           AND flow = ? AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
         ORDER BY created_at DESC LIMIT ?`,
        [model.providerId, model.modelId, item.flow, RECORDED_CALLS],
      );
      const mean = (pick: (each: Required<TokenUsage>) => number) =>
        recent.reduce((sum, each) => sum + pick(each), 0) / recent.length;
      const call: Required<TokenUsage> =
        recent.length >= 2 * item.calls
          ? {
              inputTokens: mean((each) => each.inputTokens),
              cachedInputTokens: mean((each) => each.cachedInputTokens),
              cacheWriteTokens: mean((each) => each.cacheWriteTokens),
              outputTokens: mean((each) => each.outputTokens),
            }
          : item.call;
      const calls = Math.round(Math.max(0, Math.round(items)) * item.calls);
      const at = now();
      const cap = options.cap();
      const fee = searchFeeOf(model.kind);
      const searchCost = (price: Price) =>
        fee
          ? searches *
            (inCurrency(fee.amount, fee.currency, price.currency) +
              costOf({ inputTokens: SEARCH_INPUT_TOKENS }, price, at))
          : 0;
      return {
        billing: "per-token",
        calls,
        tokens: Math.round(
          calls * (call.inputTokens + call.outputTokens) +
            (fee ? searches * SEARCH_INPUT_TOKENS : 0),
        ),
        cost: model.price
          ? {
              currency: model.price.currency,
              amount:
                calls * costOf(call, model.price, at, { cacheWrites: writesCache(model) }) +
                searchCost(model.price),
            }
          : null,
        ...towardCap(cap, monthStart(at)),
        cap,
      };
    },
  };
}
