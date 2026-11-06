/**
 * Finding a quote in a Document's text: the Citation check (#30) decides with
 * it whether a quote is on its cited pages, and the viewer highlights what it
 * finds, so the badge and the highlight always agree.
 *
 * The quote and the text are normalised the same way, then matched as an
 * exact substring. First the shared normaliser (`normaliseWithOffsets` in
 * ./text): NFKC, which also turns ligatures ("ﬁ") and Greek letter variants
 * ("ϵ", "𝜖") into plain letters, CJK radical look-alikes folded, invisible
 * characters such as soft hyphens dropped, quote marks and dashes unified,
 * line-break hyphenation handled, whitespace next to CJK removed and the rest
 * collapsed. Then, for matching only, so indexing and embeddings keep the
 * shared normaliser's text:
 *
 * - letters are compared in lower case, with the final sigma "ς" as "σ": a
 *   quote that starts mid-sentence is often given a capital;
 * - the quote marks and dashes the shared normaliser leaves alone ("‹", "›",
 *   "ʼ", "⸺", "⸻") are unified too;
 * - a reference or footnote mark "[^36]" reads "[36]": models write a paper's
 *   reference "[36]" in the syntax of our own Citation markers. Only matching
 *   reads it so: the markers in an Answer's text are never touched;
 * - a soft hyphen that ends a line is read as a hyphen, so the word split
 *   there is joined like any other ("inter\u00ad\nnational");
 * - a pipe that breaks a table's cells, a lone "|" with whitespace or a
 *   line's start or end beside it, reads as a space: a Markdown table's row
 *   ("| Water filter | 0.4 kg |") is found without its pipes, and a row of a
 *   slide's or a Word file's table, whose cells are stored separated by tabs,
 *   with pipes between them, as models write rows (#76). A pipe inside a word
 *   ("a|b") or doubled ("||") stays a pipe;
 * - traditional Chinese characters are read as simplified ones, character by
 *   character, by OpenCC's table (./hanVariants): a page in traditional
 *   characters is quoted in simplified ones when the Answer is written in
 *   them ("讓全球" as "让全球"), and the other way round. Phrases aren't
 *   converted, and a character stays one character, so offsets hold
 *   (ADR-0009).
 *
 * The match itself has two tolerances:
 *
 * - A hyphen that ended a line between two letters may be in the quote or
 *   not ("inter-\nnational" matches "international" and "inter-national"), or
 *   be followed by a space ("inter- national"): the normaliser can only guess
 *   whether it was a real hyphen, and a model may copy the line break as a
 *   space.
 * - An ellipsis ("..." or "…") inside a quote that isn't in the text as it is
 *   marks words left out. The quote is found when each part is in the text,
 *   in order, and every part has at least `MIN_PART_WORDS` words and
 *   `MIN_PART_CHARACTERS` letters or digits: a shorter part would be found
 *   almost anywhere, and "found" must keep meaning that these words are on the
 *   page. Each part is returned, for the viewer to highlight. An ellipsis at
 *   the start or the end of a quote leaves nothing out of it.
 *
 * - In a Document whose text lost its f-ligatures (see `lostLigatures`), a
 *   quote's "fi", "fl", "ff", "ffi" or "ffl" may be the lone "f" the text
 *   kept: pdf.js reads some PDFs' ligatures as their first letter only, so a
 *   page that shows "finance" has "fnance" for text. Not every one is lost
 *   ("Firm", with a capital, kept its "Fi"), so the quote and the text are
 *   both read with each ligature's letters as one "f". Only there: in other
 *   text, 4% of words would then match another ("of" an "off", "food" a
 *   "flood", "four" a "flour"), which is a word changed (ADR-0009).
 *
 * Nothing else is forgiven: a quote with a word changed, added or dropped
 * isn't found.
 *
 * Spreadsheets (ADR-0011) are matched with `numbers` on: number formatting is
 * normalised in the quote and the text alike, so a figure matches however it
 * is written, while its digits, decimals and sign must agree. Which
 * characters are formatting is the figure reader's to say (`numberFormatting`
 * in ./figures), so the check and a calculation read a number the same way:
 *
 * - thousands separators go: "4,812", "4 812" and "4812" are the same. In the
 *   text, a separating space must be a real one: a tab, which separates
 *   cells, never joins numbers. In the quote, spaces between groups of three
 *   digits are tried as separators first, then as spaces;
 * - trailing zeros after a decimal point go ("4,812.50" is "4812.5", "3.0"
 *   is "3"), but other decimals stay: "4812.05" isn't "4812.5";
 * - currency symbols next to a number go ("£4,812" is "4812");
 * - an accounting negative "(4,812)" reads "-4812";
 * - a number is matched whole: "4812" isn't found in "14812", "48125",
 *   "4812.5" or "-4812".
 *
 * Slides are matched with `numbers: "if-needed"`: as they are first, then,
 * if the quote isn't found, with number formatting normalised. A chart's
 * figures are stored as the values the file caches ("Jun: 1560") but drawn,
 * and so quoted, in its number format ("Jun: 1,560") (#76). A quote found as
 * it is stays found, so a slide's other text is matched as before.
 */
