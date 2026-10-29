/**
 * What a run of the benchmark costs: the catalog's price of each model, the
 * tokens a Question is expected to take, and the cap a run refuses to pass.
 * Prices are the app's own (src/core/providers/catalog), so an estimate
 * changes with them.
 */
import type { ChatProviderKind } from "../../src/core";
import { costOf, inCurrency, reservationOf } from "../../src/core/cost/price";
import { catalogFacts, modelsProviderOfKind } from "../../src/core/providers/catalog";
import type { Price } from "../../src/core/providers/catalog/types";
import type { Tokens } from "./runs";

/**
 * The tokens one Question takes, measured on the app's Answers path over the
 * mixed sample set with Claude Haiku 5.5 and Sonnet 5.5 (October 2026, the
 * paired speed runs of #1634): an Answer about 40,000 in and 1,300 out, about
 * 70% of its input from the provider's prompt cache. Checking a sentence takes
 * about 16,700 in and 330 out (#1608); an Answer here has about five that make
 * a claim, and naming them takes one short request more.
 */
export const PER_QUESTION = {
  answer: { inputTokens: 40_000, outputTokens: 1_300 },
  check: { inputTokens: 5 * 16_700 + 3_000, outputTokens: 5 * 330 + 300 },
} as const;

/** Of an expected input, the share a provider with a prompt cache serves from it. */
export const CACHED_SHARE = 0.7;

/** One Answer took nearly four times the median's input (152,267 tokens): the most a Question may take. */
export const MOST_FACTOR = 4;

/** A judge reads a sentence, its quote and the Passage, about 1,500 tokens, and gives a short verdict. */
export const PER_JUDGEMENT = { inputTokens: 1_500, outputTokens: 120 } as const;

/** About three Citations an Answer, as the measured Answers have. */
export const CITATIONS_PER_ANSWER = 3;

export interface ModelRef {
  kind: ChatProviderKind;
  modelId: string;
  endpoint?: string | null;
}

export const labelOf = (model: Pick<ModelRef, "kind" | "modelId">) =>
  `${model.kind}/${model.modelId}`;

/** The price the app meters this model at; null when the catalog has none (a model on this computer). */
export function priceOf(model: ModelRef): Price | null {
  if (model.kind === "ollama") return null;
  return (
    catalogFacts(modelsProviderOfKind(model.kind, model.endpoint ?? null), model.modelId)?.price ??
    null
  );
}

const inUsd = (amount: number, price: Price) => inCurrency(amount, price.currency, "USD");

/** What tokens a request counted cost, in US dollars; null without a price. */
export function usdOf(
  tokens: Tokens,
  price: Price | null,
  kind: string,
  at = new Date(),
): number | null {
  if (!price) return null;
  return inUsd(costOf(tokens, price, at, { cacheWrites: kind === "anthropic" }), price);
}

export interface Estimate {
  model: string;
  questions: number;
  /** Tokens expected for the Answers and the checks of their Notes, and for the judges. */
  tokens: { inputTokens: number; outputTokens: number };
  judgeTokens: { inputTokens: number; outputTokens: number };
  /**
   * In US dollars, expected: the provider's prompt cache serving `CACHED_SHARE`
   * of the input where its price has a cache rate; 0 for a model with no price.
   */
  runUsd: number;
  judgesUsd: number;
  /** At most, the run and the judges: every Question taking `MOST_FACTOR` times as many tokens, none from the cache. */
  mostUsd: number;
  /** "measured" when the tokens come from this model's run files, "assumed" from `PER_QUESTION`. */
  basis: "measured" | "assumed";
}

const tokensFor = (check: boolean) => ({
  inputTokens: PER_QUESTION.answer.inputTokens + (check ? PER_QUESTION.check.inputTokens : 0),
  outputTokens: PER_QUESTION.answer.outputTokens + (check ? PER_QUESTION.check.outputTokens : 0),
});

const asTokens = (counts: { inputTokens: number; outputTokens: number }, cached = 0): Tokens => ({
  requests: 0,
  inputTokens: counts.inputTokens,
  cachedInputTokens: cached,
  cacheWriteTokens: 0,
  outputTokens: counts.outputTokens,
});

/**
 * The expected cost of asking `questions` Questions of a model, with its
 * Notes checked or not, and of two judges reading about three Citations each.
 * `measured` is the mean a Question took in this model's runs so far, which
 * replaces the assumption when there is one.
 */
