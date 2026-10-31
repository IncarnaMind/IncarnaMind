/**
 * Searching Passages (ADR-0009). Keyword search runs FTS5 over each Passage's
 * segmented words (see ./keywords), with its Document's name match added from
 * an index of the names, one row a Document (#2042); vector search scans the
 * in-memory vectors (see ./vectors); hybrid search fuses the two by reciprocal
 * rank fusion, counting a Passage with no vector by its keyword rank for both.
 * While embeddings are off (the default), hybrid search is keyword search. The
 * search Tool (#30) and Search scopes (#36) build on these.
 */
import type { DocumentKind, DocumentTextMatch, PassageSearchResult } from "../api";
import type { Database } from "../storage";
import { excerptOf, searchTerms, termQuery } from "../wordSearch";
import { keywordQuery } from "./keywords";

/** Reciprocal rank fusion's k: a Passage at rank r (from 1) in a list scores 1 / (k + r). */
export const RRF_K = 60;

/** How many results each list hands to a hybrid search. */
export const HYBRID_CANDIDATES = 50;

/** SQL that limits a query to some Documents, if `documentIds` is given. */
const scopeClause = (documentIds: readonly string[] | undefined) =>
  documentIds ? "AND p.document_id IN (SELECT value FROM json_each(?))" : "";

const scopeParams = (documentIds: readonly string[] | undefined) =>
  documentIds ? [JSON.stringify(documentIds)] : [];

/**
 * What a Document's name match adds to each of its Passages' keyword scores:
 * one weight, on the name's own BM25, whose document frequency counts
 * Documents (#2042). Tuned on the retrieval evaluation's gating set and the
 * hard tier together: high enough that a query naming a Document still finds
 * its Passages, low enough that a generic name word (report, annual) doesn't
 * lift that Document's Passages above the ones that say what was asked.
 */
export const DOCUMENT_NAME_WEIGHT = 1;

/**
 * The `seq`s of the live Passages that best match the query's words, best
 * first: those whose own words match, each scored by them and by its
 * Document's name, then those of a Document whose name matches, which their
 * Document's name alone finds. The name is scored apart, from its own index,
 * where a word of it counts its Document once: in every Passage's row a word
 * of a long Document's name counted once a Passage, and its document
 * frequency grew with the Document's length (#2042).
 */
export function keywordSearch(
  db: Database,
  query: string,
  limit: number,
  documentIds?: readonly string[],
): number[] {
  const match = keywordQuery(query);
  if (!match) return [];
  // One query over the names, which holds one row a Document, then a lookup a Passage:
  // joining the index once a Passage made every search pay for the name's statistics
  // once a Passage, which is the cost this design removes (#2042).
  const nameScores = new Map(
    db
      .all<{ documentId: string; score: number }>(
        `SELECT document_id AS documentId, bm25(document_names_fts) AS score
         FROM document_names_fts WHERE document_names_fts MATCH ?`,
        [match],
      )
      .map((row) => [row.documentId, row.score]),
  );
  const nameScore = (documentId: string) =>
    DOCUMENT_NAME_WEIGHT * (nameScores.get(documentId) ?? 0);
  // A Passage's best score: the fewer, the better, as bm25() gives it.
  const best = new Map<number, { position: number; score: number }>();
  const add = (seq: number, position: number, score: number) => {
    const known = best.get(seq);
    if (!known || score < known.score) best.set(seq, { position, score });
  };
  for (const row of db.all<{ seq: number; documentId: string; position: number; score: number }>(
    `SELECT p.seq, p.document_id AS documentId, p.position, bm25(passages_fts) AS score
     FROM passages_fts
     JOIN passages p ON p.seq = passages_fts.rowid
     JOIN documents d ON d.id = p.document_id
     WHERE passages_fts MATCH ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
       ${scopeClause(documentIds)}`,
    [match, ...scopeParams(documentIds)],
  )) {
    add(row.seq, row.position, row.score + nameScore(row.documentId));
  }
  if (nameScores.size > 0) {
    for (const row of db.all<{ seq: number; documentId: string; position: number }>(
      `SELECT p.seq, p.document_id AS documentId, p.position
       FROM passages p JOIN documents d ON d.id = p.document_id
       WHERE p.document_id IN (SELECT value FROM json_each(?))
         AND p.deleted_at IS NULL AND d.deleted_at IS NULL
         ${scopeClause(documentIds)}`,
      [JSON.stringify([...nameScores.keys()]), ...scopeParams(documentIds)],
    )) {
      add(row.seq, row.position, nameScore(row.documentId));
    }
  }
  return [...best.entries()]
    .sort((a, b) => a[1].score - b[1].score || a[1].position - b[1].position || a[0] - b[0])
    .slice(0, limit)
    .map(([seq]) => seq);
}

