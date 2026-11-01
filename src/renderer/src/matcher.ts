import type { TextRange } from "../../core/api";
import { SIMPLIFIED } from "../../shared/hanVariants";
import { pinyinReadings } from "../../shared/pinyin";

/**
 * Matching what the User types against names: Minds, conversations,
 * Documents, Folders, Tags and commands, in ⌘K and the Library. Case and
 * accents don't count, traditional Chinese reads as simplified, a Chinese
 * name is found by its pinyin ("caiwu" for 财务) or the pinyin's initials
 * ("cw"), in any reading a character commonly has ("chongming" for 重命名),
 * and a word of four letters or more may have one typo ("contarct").
 * Every word typed must be in the name; a name that is the words typed,
 * starts with them or has them at the start of its words ranks above one that
 * only holds them, and a match with a typo below all of those.
 */

/** How well a name matches, and where in it: a higher score is a better match. */
export interface NameMatch {
  score: number;
  ranges: TextRange[];
  /** Whether what was typed is the name or starts one of its words, rather than being inside one. */
  atWordStart: boolean;
  /** Whether the name holds what was typed with one typo, inside one word, rather than as it was typed. */
  typo: boolean;
}

/** A spelling of the name, each of its units pointing at the folded name's. */
interface Spelling {
  text: string;
  /** For each unit of `text`, the unit of the folded name it spells. */
  of: number[];
  /** For each unit of `text`, whether a word may start there. */
  starts: boolean[];
}

interface Folded extends Spelling {
  /** For each unit of `text`, where the character it came from starts and ends in the name. */
  from: number[];
  to: number[];
  /** Its Chinese characters by their pinyin, and by the pinyin's initials, in each common reading (#1416); null without any. */
  pinyin: readonly Spelling[] | null;
  initials: readonly Spelling[] | null;
}

const MARKS = /\p{Mn}/gu;
const HAN = /\p{Script=Han}/u;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const LETTERS = /^[a-z]+$/;
/** Words this long or longer may have one typo. */
const TYPO_FROM = 4;

/** Names are folded once, not at every key typed: a Library holds thousands. */
const folds = new Map<string, Folded>();
const MOST_FOLDS = 50_000;

/** Whether a word can start at `at`: the name's start, after a space or a sign, or at a Chinese character. */
function startsWord(text: string, at: number): boolean {
  if (at === 0) return true;
  if (HAN.test(text[at] ?? "")) return true;
  return !WORD_CHARACTER.test(text[at - 1] ?? "");
}

/** How many ways one name is spelled, so a name of several polyphonic characters stays cheap to fold. */
const MOST_WAYS = 8;

/** Every way the name's characters can be read, the collation's reading of each first. */
function readingWays(readings: readonly (readonly (string | null)[])[]): (string | null)[][] {
  const ways: (string | null)[][] = [];
  const walk = (at: number, way: (string | null)[]) => {
    if (ways.length >= MOST_WAYS) return;
    if (at === readings.length) {
      ways.push([...way]);
      return;
    }
    for (const reading of readings[at] ?? [null]) {
      way.push(reading);
      walk(at + 1, way);
      way.pop();
    }
  };
  walk(0, []);
  return ways;
}

function spell(text: string, syllables: (string | null)[], initialsOnly: boolean): Spelling {
  const spelling: Spelling = { text: "", of: [], starts: [] };
  for (let at = 0; at < text.length; at++) {
    const syllable = syllables[at];
    const written = syllable ? (initialsOnly ? syllable.slice(0, 1) : syllable) : (text[at] ?? "");
    for (let unit = 0; unit < written.length; unit++) {
      spelling.text += written[unit];
      spelling.of.push(at);
      spelling.starts.push(unit === 0 && (syllable !== null || startsWord(text, at)));
    }
  }
  return spelling;
}

function fold(name: string): Folded {
  const known = folds.get(name);
  if (known) return known;
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const character of name) {
    const plain = (SIMPLIFIED.get(character) ?? character)
      .normalize("NFD")
      .replace(MARKS, "")
      .toLowerCase();
    text += plain;
    for (let unit = 0; unit < plain.length; unit++) {
      from.push(at);
      to.push(at + character.length);
    }
    at += character.length;
  }
  // By UTF-16 unit, as every offset here is: a Chinese character is one, an emoji two.
  const units = Array.from({ length: text.length }, (_, index) => index);
  const readings = units.map((index) => {
    const found = pinyinReadings(text[index] ?? "");
    return found.length > 0 ? found : [null];
  });
  const chinese = readings.some((each) => each[0] !== null);
  const ways = readingWays(readings);
  const folded: Folded = {
    text,
    of: units,
    starts: units.map((index) => startsWord(text, index)),
    from,
    to,
    pinyin: chinese ? ways.map((way) => spell(text, way, false)) : null,
    initials: chinese ? ways.map((way) => spell(text, way, true)) : null,
  };
  if (folds.size >= MOST_FOLDS) folds.clear();
  folds.set(name, folded);
  return folded;
}

