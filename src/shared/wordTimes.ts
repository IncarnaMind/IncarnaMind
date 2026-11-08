/**
 * When the words of a Transcript's line were said (#138), for playing its audio from a word.
 * A transcriber that gives word times has them in the file (`Cue.words`); between them, and on a
 * line with none, a character's time is taken in proportion to where it is in the line. That is
 * an estimate: it holds when the line is spoken at an even pace.
 */
import type { Cue, WordTime } from "../core/documents/formats/vtt";

/**
 * Where `word` is in `text`, `within` characters of `from` at most, case aside, as a place in
 * `text` itself: a letter whose lower case is longer ("İ" is "i̇") would move every place after it
 * in a lowered copy.
 */
function foldedIndexOf(text: string, word: string, from: number, within: number): number {
  const wanted = word.toLocaleLowerCase();
  for (let at = from; at <= from + within && at + word.length <= text.length; at++) {
    if (text.slice(at, at + word.length).toLocaleLowerCase() === wanted) return at;
  }
  return -1;
}

/** A transcriber's word, as it came: its text and when it started, in ms. */
export interface HeardWord {
  text: string;
  ms: number;
}

/** How far ahead of the last word placed the next one is looked for: a word, not a sentence on. */
const NEXT_WORD_WITHIN = 40;

/**
 * Where a transcriber's words fall in a line's text as it was written, each looked for just after
 * the one before. A word the text no longer has as it came (a number written as figures, the
 * other Chinese script) is left out, and its time with it.
 */
export function alignWords(text: string, words: readonly HeardWord[]): WordTime[] {
  const placed: WordTime[] = [];
  let from = 0;
  for (const word of words) {
    const wanted = word.text.trim();
    if (!wanted) continue;
    const at = foldedIndexOf(text, wanted, from, NEXT_WORD_WITHIN);
    if (at < 0) continue;
    const last = placed.at(-1);
    if (!last || (at > last.at && word.ms >= last.ms)) placed.push({ at, ms: Math.round(word.ms) });
    from = at + wanted.length;
  }
  return placed;
}

type TimedCue = Pick<Cue, "startMs" | "endMs" | "text" | "words">;

/** The cue's known times, its start and end among them, in order. */
function stampsOf(cue: TimedCue): WordTime[] {
  const stamps: WordTime[] = [{ at: 0, ms: cue.startMs }];
  for (const word of cue.words ?? []) {
    const last = stamps.at(-1) as WordTime;
    if (word.at > last.at && word.at < cue.text.length && word.ms >= last.ms) stamps.push(word);
    else if (word.at === last.at && word.at === 0) stamps[0] = { at: 0, ms: word.ms };
  }
  const last = stamps.at(-1) as WordTime;
  stamps.push({ at: Math.max(cue.text.length, last.at + 1), ms: Math.max(cue.endMs, last.ms) });
  return stamps;
}

/** When the character at `at` of the cue's text was said, in ms of the Transcript. */
export function timeAt(cue: TimedCue, at: number): number {
  const stamps = stampsOf(cue);
  for (let index = stamps.length - 2; index >= 0; index--) {
    const here = stamps[index] as WordTime;
    if (here.at > at) continue;
    const next = stamps[index + 1] as WordTime;
    const share = (Math.min(at, next.at) - here.at) / (next.at - here.at);
    // Up, so the time read back (`atTime`) is in the word it came from, not the one before.
    return Math.ceil(here.ms + share * (next.ms - here.ms));
  }
  return cue.startMs;
}

/** The character of the cue's text being said at `ms`. */
export function atTime(cue: TimedCue, ms: number): number {
  const stamps = stampsOf(cue);
  for (let index = stamps.length - 2; index >= 0; index--) {
    const here = stamps[index] as WordTime;
    if (here.ms > ms) continue;
    const next = stamps[index + 1] as WordTime;
    if (next.ms === here.ms) return here.at;
    const share = Math.min(1, (ms - here.ms) / (next.ms - here.ms));
    return Math.min(cue.text.length, Math.floor(here.at + share * (next.at - here.at) + 1e-9));
  }
  return 0;
}