/** How many of a Document's best Passages a text search looks at for one that holds the words. */
const PASSAGES_PER_DOCUMENT = 3;

/**
 * The live Documents, not missing, whose Passages hold every word of the
 * query, the last letters of each still to type, best first, each with its
 * best Passage that holds one of them in its text: a word only in a
 * Document's name, which has an index of its own, doesn't count. See
 * `CoreApi.searchDocumentText`.
 */
export function textSearch(
  db: Database,
  query: string,
  limit: number,
  excludeIds: readonly string[] = [],
): DocumentTextMatch[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  // Left out before the limit is applied, so they never take one of its places.
  const excluded = excludeIds.length > 0 ? "AND d.id NOT IN (SELECT value FROM json_each(?))" : "";
  const ranked = db.all<{
    passage_id: string;
    document_id: string;
    page_from: number | null;
    page_to: number | null;
    text: string;
  }>(
    // MATERIALIZED: bm25() can only be worked out before the rows are grouped. The best
    // Documents come first, then a few of each one's best Passages, so a long Document never
    // crowds out the others; twice as many Documents as asked for, as a few may match by name only.
    `WITH scored AS MATERIALIZED (
       SELECT p.seq, p.document_id, p.position, bm25(passages_fts) AS score
       FROM passages_fts
       JOIN passages p ON p.seq = passages_fts.rowid
       JOIN documents d ON d.id = p.document_id
       WHERE passages_fts MATCH ? AND p.deleted_at IS NULL
         AND d.deleted_at IS NULL AND d.file_status <> 'missing' ${excluded}),
     top AS (
       SELECT document_id, min(score) AS best FROM scored
       GROUP BY document_id ORDER BY best LIMIT ?),
     placed AS (
       SELECT s.seq, s.document_id, top.best, row_number() OVER (
         PARTITION BY s.document_id ORDER BY s.score, s.position, s.seq) AS place
       FROM scored s JOIN top ON top.document_id = s.document_id)
     SELECT p.id AS passage_id, p.document_id, p.page_from, p.page_to, p.text
     FROM placed JOIN passages p ON p.seq = placed.seq
     WHERE placed.place <= ?
     ORDER BY placed.best, placed.document_id, placed.place`,
    [
      terms.map(termQuery).join(" AND "),
      ...(excludeIds.length > 0 ? [JSON.stringify(excludeIds)] : []),
      BigInt(limit * 2),
      BigInt(PASSAGES_PER_DOCUMENT),
    ],
  );
  const matches: DocumentTextMatch[] = [];
  const seen = new Set<string>();
  for (const row of ranked) {
    if (seen.has(row.document_id)) continue;
    const { excerpt, highlights } = excerptOf(row.text, terms);
    if (highlights.length === 0) continue;
    seen.add(row.document_id);
    matches.push({
      documentId: row.document_id,
      passageId: row.passage_id,
      pageFrom: row.page_from,
      pageTo: row.page_to,
      excerpt,
      highlights,
    });
    if (matches.length === limit) break;
  }
  return matches;
}

/**
 * The same file at two paths is two Documents with the same Passages (ADR-0010).
 * Search shows each Passage once: every `seq` in the rankings is replaced by
 * that of one copy, and each ranking keeps a Passage's first place. The copy
 * kept is in a Document whose file can be opened, if one is, else the
 * earliest added. Search is limited to the Search scope beforehand, so the
 * copy kept is always one inside it.
 */
export function distinctPassages(
  db: Database,
  rankings: readonly (readonly number[])[],
): number[][] {
  const seqs = [...new Set(rankings.flat())];
  if (seqs.length < 2) return rankings.map((ranking) => [...ranking]);
  const rows = db.all<{ seq: number; key: string }>(
    `SELECT p.seq,
       coalesce(p.content_hash, 'seq:' || p.seq) || ':' || p.position || ':' || length(p.text) AS key
     FROM passages p JOIN documents d ON d.id = p.document_id
     WHERE p.seq IN (SELECT value FROM json_each(?))
     ORDER BY d.file_status <> 'available', d.created_at, d.rowid`,
    [JSON.stringify(seqs)],
  );
  const kept = new Map<string, number>();
  const keyOf = new Map<number, string>();
  for (const row of rows) {
    keyOf.set(row.seq, row.key);
    if (!kept.has(row.key)) kept.set(row.key, row.seq);
  }
  return rankings.map((ranking) => {
    const seen = new Set<number>();
    const distinct: number[] = [];
    for (const seq of ranking) {
      const key = keyOf.get(seq);
      const canonical = key === undefined ? seq : (kept.get(key) ?? seq);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      distinct.push(canonical);
    }
    return distinct;
  });
}

