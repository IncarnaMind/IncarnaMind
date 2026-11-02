/**
 * What a figure's number measures, as a check's Figures line names it (#2255): the sentence's own
 * words for it beside the source quote's, each found where the reply says it copied them, and the
 * model's judgement in the same reply of whether the two name the same measure. An equal number
 * that measures something else ("Revenue grew 12%" for "Operating margin was 12%") backs nothing.
 */
import { MARKER } from "../../../shared/answerSentences";
import { type Figure, readFigures, readingsOf, readStatedUnits } from "../../../shared/figures";
import { sameNumber } from "../../../shared/formula";
import { isRecord } from "../../errors";

/** The words a Figures item names for what its number measures, as the reply gives them. */
export interface FigureMeasure {
  sentence: string;
  /** Null when the quote names nothing but its number. */
  quote: string | null;
  match: "same" | "differs";
}

const MEASURE_CHARACTERS = 300;
/** The longest words a reason shows: a longer copy leaves the reason to the reply's own words. */
const SHOWN_CHARACTERS = 80;

/** An item's measure as written, or null when it gives none that can be read. */
export function readMeasure(value: unknown): FigureMeasure | null {
  if (!isRecord(value)) return null;
  const { sentence, quote, match } = value;
  // The reply's words carry a marker where they repeat a recorded quote: it isn't theirs.
  const words = (text: unknown) => {
    const bare = typeof text === "string" ? text.replace(MARKER, "").trim() : "";
    return bare !== "" && bare.length <= MEASURE_CHARACTERS ? bare : null;
  };
  const said = words(sentence);
  const quoted = quote === null ? null : words(quote);
  if (said === null || (quoted === null && quote !== null)) return null;
  if (match !== "same" && match !== "differs") return null;
  return { sentence: said, quote: quoted, match };
}

// Letters and digits in runs, a Han character on its own, case and width aside.
const wordsOf = (text: string): string[] =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .match(/\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}\p{M}])+/gu) ?? [];

function inOrder(all: readonly string[], part: readonly string[]): boolean {
  if (part.length === 0) return false;
  for (let at = 0; at + part.length <= all.length; at++) {
    if (part.every((word, index) => all[at + index] === word)) return true;
  }
  return false;
}

const holds = (text: string, words: string): boolean => inOrder(wordsOf(text), wordsOf(words));

/** `text` with its figures and stated units taken out: what is left says what they are. */
function withoutNumbers(text: string): string {
  const spans = [
    ...readFigures(text, { dates: true, midLine: true }),
    ...readStatedUnits(text),
  ].sort((a, b) => b.start - a.start);
  let rest = text;
  for (const { start, end } of spans) rest = `${rest.slice(0, start)} ${rest.slice(end)}`;
  return rest;
}

/** Whether `text` has a word of its own beside its numbers: a name for what they measure. */
export const namesSomething = (text: string): boolean => /\p{L}/u.test(withoutNumbers(text));

/**
 * Whether `text` holds the measure's `words`, their digits left out of both: Claude Haiku 5.5 named
 * "employed drivers" for "employed 1,840 drivers", and "kilometres" for "96 million kilometres".
 */
const named = (text: string): string[] => wordsOf(text).filter((word) => !/^\p{N}+$/u.test(word));
const namedIn = (text: string, words: string): boolean => inOrder(named(text), named(words));

const HAN = /\p{Script=Han}/u;

/**
 * Whether `texts` hold `words`: whole, or by the pieces between their spaces, and a Chinese piece
 * as two runs of two characters or more, since Chinese writes no spaces: a cell's measure may join
 * its row label and its table's caption ("生鲜食品收入" for 生鲜食品 under 分部收入, as Claude Haiku
 * 5.5 named it).
 */
function heldIn(texts: readonly string[], words: string): boolean {
  const own = (part: string) => texts.some((text) => namedIn(text, part));
  const halves = (piece: string) => {
    const characters = named(piece);
    for (let at = 2; HAN.test(piece) && at <= characters.length - 2; at++)
      if (own(characters.slice(0, at).join(" ")) && own(characters.slice(at).join(" ")))
        return true;
    return false;
  };
  return (
    own(words) ||
    words
      .split(/\s+/u)
      .filter((piece) => /[\p{L}\p{N}]/u.test(piece))
      .every((piece) => own(piece) || halves(piece))
  );
}

/** A table's row: its cells apart by tabs or bars. */
const isRow = (line: string): boolean => line.includes("\t") || /\S\s*\|\s*\S/.test(line);
const isRule = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes("-");

/** Width, case and runs of spaces aside; a sheet's tabs and every line break stay. */
const flat = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\S\n\t]+/g, " ")
    .replace(/ ?\n ?/g, "\n");

const digit = (char: string | undefined) => char !== undefined && /\p{N}/u.test(char);
/** A letter of a script that writes spaces between words: Chinese runs into its numbers. */
const spaced = (char: string | undefined) =>
  char !== undefined &&
  /\p{L}/u.test(char) &&
  !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);