import { numberFormatting } from "./figures";
import { SIMPLIFIED } from "./hanVariants";
import { type NormalisedUnit, normaliseWithOffsets } from "./text";

/** A span of the original text, in UTF-16 offsets; `end` is exclusive. */
export interface TextRange {
  start: number;
  end: number;
}

/** Part of a quote's match inside one piece of a text made of pieces. */
export interface PieceRange extends TextRange {
  /** Index of the piece. */
  piece: number;
}

export interface TextPiece {
  text: string;
  /** Whether a line break follows the piece, e.g. at the end of a PDF text line or page. */
  breakAfter?: boolean;
}

/** The fewest words each part of a quote with an ellipsis must have. */
export const MIN_PART_WORDS = 3;

/** The fewest letters or digits each part of a quote with an ellipsis must have. */
export const MIN_PART_CHARACTERS = 15;

/** Matching only: the quote marks and dashes `normaliseText` leaves alone, and the final sigma. */
const FOLDED: Readonly<Record<string, string>> = {
  "‹": "'",
  "›": "'",
  ʼ: "'",
  "⸺": "-",
  "⸻": "-",
  ς: "σ",
};

/** A soft hyphen at the end of a line: read as a hyphen, so rule 5 of the normaliser joins the word. */
const SOFT_HYPHEN_AT_LINE_END =
  /\u00ad(?=[^\S\n\r\v\f\u0085\u2028\u2029]*[\n\r\v\f\u0085\u2028\u2029])/gu;

/** An ellipsis in a normalised quote (NFKC has turned "…" into "..."), with the space around it. */
const ELLIPSIS = / ?\.{3,} ?/;

const DIGIT = /^[0-9]$/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

/**
 * A letter in lower case, folded as `FOLDED` says, and a traditional Chinese
 * character as its simplified one. Stays one UTF-16 code unit, so offsets hold.
 */
function fold(char: string): string {
  const lower = char.toLowerCase();
  const one = lower.length === 1 ? lower : char;
  return FOLDED[one] ?? SIMPLIFIED.get(one) ?? one;
}

/**
 * A pipe that breaks a table's cells, read as a space (see the module
 * comment). Same length, so offsets hold.
 */
function cellBreaksAsSpaces(text: string): string {
  const edge = (char: string | undefined) => char === undefined || /\s/u.test(char);
  return text.replace(/\|/g, (pipe, at: number) => {
    const before = text[at - 1];
    const after = text[at + 1];
    if (before === "|" || after === "|") return pipe;
    return edge(before) || edge(after) ? " " : pipe;
  });
}

