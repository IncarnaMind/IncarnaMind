/**
 * Which of a text's quote marks are quotation marks, for quote matching (#2504). A quote nested in a
 * quote is written in the other kind of mark ("the ‘soft weights’ property" for the page's “soft
 * weights”), so two quotation marks match whichever kind each is. Every other mark stays as the
 * shared normaliser reads it, so a quotation mark matches it only as its own kind.
 *
 * A mark is a quotation mark only when it is one of a pair around plain words:
 * - a “ ” ‘ ’ ‚ must clearly open or close: whitespace, punctuation, CJK text or the text's edge
 *   outside it, and a letter inside it. A mark touching a digit, a fraction or a letter outside it
 *   is an inch, a second, a prime or an apostrophe ("6”", "¼”", "f”(x)", "it’s");
 * - a closing mark closes only the innermost open quote, and only its own kind („ closes with ” or
 *   “, ‚ with ’ or ‘, and guillemets point either way). Guillemets and corner brackets are never a
 *   measure's, so they need no clear side;
 * - every sentence the pair is in, from its opening to its closing mark, is prose: one with no code
 *   character, read from the text's own characters ("echo ‘$HOME’", "echo “a.$b”", a backtick), and
 *   no command option ("ls -la"); and the pair is in no SQL statement, found in any case before the
 *   text is cut into sentences ("select “name”, users. id from users").
 *
 * Straight marks " and ' are never quotation marks here: they delimit code as often as prose, where
 * one kind isn't the other ("SELECT "name"" names a column, "SELECT 'name'" is a string).
 *
 * A mark that is not one of such a pair matches only itself, as on main, so a quote with a single
 * mark is found for the page's double one only where both are quotation marks.
 */
import { INVISIBLE, type NormalisedUnit } from "./text";

/** A quotation mark as matching reads it. Noncharacters, so no text has them of its own. */
const DOUBLE_QUOTATION = String.fromCharCode(0xfdd0);
const SINGLE_QUOTATION = String.fromCharCode(0xfdd1);

/** Whether a text's character and a quote's match: equal, two quotation marks, or a mark as its own kind. */
export function sameChar(text: string, quote: string | undefined): boolean {
  if (text === quote) return true;
  if (text === DOUBLE_QUOTATION) return quote === SINGLE_QUOTATION || quote === '"';
  if (text === SINGLE_QUOTATION) return quote === DOUBLE_QUOTATION || quote === "'";
  if (quote === DOUBLE_QUOTATION) return text === '"';
  if (quote === SINGLE_QUOTATION) return text === "'";
  return false;
}

/** The characters of a text that match a quote's `char`: itself, and for a quote mark the others `sameChar` takes. */
export function matchesOf(char: string): readonly string[] {
  if (char === '"') return ['"', DOUBLE_QUOTATION];
  if (char === "'") return ["'", SINGLE_QUOTATION];
  if (char === DOUBLE_QUOTATION) return [DOUBLE_QUOTATION, SINGLE_QUOTATION, '"'];
  if (char === SINGLE_QUOTATION) return [SINGLE_QUOTATION, DOUBLE_QUOTATION, "'"];
  return [char];
}

const LETTER = 1;
const NUMBER = 2;
const SPACE = 4;
const PUNCTUATION = 8;
const CJK = 16;
/** Characters of code and formulas: a pair around one, or with one beside it, is not prose. */
const CODE = 32;
/** Marks that need a clear side: they are also inches, seconds, primes and apostrophes. */
const AMBIGUOUS = 64;
/** The typographic quote marks: only these open or close a quote. */
const QUOTE_MARK = 8192;
/** What a clear side may run past to its word: “‘nested’”, “Go home.” */
const BEFORE_WORD = 128;
const AFTER_WORD = 256;
const OPENING_BRACKET = 512;
const CLOSING_BRACKET = 1024;
const EDGE = 2048;
const KNOWN = 4096;
/** What the normaliser drops, a soft hyphen or a zero-width space: every neighbour is read past it. */
const HIDDEN = 16384;

const LISTED: readonly [number, string][] = [
  [CODE, "$`\\{}<>|=^~@#/*+_[]"],
  [AMBIGUOUS, "“”‘’‚"],
  [QUOTE_MARK, "“”„‘’‚«»‹›「」『』"],
  [BEFORE_WORD, "‘“„‚«‹「『([¿¡（"],
  [AFTER_WORD, ".,!?;:…’”»›」』)]。，！？；：、）"],
  [OPENING_BRACKET, "([{“‘„‚«‹「『"],
  [CLOSING_BRACKET, ")]}"],
];

/** Each UTF-16 code unit's classes, filled in as they are first read. */
const CLASSES = new Uint16Array(0x10000);

/** CJK text, its punctuation and full-width forms: quotation marks sit against it with no space. */
const isCjk = (code: number): boolean =>
  (code >= 0x2e80 && code <= 0x9fff) ||
  (code >= 0xac00 && code <= 0xd7af) ||
  (code >= 0x1100 && code <= 0x11ff) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xff00 && code <= 0xffef);