/**
 * Where flat `text` writes `quote` as text, any run of spaces, tabs or a line break in it taken
 * for another: "21%" isn't in "21.5%", "121%" or "1.21%", nor "rent" in "current".
 */
function placesOf(text: string, quote: string): { start: number; end: number }[] {
  const part = flat(quote).trim();
  if (part === "") return [];
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Whether the quote's `edge` runs on into `text` at `at`, the way `step` goes.
  const runsOn = (edge: string | undefined, at: number, step: -1 | 1) =>
    (digit(edge) && (digit(text[at]) || (/[.,]/.test(text[at] ?? "") && digit(text[at + step])))) ||
    (spaced(edge) && spaced(text[at]));
  return [...text.matchAll(new RegExp(escaped, "gu"))]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }))
    .filter(({ start, end }) => !runsOn(part[0], start - 1, -1) && !runsOn(part.at(-1), end, 1));
}

/** Where `bound` is in flat `text`'s stretch from `start` to `end`: the one the quote writes, counted from its start. */
function boundAt(
  text: string,
  { start, end }: { start: number; end: number },
  quote: string,
  bound: BoundNumber,
): number {
  const nth = placesOf(flat(quote.slice(0, bound.at + bound.chars.length)), bound.chars).length - 1;
  const inside = placesOf(text.slice(start, end), bound.chars);
  const pick = inside[nth] ?? inside[0];
  return pick ? start + pick.start : start;
}

/** A row's cells, by the separator it uses: tabs in a sheet, else bars. */
const cellsOf = (line: string): string[] => line.split(line.includes("\t") ? "\t" : "|");

/** Which cell of `line` holds offset `at`. */
const cellAt = (line: string, at: number): number => cellsOf(line.slice(0, at)).length - 1;

/**
 * The words `quote`'s number has around it in `text`, once `text` holds the quote once: in a
 * table's row, the row's label and the heading of the number's own column (the rows above a
 * Markdown table's rule, else its first row), never another row's label or another column's
 * heading; in prose, its own sentence from its start to the quote's end ("Revenue was £4,983.4m,
 * up from £4,860.0m"), never a heading or another line above it. "ambiguous" when `text` holds
 * the quote more than once; null when it doesn't hold it.
 */
function placeOf(
  text: string,
  quote: string,
  bound: BoundNumber,
): { kind: "row" | "sentence"; words: string } | "ambiguous" | null {
  const all = flat(text);
  const [found, more] = placesOf(all, quote);
  if (!found) return null;
  if (more) return "ambiguous";
  const at = boundAt(all, found, quote, bound);
  const lineStart = all.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = all.indexOf("\n", at) < 0 ? all.length : all.indexOf("\n", at);
  const line = all.slice(lineStart, lineEnd);
  if (isRow(line)) {
    const lines = all.slice(0, lineStart).split("\n").slice(0, -1);
    let first = lines.length;
    while (first > 0 && isRow(lines[first - 1] ?? "")) first--;
    const above = lines.slice(first);
    const rule = above.findIndex(isRule);
    const headings = rule >= 0 ? above.slice(0, rule) : above.slice(0, 1);
    const cells = cellsOf(line);
    const column = cellAt(line, at - lineStart);
    // The label is the nearest cell to the left that names something: in side-by-side panels
    // ("| Revenue | 12% | Operating margin | 94% |") the first cell labels another number.
    const label = cells
      .slice(0, column)
      .reverse()
      .find((cell) => namesSomething(cell));
    // A heading row that doesn't line up with the row (a reader that drops a blank corner cell,
    // a merged heading written once) can't say which heading is the number's: none counts.
    const named = headings
      .filter((heading) => cellsOf(heading).length === cells.length)
      .map((heading) => cellsOf(heading)[column] ?? "");
    return { kind: "row", words: [label ?? "", ...named].join("\n") };
  }
  const lineOfQuote = all.lastIndexOf("\n", found.start - 1) + 1;
  const ends = [...all.slice(lineOfQuote, found.start).matchAll(/[.!?;](?:\s|$)|[。！？；]/gu)];
  const last = ends.at(-1);
  const from = lineOfQuote + (last?.index === undefined ? 0 : last.index + last[0].length);
  return { kind: "sentence", words: all.slice(from, found.end) };
}

/**
 * The number a figure is bound to, as its quote writes it and where (`chars`, `at`), the figure as
 * the sentence writes it (`figure`), and the values either takes.
 */
export interface BoundNumber {
  chars: string;
  at: number;
  figure: string;
  values: readonly number[];
}

const digitsOf = (chars: string): string => chars.normalize("NFKC").replace(/\D/gu, "");

/** Whether `figure` writes the figure's own number, or its source's, in digits or in value. */
function writesNumber(figure: Figure, bound: BoundNumber): boolean {
  const written = new Set([digitsOf(bound.chars), digitsOf(bound.figure)].filter(Boolean));
  return (
    written.has(digitsOf(figure.chars)) ||
    readingsOf(figure).some((reading) =>
      bound.values.some((value) => sameNumber(reading.value, value)),
    )
  );
}

