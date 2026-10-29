/**
 * Writes a set's dump (eval/README.md, "Offline scoring"): for each query of
 * each Question, keyword search's best 150 Passages with their keyword rank and
 * score, the built-in reranking model's score for the first 60 (the search
 * Tool reranks its first 20 with embeddings off; the rest is for scoring
 * deeper reranks), the text a reranker reads, and
 * a hit flag for each Passage the answer needs; and the Passages the search Tool
 * itself hands the model for that query. The format and the scoring are in
 * eval/score.ts.
 */
import type { Core, PassageSearchResult, SearchMode } from "../../src/core";
import { keywordQuery } from "../../src/core/documents/keywords";
import {
  DOCUMENT_NAME_WEIGHT,
  passagesInWindow,
  RRF_K,
  type WindowedPassage,
  windowedPassagesBySeq,
} from "../../src/core/documents/search";
import {
  ONE_SEARCH_PARAMETERS,
  type SearchCandidate,
  searchDocumentsTool,
} from "../../src/core/documents/searchTool";
import { rerankText } from "../../src/core/reranking";
import type { Database } from "../../src/core/storage";
import {
  DUMP_FORMAT,
  type Dump,
  type DumpCandidate,
  type DumpQuery,
  type DumpQuestion,
} from "../score";
import type { ExpectedPassage } from "./evaluationSet";
import type { Log } from "./log";
import type { ScoringReranker } from "./rerank";
import { checkPassage, isHit, KEYWORD_RERANK_DEPTH } from "./retrieval";

/** Keyword candidates kept for each query. */
export const DUMP_KEYWORD_DEPTH = 150;

/** Keyword candidates the built-in reranking model scores for each query, so deeper reranks can be scored offline. */
export const DUMP_RERANKED_DEPTH = 60;

const KEYWORD: SearchMode = "keyword";

/** A Question to dump: the Passages its answer needs, and the queries searched for it. */
export interface DumpInput {
  id: string;
  tags: Record<string, string>;
  expected: readonly ExpectedPassage[];
  /** The id of each expected Passage's Document, in the library. */
  expectedDocumentIds: readonly string[];
  /** The Question, then its translation if it has one. */
  queries: readonly string[];
}

export interface DumpOptions {
  set: string;
  groupBy: string;
  commit: string;
  core: Core;
  db: Database;
  reranker: ScoringReranker;
  rerankerInfo: { id: string; name: string };
  log: Log;
}

/** Keyword search's best `limit` for a query, as the Passages the search Tool sees, with their BM25 scores. */
export async function keywordCandidates(
  { core, db }: Pick<DumpOptions, "core" | "db">,
  query: string,
  limit: number,
): Promise<{ passages: WindowedPassage[]; scores: Map<number, number> }> {
  const found = await core.searchPassages(query, { mode: KEYWORD, limit });
  const ids = found.map((passage) => passage.passageId);
  const seqOf = new Map(
    db
      .all<{ id: string; seq: number }>(
        "SELECT id, seq FROM passages WHERE id IN (SELECT value FROM json_each(?))",
        [JSON.stringify(ids)],
      )
      .map((row) => [row.id, row.seq]),
  );
  const seqs = ids.flatMap((id) => seqOf.get(id) ?? []);
  const passages = windowedPassagesBySeq(db, seqs);
  const scores = new Map<number, number>();
  const match = keywordQuery(query);
  if (match && seqs.length > 0) {
    // bm25() is lower for a better match; the dump keeps it higher-is-better, like the other
    // scores. A Document's name match is added as keyword search adds it (#2042); a Passage
    // only its Document's name matched keeps the name's score alone.
    for (const row of db.all<{ seq: number; score: number }>(
      `WITH names AS MATERIALIZED (
         SELECT document_id, bm25(document_names_fts) AS name_score
         FROM document_names_fts WHERE document_names_fts MATCH ?),
       matches AS MATERIALIZED (
         SELECT rowid AS seq, bm25(passages_fts) AS passage_score
         FROM passages_fts
         WHERE passages_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?)))
       SELECT p.seq, coalesce(m.passage_score, 0) + ? * coalesce(n.name_score, 0) AS score
       FROM passages p
       LEFT JOIN matches m ON m.seq = p.seq
       LEFT JOIN names n ON n.document_id = p.document_id
       WHERE p.seq IN (SELECT value FROM json_each(?))`,
      [match, match, JSON.stringify(seqs), DOCUMENT_NAME_WEIGHT, JSON.stringify(seqs)],
    )) {
      scores.set(row.seq, -row.score);
    }
  }
  return { passages, scores };
}

