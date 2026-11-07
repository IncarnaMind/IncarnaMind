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

const wordish = (char: string | undefined) =>
  char !== undefined && LETTER_OR_DIGIT.test(char) && !NO_APOSTROPHE.test(char);

/** Whether the character at `at` sits between two letters or digits of a word: it’s. */
const inWord = (text: string, at: number) => wordish(text[at - 1]) && wordish(text[at + 1]);

/**
 * `text` read as marks and characters, in order. A ' or ’ opens or closes a single mark unless
 * it is an apostrophe: inside a word, or at a word's end with no single mark open (the bosses’).
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
    if (singles > 0) {
      singles--;
      items.push({ mark: "single", start, end });
      continue;
    }
    // A ’ or ' after a word, with none open, is the word's own: the bosses’ vote.
    if (original !== "‘" && wordish(text[start - 1])) {
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
 * The page's own words where it holds `words` with only the kind of their quotation marks
 * changed, or null: more than one place is no place to take, and neither is none.
 */
export function documentWordingIn(words: string, page: string): string | null {
  const wanted = itemsOf(words);
  const hay = itemsOf(page);
  if (wanted.length === 0 || hay.length < wanted.length) return null;
  let found: string | null = null;
  for (let at = 0; at + wanted.length <= hay.length; at++) {
    const { matches, differs } = readsAs(wanted, hay, at);
    if (!matches || !differs) continue;
    if (found !== null) return null;
    const first = hay[at] as Item;
    const last = hay[at + wanted.length - 1] as Item;
    found = page.slice(first.start, last.end);
  }
  return found;
}