/** Folds a name ahead of the keys typed, so the first key doesn't wait for it. */
export function prepareName(name: string): void {
  fold(name);
}

/** The words typed, folded as names are. */
export const queryWords = (query: string): string[] =>
  fold(query).text.split(/\s+/).filter(Boolean);

/** Where a word was found, as units of the folded name. */
interface Found {
  start: number;
  end: number;
  atStart: boolean;
  typo: boolean;
}

/** Where `word` is in a spelling: at the start of a word if it is there, else anywhere in plain text. */
function findIn(spelling: Spelling, word: string, startsOnly: boolean): Found | null {
  let inside: Found | null = null;
  for (let at = spelling.text.indexOf(word); at !== -1; at = spelling.text.indexOf(word, at + 1)) {
    const start = spelling.of[at] ?? 0;
    const end = (spelling.of[at + word.length - 1] ?? start) + 1;
    if (spelling.starts[at]) return { start, end, atStart: true, typo: false };
    if (!startsOnly && inside === null) inside = { start, end, atStart: false, typo: false };
  }
  return inside;
}

/** Whether `a` becomes `b` by at most one letter added, dropped, changed or two swapped. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  const rest = (x: number, y: number) => a.slice(x) === b.slice(y);
  return (
    rest(i + 1, i + 1) ||
    rest(i + 1, i) ||
    rest(i, i + 1) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2, i + 2))
  );
}

function findSpelled(spellings: readonly Spelling[], word: string): Found | null {
  for (const spelling of spellings) {
    const found = findIn(spelling, word, true);
    if (found) return found;
  }
  return null;
}

/** A word typed with one typo, inside one of the name's words: "contarct" in "Contracts". */
function findWithTypo(folded: Folded, word: string): Found | null {
  if (word.length < TYPO_FROM || !LETTERS.test(word)) return null;
  const { text } = folded;
  for (let at = 0; at < text.length; at++) {
    // A typo is seldom the first letter: names that start with another are passed over at once.
    if (text[at] !== word[0] || !folded.starts[at]) continue;
    // Longest first: "contrat" is "contract" with a letter dropped, not "contra".
    for (const length of [word.length + 1, word.length, word.length - 1]) {
      const part = text.slice(at, at + length);
      // One word, not letters across a boundary: "theme" isn't "the e" of "the examples" (#1372).
      if (part.length !== length || !LETTERS.test(part)) continue;
      if (folded.starts.slice(at + 1, at + length).some(Boolean)) continue;
      if (oneEditApart(word, part)) {
        return { start: at, end: at + length, atStart: true, typo: true };
      }
    }
  }
  return null;
}

function find(folded: Folded, word: string): Found | null {
  const exact = findIn(folded, word, false);
  if (exact?.atStart) return exact;
  const latin = LETTERS.test(word);
  const spelled =
    (latin && folded.pinyin && findSpelled(folded.pinyin, word)) ||
    (latin && folded.initials && findSpelled(folded.initials, word)) ||
    null;
  return spelled ?? exact ?? findWithTypo(folded, word);
}

/** Ranges in order, those that touch or overlap made one. */
export function joinRanges(ranges: TextRange[]): TextRange[] {
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: TextRange[] = [];
  for (const range of ranges) {
    const previous = out.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

/**
 * Whether `name` starts with what was typed, as a list jumps to a name by its
 * first letters: written as the name is (case, accents and traditional forms
 * don't count), or, for a Chinese name, as its pinyin or the pinyin's initials.
 */
export function startsWith(typed: string, name: string): boolean {
  const wanted = fold(typed).text;
  if (wanted === "") return false;
  const folded = fold(name);
  return [folded, ...(folded.pinyin ?? []), ...(folded.initials ?? [])].some((spelling) =>
    spelling.text.startsWith(wanted),
  );
}

/** How `name` matches the words typed, or null when one of them isn't in it. */
export function matchName(words: readonly string[], name: string): NameMatch | null {
  if (words.length === 0) return null;
  const folded = fold(name);
  const found: Found[] = [];
  for (const word of words) {
    const each = find(folded, word);
    if (!each) return null;
    found.push(each);
  }
  const length = folded.text.trim().length;
  const [first] = found;
  const whole =
    folded.text.trim() === words.join(" ") ||
    (found.length === 1 && first?.start === 0 && first.end >= length);
  const kind = found.some((each) => each.typo)
    ? 0
    : whole
      ? 4
      : first?.start === 0
        ? 3
        : found.every((each) => each.atStart)
          ? 2
          : 1;
  const ranges = found.map(({ start, end }) => ({
    start: folded.from[start] ?? 0,
    end: folded.to[end - 1] ?? name.length,
  }));
  // Of names that match alike, the shorter is the closer match.
  return {
    score: kind * 1000 - Math.min(folded.text.length, 999),
    ranges: joinRanges(ranges),
    atWordStart: kind >= 2,
    typo: kind === 0,
  };
}