function classify(code: number): number {
  const char = String.fromCharCode(code);
  let classes = KNOWN;
  if (/[\p{L}\p{M}]/u.test(char)) classes |= LETTER;
  else if (/\p{P}/u.test(char)) classes |= PUNCTUATION;
  if (/\p{N}/u.test(char)) classes |= NUMBER;
  if (/\s/u.test(char)) classes |= SPACE;
  if (isCjk(code)) classes |= CJK;
  for (const [listed, chars] of LISTED) if (chars.includes(char)) classes |= listed;
  if (INVISIBLE.has(char)) classes |= HIDDEN;
  CLASSES[code] = classes;
  return classes;
}

/** The classes of `text`'s code unit at `at`, or EDGE past either end. */
function at(text: string, index: number): number {
  if (index < 0 || index >= text.length) return EDGE;
  const code = text.charCodeAt(index);
  return (CLASSES[code] as number) || classify(code);
}

/** The first index from `index` on, stepping by `step`, that isn't one of `skipped`. */
function past(text: string, index: number, step: 1 | -1, skipped: number): number {
  let at_ = index;
  while (at(text, at_) & skipped) at_ += step;
  return at_;
}

/** Past a gap: a run of whitespace, and of what the normaliser drops, is one gap. */
const pastGap = (text: string, index: number, step: 1 | -1) =>
  past(text, index, step, SPACE | HIDDEN);

/** Where an SQL statement may start, and the shape it must have from there, in any case. */
const SQL_START = /\b(?:select|insert|update|delete|order\s+by|group\s+by)\b/gi;
const SQL_SHAPE =
  /^(?:select\b.*\bfrom\b|insert\s+into\b|update\b.*\bset\b|delete\s+from\b|order|group)/is;
/**
 * An SQL statement runs to a blank line or the text's end, across sentences and line breaks. A ";"
 * ends nothing: it may be inside a string ("'semi;colon'"), so where SQL may be, marks stay exact.
 */
const STATEMENT_END = /\n[^\S\n]*\n/g;
/** How far a statement is read from its first word, so a text of many is read in one pass. */
const STATEMENT_REACH = 2000;
const OPTION = /(?:^|\s)-\p{L}/u;
/**
 * Where a sentence ends: a full stop, "!" or "?" before whitespace or the text's end, CJK sentence
 * punctuation, or a blank line. A dot inside a word, a name or a number ("3.5") and a line break
 * inside a sentence don't end it.
 */
const SENTENCE_END = /[.!?](?=\s|$)|[。！？]|\n[^\S\n]*\n/g;

/** The spans of `text`'s SQL statements: SQL is found before the text is cut into sentences. */
function sqlStatements(text: string): [number, number][] {
  const ends = [...text.matchAll(STATEMENT_END)].map((end) => end.index);
  const spans: [number, number][] = [];
  let next = 0;
  for (const { index: start } of text.matchAll(SQL_START)) {
    if (start < (spans.at(-1)?.[1] ?? 0)) continue;
    while (next < ends.length && (ends[next] as number) < start) next++;
    const end = Math.min(ends[next] ?? text.length, start + STATEMENT_REACH);
    if (SQL_SHAPE.test(text.slice(start, end))) spans.push([start, end]);
  }
  return spans;
}

