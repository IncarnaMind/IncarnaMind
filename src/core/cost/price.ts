/**
 * What a model request costs, from its price (../providers/catalog): the
 * cached input at its own rate, Anthropic's cache writes above the input
 * price, and off-peak hours at their cut price.
 */
import type { Currency } from "../api";
import { CNY_PER_USD } from "../providers/catalog/billing";
import type { Price } from "../providers/catalog/types";
import type { TokenUsage } from "../runs/engine";

/** The one assumption behind every estimate of what Answers cost: about three calls, a search then the writing. */
export const TYPICAL_ANSWER = { inputTokens: 12_000, outputTokens: 750 } as const;

/** Anthropic bills a 5-minute prompt-cache write at 1.25 times the input price. */
const CACHE_WRITE_FACTOR = 1.25;

/** An image or file in a prompt, counted at about what a page-sized image costs. */
const FILE_TOKENS = 1_600;

/** What each message adds around its content. */
const MESSAGE_TOKENS = 4;

/** The share of the full price that applies at `at`: less outside the peak hours of a price that has them. */
export function rateAt(price: Price, at: Date): number {
  const { offPeak } = price;
  if (!offPeak) return 1;
  const there = new Date(at.getTime() + offPeak.utcOffset * 3_600_000);
  const weekend = there.getUTCDay() === 0 || there.getUTCDay() === 6;
  if (weekend && !offPeak.everyDay) return offPeak.factor;
  const hour = there.getUTCHours() + there.getUTCMinutes() / 60;
  return offPeak.peakHours.some(([from, to]) => hour >= from && hour < to) ? 1 : offPeak.factor;
}

/**
 * What a request that counted `usage` costs at `at`, in the price's currency.
 * Cache writes cost more only where the provider bills them so (`cacheWrites`,
 * Anthropic); OpenAI reports them too, at the input price.
 */
export function costOf(
  usage: TokenUsage,
  price: Price,
  at: Date,
  { cacheWrites = false }: { cacheWrites?: boolean } = {},
): number {
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const written = cacheWrites ? Math.min(usage.cacheWriteTokens ?? 0, input - cached) : 0;
  const millionths =
    (input - cached - written) * price.input +
    cached * (price.cacheRead ?? price.input) +
    written * price.input * CACHE_WRITE_FACTOR +
    (usage.outputTokens ?? 0) * price.output;
  return (millionths / 1_000_000) * rateAt(price, at);
}

/**
 * The most a request may cost: all of its prompt at the input price (written
 * to the cache, where its provider does), and all of its output limit.
 */
export function reservationOf(
  request: { promptTokens: number; outputTokens: number; cacheWrites: boolean },
  price: Price,
  at: Date,
): number {
  const input = request.cacheWrites ? price.input * CACHE_WRITE_FACTOR : price.input;
  const millionths = request.promptTokens * input + request.outputTokens * price.output;
  return (millionths / 1_000_000) * rateAt(price, at);
}

/** An amount in another currency, at the fixed rate. */
export function inCurrency(amount: number, from: Currency, to: Currency): number {
  if (from === to) return amount;
  return from === "USD" ? amount * CNY_PER_USD : amount / CNY_PER_USD;
}

type PromptMessage = { content: string | readonly { type: string }[] };

/**
 * About how many tokens a prompt holds, erring high: a token for every three
 * bytes of its text and Tools (English runs about four characters to a token;
 * a Chinese character is three bytes and about one token), and a fixed count
 * for each image or file.
 */
export function promptTokensOf(
  prompt: readonly PromptMessage[],
  tools?: readonly unknown[],
): number {
  let bytes = tools && tools.length > 0 ? Buffer.byteLength(JSON.stringify(tools)) : 0;
  let files = 0;
  for (const message of prompt) {
    if (typeof message.content === "string") {
      bytes += Buffer.byteLength(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "file") files++;
      else bytes += Buffer.byteLength(JSON.stringify(part));
    }
  }
  return Math.ceil(bytes / 3) + files * FILE_TOKENS + prompt.length * MESSAGE_TOKENS;
}

/** At the full rate, so an estimate doesn't change with the hour. */
export function typicalAnswerCost(price: Price): number {
  const { offPeak: _offPeak, ...full } = price;
  return costOf(TYPICAL_ANSWER, full, new Date());
}
