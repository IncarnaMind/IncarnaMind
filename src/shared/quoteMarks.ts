/**
 * Quotation marks against the words they are around (#2605): whether an Answer's quote differs
 * from a page's words only in the kind of its marks (“ ” against ‘ ’), and where the page holds
 * it that way. It reads both as the shared normaliser does (./text), so a line break, a full-width
 * form or a dash is no difference, and only the marks are read as one of two kinds: an apostrophe
 * inside a word (it’s, the bosses’) is never a mark.
 *
 * A word, a letter's case, a number or any other character changed is a difference: nothing here
 * loses one, so nothing here may offer Use the Document's wording for it.
 */
import { normaliseWithOffsets } from "./text";

/** A quotation mark's kind: “ ” « » 「 」 『 』 and " are double, ‘ ’ and ' are single. */
export type MarkKind = "double" | "single";

interface Item {
  /** A mark, whose kind is what differs between the two texts. */
  mark?: MarkKind;
  /** A character that is not a mark. */
  char?: string;
  /** A hyphen a line break joined away: no text, and nothing matches it. */
  removed?: true;
  /** Where it is in the text given, in UTF-16 offsets. */
  start: number;
  end: number;
}

/** Scripts with no apostrophe: a mark between two of their characters is a quotation mark. */
const NO_APOSTROPHE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** How far ahead a closing mark that would make a plural possessive an apostrophe is looked for. */
const LOOKAHEAD = 200;

const wordish = (char: string | undefined) =>
  char !== undefined && LETTER_OR_DIGIT.test(char) && !NO_APOSTROPHE.test(char);

/** Whether the character at `at` sits between two letters or digits of a word: it’s. */
const inWord = (text: string, at: number) => wordish(text[at - 1]) && wordish(text[at + 1]);

/** Whether the ' at `at` closes a single mark there: it follows a word and no word follows it. */
const closesSingle = (text: string, at: number) => {
  const char = text[at];
  if (char === "’") return true;
  if (char === "‘") return false;
  return char === "'" && wordish(text[at - 1]) && !wordish(text[at + 1]);
};

/**
 * Whether a ’ or ' with a single mark open ends a plural possessive (the bosses’, clients’)
 * rather than closing that mark, as it does in ‘the bosses’ rule’: it ends in s and a later
 * closing mark waits for the one that is open.
 */
function pluralPossessive(text: string, at: number): boolean {
  if (!/[sS]/.test(text[at - 1] ?? "")) return false;
  const limit = Math.min(text.length, at + LOOKAHEAD);
  for (let next = at + 1; next < limit; next++) {
    const char = text[next];
    if (char !== "’" && char !== "'" && char !== "‘") continue;
    // An apostrophe inside another word says nothing of the mark that is open.
    if (inWord(text, next)) continue;
    return closesSingle(text, next);
  }
  return false;
}

/**
 * `text` read as marks and characters, in order. A ' or ’ opens or closes a single mark unless
 * it is an apostrophe: inside a word, or at a word's end with no single mark open (the bosses’),
 * or a plural possessive followed by the mark that closes the span (the ‘clients’ files’).
 */
function itemsOf(text: string): Item[] {
  const items: Item[] = [];
  let singles = 0;
  for (const unit of normaliseWithOffsets(text).units) {
    const { char, start, end } = unit;
    if (unit.removed) {
      items.push({ removed: true, start, end });
      continue;
    }
    if (char === '"') {
      items.push({ mark: "double", start, end });
      continue;
    }
    if (char !== "'") {
      items.push({ char, start, end });
      continue;
    }
    const original = text[start];
    if (inWord(text, start)) {
      items.push({ char, start, end });
      continue;
    }
    if (original === "‘") {
      singles++;
      items.push({ mark: "single", start, end });
      continue;
    }
    if (singles > 0) {
      if (pluralPossessive(text, start)) {
        items.push({ char, start, end });
        continue;
      }
      singles--;
      items.push({ mark: "single", start, end });
      continue;
    }
    // A ’ or ' after a word, with none open, is the word's own: the bosses’ vote.
    if (wordish(text[start - 1])) {
      items.push({ char, start, end });
      continue;
    }
    singles++;
    items.push({ mark: "single", start, end });
  }
  return items;
}

/** Whether `wanted` reads as `page` from `at`: its characters the same, its marks any kind. */
function readsAs(
  wanted: readonly Item[],
  page: readonly Item[],
  at: number,
): { matches: boolean; differs: boolean } {
  let differs = false;
  for (const [index, left] of wanted.entries()) {
    const right = page[at + index] as Item;
    if (left.mark !== undefined && right.mark !== undefined) {
      if (left.mark !== right.mark) differs = true;
    } else if (
      left.mark !== undefined ||
      right.mark !== undefined ||
      left.removed ||
      right.removed ||
      left.char !== right.char
    ) {
      return { matches: false, differs: false };
    }
  }
  return { matches: true, differs };
}

/** Whether two texts differ only in the kind of their quotation marks, and in at least one of them. */
export function differsOnlyInMarks(answer: string, page: string): boolean {
  const left = itemsOf(answer);
  const right = itemsOf(page);
  if (left.length !== right.length) return false;
  const { matches, differs } = readsAs(left, right, 0);
  return matches && differs;
}

/**
 * The quote with the page's own marks where the page holds it differing only in the kind of
 * their quotation marks, or null: more than one place is no place to take, and neither is none.
 * Its other characters are the quote's own, so only its marks change in the sentence.
 */
export function documentWordingIn(words: string, page: string): string | null {
  const wanted = itemsOf(words);
  const hay = itemsOf(page);
  if (wanted.length === 0 || hay.length < wanted.length) return null;
  let found: string | null = null;
  for (let at = 0; at + wanted.length <= hay.length; at++) {
    const { matches, differs } = readsAs(wanted, hay, at);
    if (!matches || !differs) continue;
    const marks: { start: number; end: number; mark: string }[] = [];
    for (const [index, left] of wanted.entries()) {
      if (left.mark === undefined) continue;
      const right = hay[at + index] as Item;
      const mark = page.slice(right.start, right.end);
      // Every mark takes one character where a mark stood, so the sentence keeps its length.
      if (mark.length !== left.end - left.start) {
        marks.length = 0;
        break;
      }
      marks.push({ start: left.start, end: left.end, mark });
    }
    if (marks.length === 0) continue;
    let wording = words;
    for (const { start, end, mark } of [...marks].sort((a, b) => b.start - a.start)) {
      wording = `${wording.slice(0, start)}${mark}${wording.slice(end)}`;
    }
    if (found !== null) return null;
    found = wording;
  }
  return found;
}
