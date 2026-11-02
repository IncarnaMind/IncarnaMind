/**
 * The line of a Passage a check read that is nearest a sentence (#770): the one
 * that shares the most of its words, when it shares enough (two words, and two
 * in five of the sentence's) to speak to the same thing: a sentence about
 * something else that shares a common word or two doesn't get a request. A sentence found unsupported may still have a Document that says
 * something different about it; this finds the line to show and to judge.
 */

import { SET_ASIDE_LINE, UNPLACED_MARK } from "../sheetRows";

/** Words that say what a sentence is about: four letters or more, and numbers; Chinese by pairs. */
const wordsOf = (text: string): Set<string> => {
  const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}|\d+(?:[.,]\d+)?/gu) ?? []);
  for (const run of text.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for (let at = 0; at + 2 <= run.length; at++) words.add(run.slice(at, at + 2));
  }
  return words;
};

/** A mark where a new Unit starts in a Passage: "[p. 4] ", "[slide 4] ", "[§ 2.1 Sensitivity] "… */
const UNIT_MARK = /^\[(?:p\. \d+|slides? [^\]]+|§[^\]]*|[^\]]*rows? [\d–-]+|lines? [\d–-]+)\] /;

/** The fewest words a line must share with the sentence to count as speaking to it... */
const MIN_SHARED = 2;
/** ...and the least share of the sentence's own words (Chinese: its pairs of characters) they must be. */
const MIN_SHARE = 0.4;

const FIGURE = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g;

const figuresIn = (text: string): { value: number; percent: boolean }[] =>
  (text.match(FIGURE) ?? []).map((figure) => ({
    value: Number(figure.replace(/[,%]/g, "")),
    percent: figure.endsWith("%"),
  }));

/**
 * Whether every figure the sentence states is in the text: "21%" is also "0.21", and "1,482.6" is
 * "1482.6". A sentence without a figure has none to differ in.
 */
export function figuresMatch(sentence: string, text: string): boolean {
  const there = figuresIn(text).map((figure) => figure.value);
  const has = (wanted: number) => there.some((value) => Math.abs(value - wanted) < 1e-9);
  return figuresIn(sentence).every(
    ({ value, percent }) => has(value) || (percent && has(value / 100)),
  );
}

export interface NearestLine {
  /** The id the model was shown the Passage by. */
  id: string;
  /** The line, without its Unit mark. */
  text: string;
  shared: number;
}

/** The line, among the Passages shown, that shares the most words with the sentence; null if none shares enough. */
export function nearestLine(
  sentence: string,
  passages: readonly { id: string; text: string }[],
): NearestLine | null {
  const wanted = wordsOf(sentence);
  if (wanted.size === 0) return null;
  let best: NearestLine | null = null;
  for (const passage of passages) {
    // A row the file sets aside is no value the Document gives for a sentence about now (#1979).
    if (passage.text.startsWith(UNPLACED_MARK)) continue;
    for (const raw of passage.text.split("\n")) {
      if (SET_ASIDE_LINE.test(raw)) continue;
      const text = raw.replace(UNIT_MARK, "").trim();
      if (text === "") continue;
      let shared = 0;
      for (const word of wordsOf(text)) if (wanted.has(word)) shared++;
      if (
        shared >= MIN_SHARED &&
        shared / wanted.size >= MIN_SHARE &&
        (!best || shared > best.shared)
      ) {
        best = { id: passage.id, text, shared };
      }
    }
  }
  return best;
}