/** A Passage's `seq` and its fused score: higher is better. */
export interface ScoredSeq {
  seq: number;
  score: number;
}

/**
 * Of these Passages, those with no vector from the current embedding model
 * (`modelId`), such as a Document's not yet embedded after embeddings were
 * turned on: only keyword search can rank them.
 */
export function keywordOnlyPassages(
  db: Database,
  seqs: readonly number[],
  modelId: string,
): Set<number> {
  if (seqs.length === 0) return new Set();
  const rows = db.all<{ seq: number }>(
    `SELECT p.seq FROM passages p JOIN documents d ON d.id = p.document_id
     WHERE p.seq IN (SELECT value FROM json_each(?))
       AND (p.embedding IS NULL OR d.embedding_model IS NOT ?)`,
    [JSON.stringify(seqs), modelId],
  );
  return new Set(rows.map((row) => row.seq));
}

/**
 * Fuses ranked lists of `seq`s by reciprocal rank fusion: the best `limit`,
 * best first, with their fused scores.
 *
 * `keywordOnly` are Passages that only the first list, keyword search's, can
 * hold (see `keywordOnlyPassages`): their rank there counts once for each
 * list that isn't empty, as if vector search had ranked them as keyword
 * search did, so having no vector yet neither drops them nor ranks them below
 * Passages both lists hold. While vector search returns nothing (embeddings
 * are off, or the query couldn't be embedded), nothing changes.
 */
export function fuseRankingScores(
  rankings: readonly (readonly number[])[],
  limit: number,
  keywordOnly: ReadonlySet<number> = new Set(),
): ScoredSeq[] {
  const scores = new Map<number, number>();
  const lists = rankings.filter((ranking) => ranking.length > 0).length;
  rankings.forEach((ranking, list) => {
    ranking.forEach((seq, index) => {
      const counted = list === 0 && keywordOnly.has(seq) ? lists : 1;
      scores.set(seq, (scores.get(seq) ?? 0) + counted / (RRF_K + index + 1));
    });
  });
  // Ties keep the order of first appearance: the keyword list's order comes first.
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([seq, score]) => ({ seq, score }));
}

/** Fuses ranked lists of `seq`s by reciprocal rank fusion: the best `limit`, best first. */
export function fuseRankings(
  rankings: readonly (readonly number[])[],
  limit: number,
  keywordOnly?: ReadonlySet<number>,
): number[] {
  return fuseRankingScores(rankings, limit, keywordOnly).map((hit) => hit.seq);
}

interface ResultRow {
  seq: number;
  passage_id: string;
  document_id: string;
  document_name: string;
  page_from: number | null;
  page_to: number | null;
  position: number;
  text: string;
}

/** The live Passages with these `seq`s, in the order given. */
export function passagesBySeq(db: Database, seqs: readonly number[]): PassageSearchResult[] {
  if (seqs.length === 0) return [];
  const rows = db.all<ResultRow>(
    `SELECT p.seq, p.id AS passage_id, p.document_id, d.name AS document_name,
       p.page_from, p.page_to, p.position, p.text
     FROM passages p JOIN documents d ON d.id = p.document_id
     WHERE p.seq IN (SELECT value FROM json_each(?))
       AND p.deleted_at IS NULL AND d.deleted_at IS NULL`,
    [JSON.stringify(seqs)],
  );
  const bySeq = new Map(rows.map((row) => [row.seq, row]));
  return seqs.flatMap((seq) => {
    const row = bySeq.get(seq);
    return row
      ? [
          {
            passageId: row.passage_id,
            documentId: row.document_id,
            documentName: row.document_name,
            pageFrom: row.page_from,
            pageTo: row.page_to,
            position: row.position,
            text: row.text,
          },
        ]
      : [];
  });
}

/** A live Passage as the document-search Tool sees it: with its sliding window and its Document. */
export interface WindowedPassage extends PassageSearchResult {
  seq: number;
  documentKind: DocumentKind;
  /** The version of the Document the Passage was built from. */
  contentHash: string;
  /** Positions of the first and last Passage in this Passage's sliding window. */
  windowFrom: number;
  windowTo: number;
  /**
   * How relevant the search Tool found it among the Passages it returned: 0
   * the most. Set by the search Tool only (see ./searchTool), which returns
   * Passages in reading order: a window too small for all of them keeps the
   * most relevant (see ../answers/window).
   */
  rank?: number;
  /**
   * How relevant the reranker found it, when search reranked and it was one
   * of the hits: the reranker's score, from 0 to 1 (the built-in model's,
   * Cohere's and Voyage's), higher is better. None when search kept its own
   * order: reranking off, the built-in model not downloaded yet, or a
   * reranking service that couldn't be used. Set by the search Tool only.
   */
  relevance?: number;
}