/** The spans of `text` that aren't prose, in order: SQL statements, and sentences with code characters or options. */
function codeSpans(text: string): [number, number][] {
  const spans = sqlStatements(text);
  const check = (from: number, to: number) => {
    const words = text.slice(from, to);
    let code = OPTION.test(words);
    for (let at_ = 0; !code && at_ < words.length; at_++) code = (at(words, at_) & CODE) !== 0;
    if (code) spans.push([from, to]);
  };
  let start = 0;
  for (const end of text.matchAll(SENTENCE_END)) {
    check(start, end.index);
    start = end.index + end[0].length;
  }
  check(start, text.length);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** Whether the code unit at `index`, just outside an opening mark, ends a word rather than code or a number. */
function opensAfter(text: string, index: number): boolean {
  const outside = at(text, index);
  if (outside & (EDGE | CJK)) return true;
  if (outside & SPACE) return true;
  if (outside & (CODE | CLOSING_BRACKET) || !(outside & PUNCTUATION)) return false;
  // A bracket against a word is a call: print(‘hi’).
  return !(outside & OPENING_BRACKET) || !(at(text, index - 1) & (LETTER | NUMBER));
}

/** Whether the code unit at `index`, just outside a closing mark, starts a new word, as prose does. */
function closesBefore(text: string, index: number): boolean {
  const outside = at(text, index);
  if (outside & (EDGE | CJK)) return true;
  if (outside & SPACE) return true;
  return (outside & PUNCTUATION) !== 0 && !(outside & (CODE | OPENING_BRACKET));
}

/** Whether the mark at `index` clearly opens: a word's start inside it, a boundary outside. */
function clearlyOpens(text: string, index: number): boolean {
  let inside = index + 1;
  for (let n = 0; n < 3 && at(text, inside) & BEFORE_WORD; n++) inside++;
  return (at(text, inside) & LETTER) !== 0 && opensAfter(text, index - 1);
}

/**
 * Whether the mark at `index` closes: "yes" with a word's end inside it and a boundary outside, "no"
 * when a one-letter word or a name of up to three capitals ends in a prime ("A’", "AB’", "4K”"), and
 * "maybe" for a single mark after an "s" with a word or a number after it, past any gap: a
 * possessive or a quote's end ("the girls’ room", "the bosses’ 2024 plan", "‘soft weights’ property").
 */
function closing(text: string, index: number, single: boolean): "yes" | "no" | "maybe" {
  let inside = index - 1;
  for (let n = 0; n < 3 && at(text, inside) & AFTER_WORD; n++) inside--;
  const last = at(text, inside);
  if (!(last & LETTER) || !closesBefore(text, index + 1)) return "no";
  if (last & CJK) return "yes";
  let start = inside;
  while (start > inside - 2 && (at(text, start - 1) & (LETTER | CJK)) === LETTER) start--;
  if (start === inside) return "no";
  const word = text.slice(start, inside + 1);
  const name = word === word.toUpperCase() && word !== word.toLowerCase();
  if (name && !(at(text, start - 1) & LETTER)) return "no";
  const s = text.charCodeAt(inside);
  const possessive =
    single &&
    inside === index - 1 &&
    (s === 0x73 || s === 0x53) &&
    at(text, index + 1) & SPACE &&
    at(text, pastGap(text, index + 1, 1)) & (LETTER | NUMBER);
  return possessive ? "maybe" : "yes";
}

/** The marks each opening mark is closed by. 」 and 』 open nothing, so a lone one is no quotation mark. */
const CLOSED_BY: ReadonlyMap<string, string> = new Map([
  ["“", "”"],
  ["”", "”"],
  ["„", "”“"],
  ["‘", "’"],
  ["’", "’"],
  ["‚", "’‘"],
  ["«", "»"],
  ["»", "«"],
  ["‹", "›"],
  ["›", "‹"],
  ["「", "」"],
  ["『", "』"],
]);

interface Open {
  mark: string;
  unit: NormalisedUnit;
  /** The last "maybe" closing mark seen while it was innermost: it closes the quote if nothing clearer does. */
  maybe?: NormalisedUnit;
}

const asQuotation = (char: string) => (char === '"' ? DOUBLE_QUOTATION : SINGLE_QUOTATION);

/**
 * Marks each unit of `text` that is a quotation mark of a pair around plain words, in a sentence of
 * prose, as a quotation mark of its kind (see `sameChar`). `units` are the normaliser's, folded:
 * every quote mark is '"' or "'", and their offsets point into `text`.
 */
export function markQuotationMarks(text: string, units: NormalisedUnit[]): void {
  const opened: Open[] = [];
  let code: [number, number][] | undefined;
  // Whether a sentence that isn't prose meets the pair anywhere from its opening to its closing mark.
  const inCode = (from: number, to: number) => {
    code ??= codeSpans(text);
    let low = 0;
    let high = code.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((code[middle] as [number, number])[1] <= from) low = middle + 1;
      else high = middle;
    }
    const first = code[low];
    return first !== undefined && first[0] < to;
  };
  const close = (open: Open, unit: NormalisedUnit) => {
    if (inCode(open.unit.start, unit.end)) return;
    open.unit.char = asQuotation(open.unit.char);
    unit.char = asQuotation(unit.char);
  };
  // A later mark that opens or closes something else ends the wait for a clearer closing mark.
  const settle = () => {
    const top = opened.pop();
    if (top?.maybe) close(top, top.maybe);
  };
  for (const unit of units) {
    const char = unit.char;
    if ((char !== '"' && char !== "'") || unit.end !== unit.start + 1) continue;
    if (!(at(text, unit.start) & QUOTE_MARK)) continue;
    const mark = text.charAt(unit.start);
    const ambiguous = (at(text, unit.start) & AMBIGUOUS) !== 0;
    const single = char === "'";
    let top = opened.at(-1);
    if (top?.maybe && !CLOSED_BY.get(top.mark)?.includes(mark)) {
      const acts =
        !ambiguous ||
        closing(text, unit.start, single) === "yes" ||
        (CLOSED_BY.has(mark) && clearlyOpens(text, unit.start));
      if (acts) settle();
      top = opened.at(-1);
    }
    const how =
      top && CLOSED_BY.get(top.mark)?.includes(mark)
        ? ambiguous
          ? closing(text, unit.start, single)
          : "yes"
        : "no";
    if (top && how === "yes") {
      opened.pop();
      close(top, unit);
    } else if (top && how === "maybe") {
      top.maybe = unit;
    } else if (CLOSED_BY.has(mark) && (!ambiguous || clearlyOpens(text, unit.start))) {
      opened.push({ mark, unit });
    }
  }
  while (opened.length) settle();
}
