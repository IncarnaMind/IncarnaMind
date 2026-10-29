/**
 * How long keyword search takes at the hard tier's size: FTS5 has no top-k
 * pruning, so every Passage that matches a query's words is scored before
 * the best are kept. Measurement only: each query (the Questions and their
 * translations) is run on the run's own data folder twice, in the app's own
 * search (`keywordSearch` in src/core/documents/search.ts): once as the app
 * runs it, its Document's name match looked up from an index of the names,
 * one row a Document (#2042), and once over the Passages alone, without the
 * name, so the extra lookup's cost is the difference. Both keep the app's
 * tie-breaks.
 */
import { keywordQuery } from "../../../src/core/documents/keywords";
import { keywordSearch } from "../../../src/core/documents/search";
import type { Database } from "../../../src/core/storage";

/** Times per query, in milliseconds. */
export interface QueryTiming {
  queries: number;
  mean: number;
  median: number;
  p95: number;
  max: number;
}

export interface KeywordTiming {
  /** Live Passages searched. */
  passages: number;
  /** How many Passages each query keeps: keyword + rerank's candidates. */
  limit: number;
  /** As the app runs keyword search: with its Document's name match added. */
  app: QueryTiming;
  /** The same over the Passages alone, without the name index: what the extra lookup costs. */
  alone: QueryTiming;
  /** Queries for which the name match changed which Passages were kept, or their order. */
  reordered: number;
}

/** The same, over the Passages alone: the app's keyword search before the name's own index. */
export const PASSAGES_SQL = `SELECT p.seq
       FROM passages_fts
       JOIN passages p ON p.seq = passages_fts.rowid
       JOIN documents d ON d.id = p.document_id
       WHERE passages_fts MATCH ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
       ORDER BY bm25(passages_fts), p.position, p.seq
       LIMIT ?`;

const quantile = (sorted: readonly number[], share: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? 0;

export function timingOf(milliseconds: readonly number[]): QueryTiming {
  const sorted = [...milliseconds].sort((a, b) => a - b);
  return {
    queries: sorted.length,
    mean: sorted.reduce((sum, ms) => sum + ms, 0) / Math.max(1, sorted.length),
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

/**
 * Runs every query once to warm the page cache, then times each in both
 * orders, alternating which goes first so neither always runs on a warmer
 * cache.
 */
export function timeKeywordSearch(
  db: Database,
  queries: readonly string[],
  limit: number,
): KeywordTiming {
  const searched = queries.flatMap((query) => {
    const match = keywordQuery(query);
    return match === null ? [] : [{ query, match }];
  });
  const app = (query: string) => {
    const started = performance.now();
    const seqs = keywordSearch(db, query, limit);
    return { ms: performance.now() - started, seqs };
  };
  const alone = (match: string) => {
    const started = performance.now();
    const seqs = db
      .all<{ seq: number }>(PASSAGES_SQL, [match, BigInt(limit)])
      .map((row) => row.seq);
    return { ms: performance.now() - started, seqs };
  };
  for (const { query } of searched) app(query);
  const appTimes: number[] = [];
  const aloneTimes: number[] = [];
  let reordered = 0;
  searched.forEach(({ query, match }, index) => {
    const [first, second] =
      index % 2 === 0
        ? [() => app(query), () => alone(match)]
        : [() => alone(match), () => app(query)];
    const a = first();
    const b = second();
    const [byApp, byPassages] = index % 2 === 0 ? [a, b] : [b, a];
    appTimes.push(byApp.ms);
    aloneTimes.push(byPassages.ms);
    if (byApp.seqs.join() !== byPassages.seqs.join()) reordered++;
  });
  return {
    passages:
      db.get<{ count: number }>("SELECT COUNT(*) AS count FROM passages WHERE deleted_at IS NULL")
        ?.count ?? 0,
    limit,
    app: timingOf(appTimes),
    alone: timingOf(aloneTimes),
    reordered,
  };
}