interface WindowedRow extends ResultRow {
  document_kind: string;
  content_hash: string | null;
  window_from: number;
  window_to: number;
}

const WINDOWED_COLUMNS = `p.seq, p.id AS passage_id, p.document_id, d.name AS document_name,
  d.kind AS document_kind, coalesce(p.content_hash, d.content_hash) AS content_hash,
  p.page_from, p.page_to, p.position, p.window_from, p.window_to, p.text`;

const toWindowed = (row: WindowedRow): WindowedPassage => ({
  seq: row.seq,
  passageId: row.passage_id,
  documentId: row.document_id,
  documentName: row.document_name,
  documentKind: row.document_kind as DocumentKind,
  contentHash: row.content_hash ?? "",
  pageFrom: row.page_from,
  pageTo: row.page_to,
  position: row.position,
  windowFrom: row.window_from,
  windowTo: row.window_to,
  text: row.text,
});

/** The live Passages with these `seq`s, in the order given, with their windows. */
export function windowedPassagesBySeq(db: Database, seqs: readonly number[]): WindowedPassage[] {
  if (seqs.length === 0) return [];
  const rows = db.all<WindowedRow>(
    `SELECT ${WINDOWED_COLUMNS}
     FROM passages p JOIN documents d ON d.id = p.document_id
     WHERE p.seq IN (SELECT value FROM json_each(?))
       AND p.deleted_at IS NULL AND d.deleted_at IS NULL`,
    [JSON.stringify(seqs)],
  );
  const bySeq = new Map(rows.map((row) => [row.seq, row]));
  return seqs.flatMap((seq) => {
    const row = bySeq.get(seq);
    return row ? [toWindowed(row)] : [];
  });
}

/** A live Passage of a live Document, with its window; null for any other. */
export function livePassage(db: Database, passageId: string): WindowedPassage | null {
  const row = db.get<WindowedRow>(
    `SELECT ${WINDOWED_COLUMNS}
     FROM passages p JOIN documents d ON d.id = p.document_id
     WHERE p.id = ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL`,
    [passageId],
  );
  return row ? toWindowed(row) : null;
}

/** The live Passages of a live Document at positions `from` to `to`, in reading order. */
export function passagesBetween(
  db: Database,
  documentId: string,
  from: number,
  to: number,
): WindowedPassage[] {
  return db
    .all<WindowedRow>(
      `SELECT ${WINDOWED_COLUMNS}
       FROM passages p JOIN documents d ON d.id = p.document_id
       WHERE p.document_id = ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
         AND p.position BETWEEN ? AND ?
       ORDER BY p.position`,
      [documentId, BigInt(from), BigInt(to)],
    )
    .map(toWindowed);
}

/** Live Passages covering or, when `overlapping`, intersecting pages `from` to `to`, in reading order. */
export function passagesCovering(
  db: Database,
  documentId: string,
  from: number | null,
  to: number | null,
  overlapping = false,
): (WindowedPassage & { id: string })[] {
  const range = from === null || to === null ? "" : "AND p.page_from <= ? AND p.page_to >= ?";
  const params =
    from === null || to === null
      ? []
      : overlapping
        ? [BigInt(to), BigInt(from)]
        : [BigInt(from), BigInt(to)];
  return db
    .all<WindowedRow>(
      `SELECT ${WINDOWED_COLUMNS}
       FROM passages p JOIN documents d ON d.id = p.document_id
       WHERE p.document_id = ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
         AND p.content_hash = d.content_hash ${range}
       ORDER BY p.position`,
      [documentId, ...params],
    )
    .map((row) => {
      const passage = toWindowed(row);
      return { ...passage, id: passage.passageId };
    });
}

/**
 * The live Passages of one sliding window of a Document, in reading order:
 * those whose own window range takes in `window`. With windows of 3 and step 1,
 * window w holds the Passages at positions w, w + 1 and w + 2.
 */
export function passagesInWindow(
  db: Database,
  documentId: string,
  window: number,
): WindowedPassage[] {
  return db
    .all<WindowedRow>(
      `SELECT ${WINDOWED_COLUMNS}
       FROM passages p JOIN documents d ON d.id = p.document_id
       WHERE p.document_id = ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL
         AND p.window_from <= ? AND p.window_to >= ?
       ORDER BY p.position`,
      [documentId, BigInt(window), BigInt(window)],
    )
    .map(toWindowed);
}
