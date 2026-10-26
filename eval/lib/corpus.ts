/**
 * The library's Passages as the evaluation's own searches see them (see
 * ./searches): each with the words the keyword index holds for it, its text
 * and, on its Document's first Passage, its name (src/core/documents/keywords.ts),
 * and BM25 over them in memory, scored as FTS5 scores. FTS5 can't weigh one
 * query term more than another, or score a Document's Passages by that
 * Document's own term statistics, which keyword + feedback terms and document
 * first need. The app never searches with it.
 */
import type { PassageSearchResult } from "../../src/core";
import { keywordTerms, keywordText } from "../../src/core/documents/keywords";
import { detectLanguage } from "../../src/core/documents/textLanguage";

/** A live Passage, with the `seq` its keyword index row is stored under. */
export interface CorpusPassage extends PassageSearchResult {
  seq: number;
}

/**
 * A text's words as the keyword index's tokenizer sees them: segmented and
 * lowercased (`keywordText`), then split at anything but letters, digits and
 * marks, as FTS5's unicode61 tokenizer splits "gpt-3" into "gpt" and "3".
 */
export function tokensOf(text: string): string[] {
  return keywordText(text)
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token !== "");
}

/** A query's terms, each weighing 1, as keyword search looks for them (stopwords left out). */
export function queryWeights(query: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const term of keywordTerms(query)) {
    for (const token of tokensOf(term)) weights.set(token, 1);
  }
  return weights;
}

/** FTS5's `bm25()` parameters. */
const K1 = 1.2;
const B = 0.75;

export interface Scored {
  seq: number;
  score: number;
}

export interface Bm25 {
  /** How many Passages it holds. */
  size: number;
  /** A term's inverse document frequency, as FTS5 computes it; 0 for a term no Passage has. */
  idf(term: string): number;
  /** The best `limit` Passages for weighted terms, best first; ties in `seq` order. */
  search(terms: ReadonlyMap<string, number>, limit: number): Scored[];
  /** One Passage's score for weighted terms. */
  score(seq: number, terms: ReadonlyMap<string, number>): number;
}

/**
 * BM25 over Passages' words, as FTS5's `bm25()` computes it (k1 1.2, b 0.75;
 * an inverse document frequency at or below 0 counts as 1e-6), times each
 * query term's weight. The term statistics are those of the Passages given.
 */
export function bm25(passages: readonly { seq: number; tokens: readonly string[] }[]): Bm25 {
  const postings = new Map<string, Map<number, number>>();
  const lengths = new Map<number, number>();
  let total = 0;
  for (const { seq, tokens } of passages) {
    lengths.set(seq, tokens.length);
    total += tokens.length;
    for (const token of tokens) {
      let list = postings.get(token);
      if (!list) {
        list = new Map();
        postings.set(token, list);
      }
      list.set(seq, (list.get(seq) ?? 0) + 1);
    }
  }
  const size = passages.length;
  const averageLength = total / Math.max(1, size);
  const idf = (term: string) => {
    const found = postings.get(term)?.size ?? 0;
    if (found === 0) return 0;
    const value = Math.log((size - found + 0.5) / (found + 0.5));
    return value > 0 ? value : 1e-6;
  };
  const termScore = (term: string, seq: number, frequency: number) => {
    const length = lengths.get(seq) ?? 0;
    return (
      (idf(term) * (frequency * (K1 + 1))) /
      (frequency + K1 * (1 - B + (B * length) / averageLength))
    );
  };
  return {
    size,
    idf,
    search(terms, limit) {
      const scores = new Map<number, number>();
      for (const [term, weight] of terms) {
        for (const [seq, frequency] of postings.get(term) ?? []) {
          scores.set(seq, (scores.get(seq) ?? 0) + weight * termScore(term, seq, frequency));
        }
      }
      return [...scores]
        .map(([seq, score]) => ({ seq, score }))
        .sort((a, b) => b.score - a.score || a.seq - b.seq)
        .slice(0, limit);
    },
    score(seq, terms) {
      let score = 0;
      for (const [term, weight] of terms) {
        const frequency = postings.get(term)?.get(seq);
        if (frequency) score += weight * termScore(term, seq, frequency);
      }
      return score;
    },
  };
}

export interface Corpus {
  /** Every live Passage, by `seq`. */
  passages: ReadonlyMap<number, CorpusPassage>;
  /** A Passage by its id; undefined for one the corpus doesn't hold. */
  byId(passageId: string): CorpusPassage | undefined;
  /** A Passage's own words, without its Document's name. */
  textTokens(seq: number): readonly string[];
  /** BM25 over every Passage, with the library's term statistics, as keyword search ranks them. */
  index: Bm25;
  /** BM25 over one Document's Passages, with that Document's term statistics alone. */
  documentIndex(documentId: string): Bm25;
  /** The Documents, each once, in the order of their first Passage, with the language they are written in. */
  documents: { id: string; name: string; language: string | null }[];
}

/** Of a Document's Passages, how many and how much of each tell its language, as the core tells it. */
const LANGUAGE_SAMPLE = { passages: 4, characters: 1000 } as const;

export function createCorpus(passages: readonly CorpusPassage[]): Corpus {
  const bySeq = new Map(passages.map((passage) => [passage.seq, passage]));
  const byId = new Map(passages.map((passage) => [passage.passageId, passage]));
  const names = new Map<string, string[]>();
  const textTokens = new Map<number, string[]>();
  const indexed = passages.map((passage) => {
    let name = names.get(passage.documentId);
    if (!name) {
      name = tokensOf(passage.documentName);
      names.set(passage.documentId, name);
    }
    const own = tokensOf(passage.text);
    textTokens.set(passage.seq, own);
    return {
      seq: passage.seq,
      documentId: passage.documentId,
      tokens: [...(passage.position === 0 ? name : []), ...own],
    };
  });
  const documentIndexes = new Map<string, Bm25>();
  const documents = [...names.keys()].map((id) => {
    const own = passages
      .filter((passage) => passage.documentId === id)
      .sort((a, b) => a.position - b.position);
    const sample = own
      .slice(0, LANGUAGE_SAMPLE.passages)
      .map((passage) => passage.text.slice(0, LANGUAGE_SAMPLE.characters))
      .join("\n");
    return { id, name: own[0]?.documentName ?? id, language: detectLanguage(sample) };
  });
  return {
    passages: bySeq,
    byId: (passageId) => byId.get(passageId),
    textTokens: (seq) => textTokens.get(seq) ?? [],
    index: bm25(indexed),
    documentIndex(documentId) {
      let found = documentIndexes.get(documentId);
      if (!found) {
        found = bm25(indexed.filter((passage) => passage.documentId === documentId));
        documentIndexes.set(documentId, found);
      }
      return found;
    },
    documents,
  };
}