/** How matching treats numbers (see the module comment). */
export interface MatchOptions {
  /** Refuse a quote with more than one matching place, including overlapping matches. */
  unique?: boolean;
  /**
   * Normalise number formatting in the quote and the text: always for
   * spreadsheets (true); for slides, only when the quote isn't found as it
   * is ("if-needed").
   */
  numbers?: boolean | "if-needed";
  /**
   * The Document's text lost its f-ligatures (see `lostLigatures`): a quote
   * not found as it is is looked for with each ligature's letters read as
   * one "f", in the quote and in the text alike.
   */
  lostLigatures?: boolean;
}

/** At least this many "f"s before a letter, for a text's lost ligatures to show. */
const MIN_F_BEFORE_LETTER = 200;

/**
 * Below this share of them followed by "f", "i" or "l", a text lost its
 * f-ligatures. In the evaluation's Documents that keep them, with enough
 * "f"s to tell, it is 24 to 39%; JP Morgan's ESG report, whose text lost
 * them, has 1.3% (#67).
 */
const MAX_LIGATURE_SHARE = 0.05;

/**
 * Whether a Document's text shows that it lost its f-ligatures: it has many
 * "f"s before a letter, and hardly any are followed by "f", "i" or "l", as
 * in English text a fifth or more are. Read the whole Document's text: a
 * page alone can have too few, or a table of names with none.
 */
export function lostLigatures(text: string): boolean {
  const before = text.match(/f(?=[a-z])/g)?.length ?? 0;
  if (before < MIN_F_BEFORE_LETTER) return false;
  const ligatures = text.match(/f(?=[fil])/g)?.length ?? 0;
  return ligatures / before < MAX_LIGATURE_SHARE;
}

/** An f-ligature's letters, in a normalised, lower-case needle. */
const LIGATURE_LETTERS = /f(?:f[il]?|[il])/g;

/** A needle with each f-ligature's letters read as one "f", until none is left ("fifty" reads "fty"). */
function withoutLigatures(needle: string): string {
  let folded = needle;
  for (let before = ""; before !== folded; ) {
    before = folded;
    folded = folded.replace(LIGATURE_LETTERS, "f");
  }
  return folded;
}

/**
 * A text's units read as `withoutLigatures` reads a needle: the letters after
 * each ligature's "f" marked `removed`, so offsets still point into the text.
 */
function unitsWithoutLigatures(units: NormalisedUnit[]): NormalisedUnit[] {
  for (let changed = true; changed; ) {
    changed = false;
    const live = units.filter((unit) => !unit.removed);
    const chars = live.map((unit) => unit.char).join("");
    for (const match of chars.matchAll(LIGATURE_LETTERS)) {
      for (let at = 1; at < match[0].length; at++) {
        (live[match.index + at] as NormalisedUnit).removed = true;
        changed = true;
      }
    }
  }
  return units;
}

/**
 * Which spaces between groups of three digits are thousands separators:
 * "text", those that are real spaces in the text (not tabs or line breaks);
 * "all" or "none", for the two readings of a quote.
 */
type GroupSpaces = "text" | "all" | "none";

const LETTER_OR_DIGIT_CHAR = /^[\p{L}\p{N}]$/u;

/** Marks the number formatting in `units` (of `text`) `removed`, as the module comment says. */
function normaliseNumbers(units: NormalisedUnit[], text: string, spaces: GroupSpaces): void {
  const live = units.filter((unit) => !unit.removed);
  const realSpace = (unit: NormalisedUnit) => !/[^     ]/.test(text.slice(unit.start, unit.end));
  const edits = numberFormatting(
    live.map((unit) => unit.char),
    (at) => spaces === "all" || (spaces === "text" && realSpace(live[at] as NormalisedUnit)),
  );
  for (const [at, edit] of edits) {
    const unit = live[at] as NormalisedUnit;
    if (edit === "-") unit.char = "-";
    else unit.removed = true;
  }
}

/**
 * The text normalised for matching: the shared normaliser's units, folded,
 * with the caret of each "[^N]" marked `removed`, and with `numbers`, number
 * formatting too.
 */