/** The search Tool for a query as a one-search Answer runs it, with embeddings off, over the reranked candidates. */
export async function toolPassages(
  db: Database,
  query: string,
  candidates: readonly WindowedPassage[],
  scoreOf: ReadonlyMap<string, number>,
) {
  const reranked = candidates.slice(0, KEYWORD_RERANK_DEPTH);
  return searchDocumentsTool(
    {
      candidates: async () => [],
      rerankCandidates: async () =>
        reranked.map((passage, index) => ({ ...passage, score: 1 / (RRF_K + index + 1) })),
      window: (documentId, window) => passagesInWindow(db, documentId, window),
    },
    query,
    {
      parameters: ONE_SEARCH_PARAMETERS,
      rerank: async (_query, hits: readonly SearchCandidate[]) =>
        hits
          .map((hit, index) => ({
            hit: { ...hit, score: scoreOf.get(hit.passageId) ?? hit.score },
            index,
          }))
          .sort((a, b) => b.hit.score - a.hit.score || a.index - b.index)
          .map(({ hit }) => hit),
    },
  );
}

export async function dumpQuery(
  options: DumpOptions,
  input: DumpInput,
  query: string,
  translated: boolean,
): Promise<DumpQuery> {
  const hitsOf = (passage: PassageSearchResult) =>
    input.expected.map((expected, index) =>
      isHit(checkPassage(passage, expected, input.expectedDocumentIds[index] ?? "")),
    );
  const { passages, scores } = await keywordCandidates(options, query, DUMP_KEYWORD_DEPTH);
  const reranked = await options.reranker.rerankScored(
    query,
    passages.slice(0, DUMP_RERANKED_DEPTH),
  );
  const rerankScores = new Map(reranked.map((passage) => [passage.passageId, passage.score]));
  const candidates: DumpCandidate[] = passages.map((passage, index) => ({
    passageId: passage.passageId,
    documentId: passage.documentId,
    position: passage.position,
    rank: index + 1,
    keywordScore: scores.get(passage.seq) ?? null,
    rerankScore: rerankScores.get(passage.passageId) ?? null,
    hits: hitsOf(passage),
    rerankText: rerankText(passage),
  }));
  const handed = await toolPassages(options.db, query, passages, rerankScores);
  return {
    text: query,
    translated,
    candidates,
    tool: {
      passages: handed.map((passage) => ({
        passageId: passage.passageId,
        rank: passage.rank ?? 0,
        hits: hitsOf(passage),
      })),
    },
  };
}

/** Dumps a set's Questions, one query at a time. */
export async function buildDump(options: DumpOptions, inputs: readonly DumpInput[]): Promise<Dump> {
  const questions: DumpQuestion[] = [];
  for (const [index, input] of inputs.entries()) {
    const queries: DumpQuery[] = [];
    for (const [at, text] of input.queries.entries()) {
      queries.push(await dumpQuery(options, input, text, at > 0));
    }
    questions.push({ id: input.id, tags: input.tags, needed: input.expected.length, queries });
    if ((index + 1) % 25 === 0 || index + 1 === inputs.length) {
      options.log(`${options.set}: ${index + 1} of ${inputs.length} Questions dumped`);
    }
  }
  return {
    format: DUMP_FORMAT,
    set: options.set,
    createdAt: new Date().toISOString(),
    commit: options.commit,
    embeddings: "off",
    keywordDepth: DUMP_KEYWORD_DEPTH,
    rerankedDepth: DUMP_RERANKED_DEPTH,
    toolDepth: KEYWORD_RERANK_DEPTH,
    reranker: options.rerankerInfo,
    groupBy: options.groupBy,
    questions,
  };
}
