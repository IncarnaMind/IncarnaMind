/**
 * How long keyword search takes at the hard tier's size: FTS5 has no top-k
 * pruning, so every Passage that matches a query's words is scored before
 * the best are kept. Measurement only: each query (the Questions and their
 * translations) is run on the run's own data folder twice, in the app's SQL
 * (`keywordSearch` in src/core/documents/search.ts): once as the app runs it,
 * a Passage's own words and its Document's name match added from the name's
 * index (#2042), and once over the Passages alone, without the name, so the
 * extra lookup's cost is the difference. Both keep the app's tie-breaks.
 */
import { keywordQuery } from "../../../src/core/documents/keywords";
import { DOCUMENT_NAME_WEIGHT } from "../../../src/core/documents/search";
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

/** The app's keyword search, over the whole library, and the same without the name's index. */
const withName = `WITH names AS MATERIALIZED (
         SELECT document_id, bm25(document_names_fts) AS name_score
         FROM document_names_fts WHERE document_names_fts MATCH ?)
       SELECT seq FROM (
         SELECT p.seq AS seq, p.position AS position,
           bm25(passages_fts) + ? * coalesce(n.name_score, 0) AS score
         FROM passages_fts
         JOIN passages p ON p.seq = passages_fts.rowid
         JOIN documents d ON d.id = p.document_id
         LEFT JOIN names n ON n.document_id = p.document_id
         WHERE passages_fts MATCH ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
         UNION ALL
         SELECT p.seq, p.position, ? * n.name_score
         FROM names n
         JOIN passages p ON p.document_id = n.document_id
         JOIN documents d ON d.id = p.document_id
         WHERE p.deleted_at IS NULL AND d.deleted_at IS NULL
       )
       GROUP BY seq
       ORDER BY min(score), min(position), seq
       LIMIT ?`;

const passagesOnly = `SELECT p.seq
       FROM passages_fts
       JOIN passages p ON p.seq = passages_fts.rowid
       JOIN documents d ON d.id = p.document_id
       WHERE passages_fts MATCH ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
       ORDER BY bm25(passages_fts), p.position, p.seq
       LIMIT ?`;

/** The app's keyword search (`keywordSearch`), over the whole library. */
export const BM25_SQL = withName;

/** The same, over the Passages alone: the app's keyword search before the name's own index. */
export const PASSAGES_SQL = passagesOnly;

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
  const matches = queries
    .map((query) => keywordQuery(query))
    .filter((match): match is string => match !== null);
  const run = (sql: string, match: string) => {
    const started = performance.now();
    const params =
      sql === BM25_SQL
        ? [match, DOCUMENT_NAME_WEIGHT, match, DOCUMENT_NAME_WEIGHT, BigInt(limit)]
        : [match, BigInt(limit)];
    const seqs = db.all<{ seq: number }>(sql, params).map((row) => row.seq);
    return { ms: performance.now() - started, seqs };
  };
  for (const match of matches) run(BM25_SQL, match);
  const app: number[] = [];
  const alone: number[] = [];
  let reordered = 0;
  matches.forEach((match, index) => {
    const [first, second] = index % 2 === 0 ? [BM25_SQL, PASSAGES_SQL] : [PASSAGES_SQL, BM25_SQL];
    const a = run(first, match);
    const b = run(second, match);
    const [byApp, byPassages] = first === BM25_SQL ? [a, b] : [b, a];
    app.push(byApp.ms);
    alone.push(byPassages.ms);
    if (byApp.seqs.join() !== byPassages.seqs.join()) reordered++;
  });
  return {
    passages:
      db.get<{ count: number }>("SELECT COUNT(*) AS count FROM passages WHERE deleted_at IS NULL")
        ?.count ?? 0,
    limit,
    app: timingOf(app),
    alone: timingOf(alone),
    reordered,
  };
}