function matchUnits(text: string, numbers?: GroupSpaces): NormalisedUnit[] {
  // Same length, so the offsets of the units still point into `text`.
  const { units } = normaliseWithOffsets(
    cellBreaksAsSpaces(text.replace(SOFT_HYPHEN_AT_LINE_END, "-")),
  );
  const folded = units.map((unit) => ({ ...unit, char: fold(unit.char) }));
  for (let at = 0; at + 3 < folded.length; at++) {
    if (folded[at]?.char !== "[" || folded[at + 1]?.char !== "^") continue;
    let end = at + 2;
    while (DIGIT.test(folded[end]?.char ?? "")) end++;
    if (end > at + 2 && folded[end]?.char === "]")
      (folded[at + 1] as NormalisedUnit).removed = true;
  }
  if (numbers) normaliseNumbers(folded, text, numbers);
  return folded;
}

/** The quote normalised for matching, as a string: what is looked for in the text's units. */
const needleOf = (quote: string, numbers?: GroupSpaces) =>
  matchUnits(quote, numbers)
    .filter((unit) => !unit.removed)
    .map((unit) => unit.char)
    .join("");

/** Accepts or refuses a match of `needle` at units `first` to `last`. */
type Accept = (needle: string, first: number, last: number) => boolean;

/**
 * Numbers are matched whole: a match that starts with a digit mustn't follow
 * a digit, a decimal point or a minus sign, and one that ends with a digit
 * mustn't be followed by a digit or decimals.
 */
function wholeNumbers(units: readonly NormalisedUnit[]): Accept {
  const liveBefore = (at: number, steps: number) => {
    let found = 0;
    for (let index = at - 1; index >= 0; index--) {
      const unit = units[index] as NormalisedUnit;
      if (unit.removed) continue;
      if (++found === steps) return unit;
    }
    return undefined;
  };
  const liveAfter = (at: number, steps: number) => {
    let found = 0;
    for (let index = at + 1; index < units.length; index++) {
      const unit = units[index] as NormalisedUnit;
      if (unit.removed) continue;
      if (++found === steps) return unit;
    }
    return undefined;
  };
  const digit = (unit: NormalisedUnit | undefined) => unit !== undefined && DIGIT.test(unit.char);
  return (needle, first, last) => {
    if (DIGIT.test(needle[0] ?? "")) {
      const before = liveBefore(first, 1);
      if (digit(before)) return false;
      if (before?.char === "." && digit(liveBefore(first, 2))) return false;
      if (before?.char === "-" && !LETTER_OR_DIGIT_CHAR.test(liveBefore(first, 2)?.char ?? "")) {
        return false;
      }
    }
    if (DIGIT.test(needle.at(-1) ?? "")) {
      const after = liveAfter(last, 1);
      if (digit(after)) return false;
      if (after?.char === "." && digit(liveAfter(last, 2))) return false;
    }
    return true;
  };
}

/** The index of the last unit of a match of `needle` starting at `first`, or -1. */
function matchAt(units: readonly NormalisedUnit[], needle: string, first: number): number {
  let at = first;
  let last = -1;
  for (let index = 0; index < needle.length; ) {
    const unit = units[at];
    if (!unit) return -1;
    at++;
    if (unit.optional && needle[index] !== "-") continue; // skip a line-end hyphen
    if (!unit.optional && unit.removed) continue;
    if (unit.char !== needle[index]) return -1;
    last = at - 1;
    index++;
    // The line break after a line-end hyphen, copied as a space ("inter- national").
    if (unit.optional && needle[index] === " ") index++;
  }
  return last;
}

