/**
 * What a model request costs, from its price (../providers/catalog): the
 * cached input at its own rate, Anthropic's cache writes above the input
 * price, a long prompt at its tier's prices, and off-peak hours at their cut
 * price.
 */
import type { ChatProviderKind, Currency } from "../api";
import { CNY_PER_USD } from "../providers/catalog/billing";
import type { Price, PriceTier } from "../providers/catalog/types";
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
 * How many tokens a provider may count for each one `promptTokensOf` counts.
 * Claude Haiku 5.5 counted 1.09 to 1.16 times as many on #2126's recorded
 * whole read, so Anthropic's 1.45 is a deliberate margin; a provider not
 * measured gets a wider one.
 */
const COUNTED_PER_TOKEN: Partial<Record<ChatProviderKind, number>> = { anthropic: 1.45 };

/** The margin an estimate of a prompt's tokens takes for its provider's own count to fit. */
export const promptTokenRatio = (kind: ChatProviderKind): number => COUNTED_PER_TOKEN[kind] ?? 1.5;

/**
 * The prices one request pays whose prompt holds `promptTokens`, its cache
 * reads and writes counted: the highest tier it is over, else the base prices.
 */
export function priceFor({ tiers, ...base }: Price, promptTokens: number): Price {
  let tier: PriceTier | undefined;
  for (const each of tiers ?? []) {
    if (promptTokens > each.above && (!tier || each.above > tier.above)) tier = each;
  }
  if (!tier) return base;
  const { cacheRead: _cacheRead, ...rest } = base;
  return {
    ...rest,
    input: tier.input,
    output: tier.output,
    ...(tier.cacheRead !== undefined && { cacheRead: tier.cacheRead }),
  };
}

/**
 * What a request that counted `usage` costs at `at`, in the price's currency,
 * at the prices of its prompt's length (`priceFor`). Cache writes cost more
 * only where the provider bills them so (`cacheWrites`, Anthropic); OpenAI
 * reports them too, at the input price.
 */
export function costOf(
  usage: TokenUsage,
  price: Price,
  at: Date,
  { cacheWrites = false }: { cacheWrites?: boolean } = {},
): number {
  const input = usage.inputTokens ?? 0;
  const paid = priceFor(price, input);
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const written = cacheWrites ? Math.min(usage.cacheWriteTokens ?? 0, input - cached) : 0;
  const millionths =
    (input - cached - written) * paid.input +
    cached * (paid.cacheRead ?? paid.input) +
    written * paid.input * CACHE_WRITE_FACTOR +
    (usage.outputTokens ?? 0) * paid.output;
  return (millionths / 1_000_000) * rateAt(paid, at);
}

/**
 * The most a request may cost: all of its prompt at the input price (written
 * to the cache, where its provider does), and all of its output limit.
 * `promptTokens` is the estimate, with what the prompt may grow by while the
 * request runs (the pages a search reads); its tier is picked from that times
 * the provider's `promptTokenRatio`, so a prompt its provider counts higher
 * is not reserved below its tier.
 */
export function reservationOf(
  request: {
    promptTokens: number;
    outputTokens: number;
    cacheWrites: boolean;
    kind: ChatProviderKind;
  },
  price: Price,
  at: Date,
): number {
  const paid = priceFor(price, request.promptTokens * promptTokenRatio(request.kind));
  const input = request.cacheWrites ? paid.input * CACHE_WRITE_FACTOR : paid.input;
  const millionths = request.promptTokens * input + request.outputTokens * paid.output;
  return (millionths / 1_000_000) * rateAt(paid, at);
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
