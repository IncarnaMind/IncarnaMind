import type { CitationAttributes } from "../core/api";
import { isStopword, keywordText } from "../core/documents/keywords";
import { normaliseText } from "./text";

export type CitedPlace = Pick<
  CitationAttributes,
  "documentId" | "contentHash" | "pageFrom" | "pageTo" | "quote"
>;

const FIGURE = /\p{Nd}+(?:[.,]\p{Nd}+)*|[〇零一二三四五六七八九十百千万亿两]+/gu;

function wordsOf(quote: string): string[] {
  // The keyword index's words, so Chinese splits as it does there and punctuation, width and
  // traditional characters never tell two quotes apart.
  const words = keywordText(quote).split(" ").filter(Boolean);
  const content = words.filter((word) => !isStopword(word));
  return content.length > 0 ? content : words;
}

function figuresOf(quote: string): Set<string> {
  return new Set(normaliseText(quote).match(FIGURE));
}

function sharedInOrder(short: readonly string[], long: readonly string[]): number {
  let row = new Array<number>(long.length + 1).fill(0);
  for (const word of short) {
    const next = [0];
    for (let at = 1; at <= long.length; at++) {
      next[at] =
        word === long[at - 1] ? (row[at - 1] ?? 0) + 1 : Math.max(row[at] ?? 0, next[at - 1] ?? 0);
    }
    row = next;
  }
  return row[long.length] ?? 0;
}

/** The words of `long` that `short` leaves over, matching as many of its own in order as it can. */
function wordsBeyond(short: readonly string[], long: readonly string[]): string[] {
  const rows: number[][] = [new Array<number>(long.length + 1).fill(0)];
  for (let at = 1; at <= short.length; at++) {
    const above = rows[at - 1] ?? [];
    const row = [0];
    for (let to = 1; to <= long.length; to++) {
      row[to] =
        short[at - 1] === long[to - 1]
          ? (above[to - 1] ?? 0) + 1
          : Math.max(above[to] ?? 0, row[to - 1] ?? 0);
    }
    rows.push(row);
  }
  const beyond: string[] = [];
  let at = short.length;
  let to = long.length;
  while (to > 0) {
    if (at > 0 && short[at - 1] === long[to - 1]) {
      at -= 1;
      to -= 1;
      continue;
    }
    if (at === 0 || (rows[at]?.[to - 1] ?? 0) >= (rows[at - 1]?.[to] ?? 0)) {
      const word = long[to - 1];
      if (word !== undefined) beyond.push(word);
      to -= 1;
    } else {
      at -= 1;
    }
  }
  return beyond.reverse();
}

// Pages are Unit numbers of one version of the file, so they say nothing across versions or
// where one side has none: then the words decide.
function samePlace(a: CitedPlace, b: CitedPlace): boolean {
  if (a.pageFrom === null || b.pageFrom === null) return true;
  if (!a.contentHash || a.contentHash !== b.contentHash) return true;
  return a.pageFrom <= (b.pageTo ?? b.pageFrom) && b.pageFrom <= (a.pageTo ?? a.pageFrom);
}

/**
 * Whether a Citation and the Passage a check found are the same words in the
 * same place of the same Document: their pages meet where both are known, and
 * every figure of the shorter quote is in the longer, with at least 80% of its
 * content words in order, so one quote inside the other, or a different span of
 * the same clause. It compares place and words, never meaning. Where it can't
 * tell, the Citation counts as already cited.
 */
export function overlapsCitation(cited: CitedPlace, found: CitedPlace): boolean {
  if (!cited.documentId || cited.documentId !== found.documentId) return false;
  if (!samePlace(cited, found)) return false;
  const a = { quote: cited.quote ?? "", words: wordsOf(cited.quote ?? "") };
  const b = { quote: found.quote ?? "", words: wordsOf(found.quote ?? "") };
  if (a.words.length === 0 || b.words.length === 0) return true;
  const [short, long] = a.words.length <= b.words.length ? [a, b] : [b, a];
  // Clauses of a contract or an accounts note share most of their words: a figure or a date is
  // what tells them apart, so figures must match exactly and the rest almost fully.
  const longFigures = figuresOf(long.quote);
  for (const figure of figuresOf(short.quote)) {
    if (!longFigures.has(figure)) return false;
  }
  return sharedInOrder(short.words, long.words) * 5 >= short.words.length * 4;
}

/**
 * Whether the Passage a check found says more than the Citation's quote on the
 * same words, and the sentence says that more too: the Citation covers part of
 * the clause and the whole of it can take its place (#1620). Where the
 * sentence leaves a word out, the extra words don't matter, and the Citation
 * already stands.
 */
export function continuesCitation(cited: CitedPlace, found: CitedPlace, sentence: string): boolean {
  if (!overlapsCitation(cited, found)) return false;
  const citedWords = wordsOf(cited.quote ?? "");
  const foundWords = wordsOf(found.quote ?? "");
  if (citedWords.length === 0 || foundWords.length === 0) return false;
  if (sharedInOrder(citedWords, foundWords) < citedWords.length) return false;
  const beyond = wordsBeyond(citedWords, foundWords);
  if (beyond.length === 0) return false;
  const said = new Map<string, number>();
  for (const word of wordsOf(sentence)) said.set(word, (said.get(word) ?? 0) + 1);
  for (const word of beyond) {
    const left = said.get(word) ?? 0;
    if (left === 0) return false;
    said.set(word, left - 1);
  }
  return true;
}