/**
 * The most a measure's words may run to, its own number taken out, from the longest Claude Haiku
 * 5.5 named in this issue's live runs: 8 words ("Net finance cost over the last 12 months") and 11
 * Han characters ("服装 · 2025年第三季度 分部收入"). Han and kana count by the character; the rest
 * by the word between spaces ("like-for-like" is one). Past either, the words are a copied clause.
 */
const MEASURE_WORDS = 10;
const MEASURE_HAN = 16;
const CHARACTER_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

const withinCaps = (words: string): boolean =>
  (words.match(CHARACTER_SCRIPTS)?.length ?? 0) <= MEASURE_HAN &&
  words
    .replace(CHARACTER_SCRIPTS, " ")
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length <= MEASURE_WORDS;

/**
 * A measure's words as a name. Words that write the figure's own number are the clause around it
 * ("leverage was 3.1x", "新开门店14家"), and name the measure in the rest once the number and the
 * unit read with it are taken out (`clause`). Null when nothing is left, the rest is past the caps,
 * or it still writes another number, so it is a clause about two ("毛利率为38.6%，2025年第三季度为").
 */
function nameOf(words: string, bound: BoundNumber): { words: string; clause: boolean } | null {
  const own = readFigures(words, { midLine: true })
    .filter((figure) => writesNumber(figure, bound))
    .sort((a, b) => b.start - a.start);
  if (own.length === 0) return withinCaps(words) ? { words, clause: false } : null;
  let rest = words;
  for (const { start, end } of own) rest = `${rest.slice(0, start)} ${rest.slice(end)}`;
  rest = rest.replace(/\s+/gu, " ").trim();
  if (!namesSomething(rest) || !withinCaps(rest)) return null;
  return readFigures(rest, { midLine: true }).length > 0 ? null : { words: rest, clause: true };
}

export type MeasureFinding =
  | { kind: "same" }
  /** `shown`: the two measures as a reason names them; null when either can't be shown as written. */
  | { kind: "differs"; shown: { measured: string; claimed: string } | null }
  /** A bare cell of a table's row, and the reply names nothing for it: its table's headings decide. */
  | { kind: "unnamed" }
  /** Words the reply doesn't give, that aren't a measure's short name, or that aren't where it says it copied them. */
  | { kind: "unread" };

/**
 * Whether a figure's source measures what the sentence's figure does. `sentence`: the texts the
 * sentence's words may come from (the sentence, its figure's label and context, its paragraph);
 * `quote`: the source quote, and `bound` the number in it; `passage`: the texts the quote is in,
 * its cited pages first, read only when the quote alone can't say.
 */
export function measureFinding(
  measure: FigureMeasure | null,
  sentence: readonly string[],
  quote: string,
  bound: BoundNumber,
  passage: () => readonly string[],
): MeasureFinding {
  if (!measure) return { kind: "unread" };
  const named = nameOf(measure.sentence, bound);
  const naming = measure.quote === null ? null : nameOf(measure.quote, bound);
  if (named === null || (measure.quote !== null && naming === null)) return { kind: "unread" };
  const said = named.words;
  const quoted = naming?.words ?? null;
  const owned = namesSomething(said) && heldIn(sentence, said);
  // A reply that copies the clause around a number names no measure of its own, so its match
  // can't tell the fleet's kilometres from rail partners' (Claude Haiku 5.5 called them the same):
  // the quote's clause must write the sentence's measure itself.
  const copied = named.clause || naming?.clause === true;
  // The first text that holds the quote decides, its cited pages before the rest of its Document:
  // a quote it holds twice is in no one place.
  let place: ReturnType<typeof placeOf> | undefined;
  const placed = () => {
    if (place !== undefined) return place;
    place = null;
    for (const text of passage()) {
      place = placeOf(text, quote, bound);
      if (place !== null) break;
    }
    return place;
  };
  // A quote from a table's row names its cells' measures by their columns: the bound number's own
  // column and its row, never the rest of the row it quotes.
  const tabled = quote.split("\n").some(isRow);
  const where = () => {
    const found = placed();
    return found === null || found === "ambiguous" ? null : found;
  };
  const found =
    quoted === null || !namesSomething(quoted)
      ? []
      : !tabled && namedIn(quote, quoted)
        ? [quote]
        : [where()?.words ?? ""].filter((words) => words !== "" && namedIn(words, quoted));
  // A measure the reply itself says differs backs nothing, whatever words it gives for either.
  if (measure.match === "differs") {
    const asWritten = (words: string, texts: readonly string[]) =>
      words.length <= SHOWN_CHARACTERS && texts.some((text) => holds(text, words));
    return {
      kind: "differs",
      shown:
        quoted !== null && owned && !copied && asWritten(quoted, found) && asWritten(said, sentence)
          ? { measured: quoted, claimed: said }
          : null,
    };
  }
  if (!owned || (copied && (quoted === null || !heldIn([quoted], said)))) return { kind: "unread" };
  if (found.length > 0) return { kind: "same" };
  // Only a table's cell may name nothing of its own: a number in prose has its measure beside it.
  const cell = quoted === null && !namesSomething(quote) ? where() : null;
  return cell?.kind === "row" ? { kind: "unnamed" } : { kind: "unread" };
}