export function estimate(
  model: ModelRef,
  questions: number,
  options: {
    check: boolean;
    judges: readonly ModelRef[];
    measured?: { inputTokens: number; outputTokens: number } | null;
  },
): Estimate {
  const per = options.measured ?? tokensFor(options.check);
  const tokens = {
    inputTokens: per.inputTokens * questions,
    outputTokens: per.outputTokens * questions,
  };
  const judgements = questions * CITATIONS_PER_ANSWER;
  const judgeTokens = {
    inputTokens: PER_JUDGEMENT.inputTokens * judgements * options.judges.length,
    outputTokens: PER_JUDGEMENT.outputTokens * judgements * options.judges.length,
  };
  const price = priceOf(model);
  const cached = price?.cacheRead !== undefined ? Math.round(tokens.inputTokens * CACHED_SHARE) : 0;
  const judgesUsd = options.judges.map((judge) => {
    const judgePrice = priceOf(judge);
    const each = {
      inputTokens: PER_JUDGEMENT.inputTokens * judgements,
      outputTokens: PER_JUDGEMENT.outputTokens * judgements,
    };
    return judgePrice ? usdOf(asTokens(each), judgePrice, judge.kind) : 0;
  });
  const judging = judgesUsd.reduce<number>((sum, each) => sum + (each ?? 0), 0);
  const most = {
    inputTokens: tokens.inputTokens * MOST_FACTOR,
    outputTokens: tokens.outputTokens * MOST_FACTOR,
  };
  return {
    model: labelOf(model),
    questions,
    tokens,
    judgeTokens,
    runUsd: usdOf(asTokens(tokens, cached), price, model.kind) ?? 0,
    judgesUsd: judging,
    mostUsd: (usdOf(asTokens(most), price, model.kind) ?? 0) + judging,
    basis: options.measured ? "measured" : "assumed",
  };
}

/**
 * The most the next Question may cost, in US dollars, reserved before it is
 * asked: `MOST_FACTOR` times what it is expected to take, all at the input
 * price (written to the cache, where the provider bills that more).
 */
export function reservationUsd(model: ModelRef, price: Price | null, check: boolean): number {
  if (!price) return 0;
  const per = tokensFor(check);
  return inUsd(
    reservationOf(
      {
        promptTokens: per.inputTokens * MOST_FACTOR,
        outputTokens: per.outputTokens * MOST_FACTOR,
        cacheWrites: model.kind === "anthropic",
      },
      price,
      new Date(),
    ),
    price,
  );
}

/**
 * Why a run may not start, or go on to its next Question, under the cap;
 * null when it may. A model with a price needs a cap; one on this computer
 * costs nothing and needs none.
 */
export function capProblem(
  capUsd: number | null,
  price: Price | null,
  spentUsd: number,
  nextUsd: number,
): string | null {
  if (!price) return null;
  if (capUsd === null) {
    return "This model costs money: set a cap in US dollars (see eval/citations/README.md) before a run.";
  }
  if (spentUsd + nextUsd > capUsd) {
    return `The cap is $${capUsd.toFixed(2)}: $${spentUsd.toFixed(2)} spent, and the next step may cost up to $${nextUsd.toFixed(2)}.`;
  }
  return null;
}

/** The plan the issue names (#1999): the models whose runs are published. */
export const PLANNED_MODELS: readonly ModelRef[] = [
  { kind: "anthropic", modelId: "claude-sonnet-5-5" },
  { kind: "anthropic", modelId: "claude-haiku-5-5" },
  { kind: "openai", modelId: "gpt-6-luna" },
  { kind: "openai", modelId: "gpt-6.1-sol" },
  { kind: "google", modelId: "gemini-3.8-flash" },
  { kind: "kimi", modelId: "kimi-k2.6", endpoint: "intl" },
  { kind: "deepseek", modelId: "deepseek-v4-pro" },
  { kind: "ollama", modelId: "qwen3.5:4b" },
];

/** Two judges from other families than most models under test; the owner names the real ones. */
export const PLANNED_JUDGES: readonly ModelRef[] = [
  { kind: "anthropic", modelId: "claude-opus-5-5" },
  { kind: "google", modelId: "gemini-3.1-pro-preview" },
];
