/**
 * Small-to-big's index: each Document cut again into small sub-chunks of at
 * most 128 approximate tokens, with no overlap (the old command-line app
 * searched ~100-token chunks first), each mapped to the Passages that hold
 * it. The sub-chunks go into an FTS5 table built like the app's keyword index
 * (the words, segmented the same way, the same tokenizer), in a database of
 * the evaluation's own in memory: the app's schema doesn't change. A search
 * ranks sub-chunks with BM25 and scores each Passage by its best sub-chunk.
 */
import { keywordQuery, keywordText } from "../../src/core/documents/keywords";
import { approximateTokens, buildPassages, type PageText } from "../../src/core/documents/passages";
import { type Database, openDatabase } from "../../src/core/storage";
import type { Corpus, CorpusPassage } from "./corpus";

/** The most approximate tokens a sub-chunk holds (see `approximateTokens` in src/core/documents/passages.ts). */
export const SUB_CHUNK_TOKENS = 128;

/** How many of the best sub-chunks a search scores Passages by. */
export const SUB_CHUNK_DEPTH = 200;

/**
 * How a Passage's sub-chunks make its score: its best one's (the mode's), or
 * the sum of those among the best `SUB_CHUNK_DEPTH`, which favours Passages
 * that match in several places.
 */
export type Aggregation = "best" | "sum";

export const AGGREGATIONS: readonly Aggregation[] = ["best", "sum"];

/** A sub-chunk: where it is in its Document's laid-out text, and the Passages that hold it. */
export interface SubChunk {
  text: string;
  start: number;
  end: number;
  /** `seq`s of the Passages that hold all of it, or, if none does, of those it overlaps. */
  passages: number[];
}

/**
 * Lays out a Document's pages as Passages are built from them: each page
 * trimmed, empty ones left out, joined by a blank line.
 */
export const layOut = (pages: readonly { text: string }[]) =>
  pages
    .map((page) => page.text.trim())
    .filter((text) => text !== "")
    .join("\n\n");

/**
 * Where each text is in `text`, in order: each is looked for after the start
 * of the one before (`overlapping`, as Passages overlap) or after its end.
 * Null for one that isn't found.
 */
function locate(
  text: string,
  parts: readonly string[],
  overlapping: boolean,
): ({ start: number; end: number } | null)[] {
  let cursor = 0;
  return parts.map((part) => {
    let start = text.indexOf(part, cursor);
    if (start < 0) start = text.indexOf(part);
    if (start < 0) return null;
    cursor = overlapping ? start + 1 : start + part.length;
    return { start, end: start + part.length };
  });
}

/**
 * A Document's sub-chunks: its pages cut into pieces of at most
 * `SUB_CHUNK_TOKENS`, whole lines where they fit, as Passages are cut (see
 * `buildPassages`), each mapped to the Passages (in reading order) that hold it.
 */
export function subChunksOf(
  pages: readonly PageText[],
  passages: readonly Pick<CorpusPassage, "seq" | "text">[],
): { chunks: SubChunk[]; unplaced: number } {
  const text = layOut(pages);
  const spans = locate(
    text,
    passages.map((passage) => passage.text),
    true,
  ).map((span, index) => (span ? { ...span, seq: (passages[index] as CorpusPassage).seq } : null));
  const placed = spans.filter((span) => span !== null);
  const pieces = buildPassages(pages, {
    maxTokens: SUB_CHUNK_TOKENS,
    overlapTokens: 0,
    windowSize: 1,
    windowStep: 1,
  }).map((piece) => piece.text);
  const chunks: SubChunk[] = [];
  let unplaced = 0;
  locate(text, pieces, false).forEach((span, index) => {
    if (!span) {
      unplaced++;
      return;
    }
    const holding = placed.filter((each) => each.start <= span.start && span.end <= each.end);
    const touching = holding.length
      ? holding
      : placed.filter((each) => each.start < span.end && span.start < each.end);
    if (touching.length === 0) {
      unplaced++;
      return;
    }
    chunks.push({
      text: pieces[index] as string,
      ...span,
      passages: touching.map((each) => each.seq),
    });
  });
  return { chunks, unplaced };
}