/** The first match of `needle` in `units` starting at or after unit `from`, as unit indices. */
function findFrom(
  units: readonly NormalisedUnit[],
  needle: string,
  from: number,
  accept?: Accept,
): { first: number; last: number } | null {
  for (let first = from; first < units.length; first++) {
    const unit = units[first] as NormalisedUnit;
    if (unit.removed || unit.char !== needle[0]) continue;
    const last = matchAt(units, needle, first);
    if (last >= 0 && (!accept || accept(needle, first, last))) return { first, last };
  }
  return null;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Whether a part of a quote with an ellipsis is long enough to count. */
function longEnough(part: string): boolean {
  if ((part.match(LETTER_OR_DIGIT)?.length ?? 0) < MIN_PART_CHARACTERS) return false;
  let words = 0;
  for (const segment of wordSegmenter.segment(part)) if (segment.isWordLike) words++;
  return words >= MIN_PART_WORDS;
}

/** Where `needle` is in `units`, whole or part by part (see `findQuote`), as ranges of the text. */
function findNeedle(
  units: readonly NormalisedUnit[],
  needle: string,
  accept?: Accept,
  unique = false,
): TextRange[] | "ambiguous" | null {
  if (!needle) return null;
  // With numbers, a match takes in the formatting around its figures: "£", ")" and ".00".
  const widen = accept !== undefined;
  const range = ({ first, last }: { first: number; last: number }): TextRange => {
    let from = first;
    let to = last;
    while (widen && from > 0 && units[from - 1]?.removed && !units[from - 1]?.optional) from--;
    while (widen && units[to + 1]?.removed && !units[to + 1]?.optional) to++;
    return {
      start: (units[from] as NormalisedUnit).start,
      end: (units[to] as NormalisedUnit).end,
    };
  };

  const whole = findFrom(units, needle, 0, accept);
  if (whole)
    return unique && findFrom(units, needle, whole.first + 1, accept)
      ? "ambiguous"
      : [range(whole)];
  if (!ELLIPSIS.test(needle)) return null;

  const parts = needle.split(ELLIPSIS).filter((part) => part !== "");
  if (parts.length === 0) return null;
  if (parts.length > 1 && !parts.every(longEnough)) return null;
  const found: TextRange[] = [];
  const starts: number[] = [];
  let from = 0;
  for (const part of parts) {
    const match = findFrom(units, part, from, accept);
    if (!match) return null;
    found.push(range(match));
    starts.push(match.first);
    from = match.last + 1;
  }
  if (unique) {
    for (const [index, part] of parts.entries()) {
      let alternative = findFrom(units, part, (starts[index] ?? 0) + 1, accept);
      if (!alternative) continue;
      for (const next of parts.slice(index + 1)) {
        alternative = findFrom(units, next, alternative.last + 1, accept);
        if (!alternative) break;
      }
      if (alternative) return "ambiguous";
    }
  }
  return found;
}

/**
 * Where `quote` is in `text` after both are normalised, or null if it isn't:
 * one range, or one for each part of a quote with an ellipsis (see the module
 * comment), in order. With `numbers`, number formatting is normalised too
 * (with "if-needed", only when the quote isn't found as it is).
 */
export function findQuote(
  text: string,
  quote: string,
  options: MatchOptions = {},
): TextRange[] | null {
  const readings = options.numbers === "if-needed" ? [false, true] : [options.numbers === true];
  for (const numbers of readings) {
    const found =
      findRead(text, quote, numbers, false, options.unique) ??
      (options.lostLigatures ? findRead(text, quote, numbers, true, options.unique) : null);
    if (found === "ambiguous") return null;
    if (found) return found;
  }
  return null;
}

/**
 * `findQuote` in one reading: with number formatting normalised or not, and
 * with the quote and the text both read without f-ligatures' letters or not.
 */
function findRead(
  text: string,
  quote: string,
  numbers: boolean,
  withoutLigatureLetters: boolean,
  unique = false,
): TextRange[] | "ambiguous" | null {
  const shape = withoutLigatureLetters ? withoutLigatures : (needle: string) => needle;
  const read = withoutLigatureLetters ? unitsWithoutLigatures : (units: NormalisedUnit[]) => units;
  if (!numbers)
    return findNeedle(read(matchUnits(text)), shape(needleOf(quote)), undefined, unique);
  const units = read(matchUnits(text, "text"));
  const accept = wholeNumbers(units);
  const grouped = shape(needleOf(quote, "all"));
  const found = findNeedle(units, grouped, accept, unique);
  if (found) return found;
  const spaced = shape(needleOf(quote, "none"));
  return spaced === grouped ? null : findNeedle(units, spaced, accept, unique);
}

/**
 * Finds `quote` in a text made of pieces (e.g. a PDF page's text runs, page
 * after page) and returns the part of each piece it covers, in order, or null
 * if it isn't there. A piece holding two parts of a quote with an ellipsis
 * has a range for each.
 */
export function findQuoteInPieces(
  pieces: readonly TextPiece[],
  quote: string,
  options: MatchOptions = {},
): PieceRange[] | null {
  let text = "";
  const offsets: number[] = [];
  for (const piece of pieces) {
    offsets.push(text.length);
    text += piece.text;
    if (piece.breakAfter) text += "\n";
  }
  const ranges = findQuote(text, quote, options);
  if (!ranges) return null;
  const covered: PieceRange[] = [];
  for (const range of ranges) {
    pieces.forEach((piece, index) => {
      const offset = offsets[index] as number;
      const start = Math.max(range.start, offset) - offset;
      const end = Math.min(range.end, offset + piece.text.length) - offset;
      if (start < end) covered.push({ piece: index, start, end });
    });
  }
  return covered;
}

/** Part of a quote's match inside one piece of one page. */
export interface PagePieceRange extends PieceRange {
  /** Index of the page among those given. */
  page: number;
}

/**
 * Finds `quote` in pages of pieces (e.g. a PDF's text runs, page by page) and
 * returns the part of each piece it covers, or null if it isn't there.
 *
 * A quote that runs across a page break is also found when lines at the
 * bottom of one page and the top of the next come between its halves:
 * running headers, footers and page numbers, which Passages and the Citation
 * check leave out. Up to `edgeLines` lines on each side of the breaks are
 * tried without, fewest first.
 */
export function findQuoteInPages(
  pages: readonly (readonly TextPiece[])[],
  quote: string,
  edgeLines = 4,
  options: Pick<MatchOptions, "lostLigatures"> = {},
): PagePieceRange[] | null {
  // The line each piece is on, counted from the top and from the bottom of its page.
  const lines = pages.map((pieces) => {
    const fromTop: number[] = [];
    let line = 0;
    for (const piece of pieces) {
      fromTop.push(line);
      if (piece.breakAfter) line++;
    }
    const count = pieces.at(-1)?.breakAfter ? line : line + 1;
    return { fromTop, count };
  });
  const tries: [number, number][] = [];
  for (let total = 0; total <= edgeLines * 2; total++) {
    for (let bottom = 0; bottom <= Math.min(total, edgeLines); bottom++) {
      const top = total - bottom;
      if (top <= edgeLines) tries.push([bottom, top]);
    }
  }
  for (const [bottom, top] of pages.length > 1 ? tries : [[0, 0] as [number, number]]) {
    const kept: TextPiece[] = [];
    const origin: { page: number; piece: number }[] = [];
    pages.forEach((pieces, page) => {
      const { fromTop, count } = lines[page] as { fromTop: number[]; count: number };
      pieces.forEach((piece, index) => {
        const line = fromTop[index] as number;
        // Lines at a page break: the bottom of every page but the last, the top of every page but the first.
        if (page < pages.length - 1 && line >= count - bottom) return;
        if (page > 0 && line < top) return;
        kept.push(piece);
        origin.push({ page, piece: index });
      });
      const last = kept.at(-1);
      if (last && origin.at(-1)?.page === page)
        kept[kept.length - 1] = { ...last, breakAfter: true };
    });
    const found = findQuoteInPieces(kept, quote, options);
    if (found) {
      return found.map((part) => {
        const { page, piece } = origin[part.piece] as { page: number; piece: number };
        return { page, piece, start: part.start, end: part.end };
      });
    }
  }
  return null;
}
