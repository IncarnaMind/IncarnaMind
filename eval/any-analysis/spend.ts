/**
 * What a run's requests cost, from their token counts, each priced at the tier
 * its own prompt length falls in (src/core/cost/price.ts), with Anthropic's
 * cache writes above the input price: the figures a reviewer recomputes.
 */
import { costOf } from "../../src/core/cost/price";
import { catalogModel, modelsProviderOfKind } from "../../src/core/providers/catalog";
import type { RequestUsage } from "./record";

export interface Tokens {
  requests: number;
  /** Input not read from or written to the cache. */
  uncached: number;
  cacheReads: number;
  cacheWrites: number;
  output: number;
  dollars: number;
}

const none = (): Tokens => ({
  requests: 0,
  uncached: 0,
  cacheReads: 0,
  cacheWrites: 0,
  output: 0,
  dollars: 0,
});

/** The dollars one request cost; NaN for a model the catalog doesn't price. */
export function dollarsOf(request: RequestUsage): number {
  const [kind = "", ...rest] = request.model.split("/");
  const entry =
    kind === "anthropic" ? catalogModel(modelsProviderOfKind("anthropic"), rest.join("/")) : null;
  if (entry?.price?.currency !== "USD") return Number.NaN;
  return costOf(request, entry.price, new Date(request.at), { cacheWrites: true });
}

/** The requests' tokens and dollars, by model. */
export function tokensByModel(requests: readonly RequestUsage[]): Map<string, Tokens> {
  const totals = new Map<string, Tokens>();
  for (const request of requests) {
    const sum = totals.get(request.model) ?? none();
    const cached = Math.min(request.cachedInputTokens, request.inputTokens);
    const written = Math.min(request.cacheWriteTokens, request.inputTokens - cached);
    sum.requests++;
    sum.uncached += request.inputTokens - cached - written;
    sum.cacheReads += cached;
    sum.cacheWrites += written;
    sum.output += request.outputTokens;
    sum.dollars += dollarsOf(request);
    totals.set(request.model, sum);
  }
  return totals;
}

export const dollarsIn = (requests: readonly RequestUsage[]): number =>
  requests.reduce((sum, request) => sum + dollarsOf(request), 0);