export interface SubChunkStats {
  maxTokens: number;
  subChunks: number;
  /** Their mean size, in approximate tokens. */
  meanTokens: number;
  /** Sub-chunks no Passage could be found for; left out. */
  unplaced: number;
  /** The index's size: the FTS5 table and the sub-chunk to Passage table, in bytes. */
  indexBytes: number;
  /** The Passages' own keyword index, built the same way in memory, for comparison. */
  passageIndexBytes: number;
  /** Cutting, segmenting and indexing. */
  buildSeconds: number;
}

export interface SubChunkIndex {
  /** The best `limit` Passages for a query, best first, by `aggregation` of their sub-chunks' scores. */
  search(query: string, limit: number, aggregation?: Aggregation): CorpusPassage[];
  stats: SubChunkStats;
  close(): void;
}

const FTS_TABLE = `CREATE VIRTUAL TABLE chunks_fts USING fts5 (
  text,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
)`;

/** A database's size in bytes: its pages, in memory as on disk. */
const sizeOf = (db: Database) =>
  db.get<{ bytes: number }>(
    "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()",
  )?.bytes ?? 0;

/** Builds the sub-chunk index of every Document in the corpus, from their stored pages. */
export function buildSubChunkIndex(
  corpus: Corpus,
  pagesOf: (documentId: string) => readonly PageText[],
): SubChunkIndex {
  const started = performance.now();
  const db = openDatabase(":memory:");
  db.exec(FTS_TABLE);
  db.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY, passages TEXT NOT NULL) STRICT");
  const owners = new Map<number, number[]>();
  let subChunks = 0;
  let tokens = 0;
  let unplaced = 0;
  db.transaction(() => {
    for (const document of corpus.documents) {
      const passages = [...corpus.passages.values()]
        .filter((passage) => passage.documentId === document.id)
        .sort((a, b) => a.position - b.position);
      const found = subChunksOf(pagesOf(document.id), passages);
      unplaced += found.unplaced;
      for (const chunk of found.chunks) {
        subChunks++;
        tokens += approximateTokens(chunk.text);
        db.run("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)", [
          BigInt(subChunks),
          keywordText(chunk.text),
        ]);
        db.run("INSERT INTO chunks (id, passages) VALUES (?, ?)", [
          BigInt(subChunks),
          JSON.stringify(chunk.passages),
        ]);
        owners.set(subChunks, chunk.passages);
      }
    }
  });
  const buildSeconds = (performance.now() - started) / 1000;

  // The Passages' own index, built the same way, for comparison.
  const passageDb = openDatabase(":memory:");
  passageDb.exec(FTS_TABLE);
  passageDb.transaction(() => {
    for (const passage of corpus.passages.values()) {
      passageDb.run("INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)", [
        BigInt(passage.seq),
        keywordText(passage.text),
      ]);
    }
  });
  const passageIndexBytes = sizeOf(passageDb);
  passageDb.close();

  return {
    search(query, limit, aggregation = "best") {
      const match = keywordQuery(query);
      if (!match) return [];
      const rows = db.all<{ id: number; score: number }>(
        "SELECT rowid AS id, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score, rowid LIMIT ?",
        [match, BigInt(SUB_CHUNK_DEPTH)],
      );
      // bm25() is lower for a better match.
      const scores = new Map<number, number>();
      for (const { id, score } of rows) {
        for (const seq of owners.get(id) ?? []) {
          const known = scores.get(seq);
          if (aggregation === "best") {
            if (known === undefined) scores.set(seq, -score);
          } else scores.set(seq, (known ?? 0) - score);
        }
      }
      return [...scores]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .flatMap(([seq]) => {
          const passage = corpus.passages.get(seq);
          return passage ? [passage] : [];
        });
    },
    stats: {
      maxTokens: SUB_CHUNK_TOKENS,
      subChunks,
      meanTokens: tokens / Math.max(1, subChunks),
      unplaced,
      indexBytes: sizeOf(db),
      passageIndexBytes,
      buildSeconds,
    },
    close: () => db.close(),
  };
}
