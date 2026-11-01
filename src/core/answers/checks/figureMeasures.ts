/**
 * What a figure's number measures, as a check's Figures line names it (#2255): the sentence's own
 * words for it beside the source quote's, each found where the reply says it copied them, and the
 * model's judgement in the same reply of whether the two name the same measure. An equal number
 * that measures something else ("Revenue grew 12%" for "Operating margin was 12%") backs nothing.
 */
import { MARKER } from "../../../shared/answerSentences";
import { readFigures, readStatedUnits } from "../../../shared/figures";
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
const namedIn = (text: string, words: string): boolean => {
  const named = (each: string) => wordsOf(each).filter((word) => !/^\p{N}+$/u.test(word));
  return inOrder(named(text), named(words));
};

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

/**
 * The words `quote`'s number has around it in `text`, once `text` holds the quote once: in a
 * table's row, that row and its headings (the rows above a Markdown table's rule, else its first
 * row), never another row's label; in prose, its own sentence from its start to the quote's end
 * ("Revenue was £4,983.4m, up from £4,860.0m"), never a heading or another line above it.
 * "ambiguous" when `text` holds the quote more than once; null when it doesn't hold it.
 */
function placeOf(
  text: string,
  quote: string,
): { kind: "row" | "sentence"; words: string } | "ambiguous" | null {
  const all = flat(text);
  const [found, more] = placesOf(all, quote);
  if (!found) return null;
  if (more) return "ambiguous";
  const { start, end } = found;
  const lineStart = all.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = all.indexOf("\n", end) < 0 ? all.length : all.indexOf("\n", end);
  const line = all.slice(lineStart, lineEnd);
  if (isRow(line)) {
    const lines = all.slice(0, lineStart).split("\n").slice(0, -1);
    let first = lines.length;
    while (first > 0 && isRow(lines[first - 1] ?? "")) first--;
    const above = lines.slice(first);
    const rule = above.findIndex(isRule);
    const headings = rule >= 0 ? above.slice(0, rule) : above.slice(0, 1);
    return { kind: "row", words: [...headings, line].join("\n") };
  }
  const ends = [...all.slice(lineStart, start).matchAll(/[.!?;](?:\s|$)|[。！？；]/gu)];
  const last = ends.at(-1);
  const from = lineStart + (last?.index === undefined ? 0 : last.index + last[0].length);
  return { kind: "sentence", words: all.slice(from, end) };
}

export type MeasureFinding =
  | { kind: "same" }
  /** `shown`: the two measures as a reason names them; null when either can't be shown as written. */
  | { kind: "differs"; shown: { measured: string; claimed: string } | null }
  /** A bare cell of a table's row, and the reply names nothing for it: its table's headings decide. */
  | { kind: "unnamed" }
  /** Words the reply doesn't give, or that aren't where it says it copied them. */
  | { kind: "unread" };

/**
 * Whether a figure's source measures what the sentence's figure does. `sentence`: the texts the
 * sentence's words may come from (the sentence, its figure's label and context, its paragraph);
 * `quote`: the source quote; `passage`: the texts the quote is in, its cited pages first, read
 * only when the quote itself doesn't hold the words.
 */
export function measureFinding(
  measure: FigureMeasure | null,
  sentence: readonly string[],
  quote: string,
  passage: () => readonly string[],
): MeasureFinding {
  if (!measure) return { kind: "unread" };
  const said = measure.sentence;
  // A table cell's measure may join its row label and its caption ("生鲜食品 分部收入"): each piece
  // is the sentence's own words when its label, context or paragraph holds it.
  const pieces = said.split(/\s+/u).filter((piece) => /[\p{L}\p{N}]/u.test(piece));
  const own = (words: string) => sentence.some((text) => namedIn(text, words));
  const owned = namesSomething(said) && (own(said) || pieces.every(own));
  const quoted = measure.quote;
  // The first text that holds the quote decides, its cited pages before the rest of its Document:
  // a quote it holds twice is in no one place.
  let place: ReturnType<typeof placeOf> | undefined;
  const placed = () => {
    if (place !== undefined) return place;
    place = null;
    for (const text of passage()) {
      place = placeOf(text, quote);
      if (place !== null) break;
    }
    return place;
  };
  const around = (words: string): string[] => {
    const where = placed();
    return where !== null && where !== "ambiguous" && namedIn(where.words, words)
      ? [where.words]
      : [];
  };
  const found =
    quoted === null || !namesSomething(quoted)
      ? []
      : namedIn(quote, quoted)
        ? [quote]
        : around(quoted);
  // A measure the reply itself says differs backs nothing, whatever words it gives for either.
  if (measure.match === "differs") {
    const asWritten = (words: string, texts: readonly string[]) =>
      words.length <= SHOWN_CHARACTERS && texts.some((text) => holds(text, words));
    return {
      kind: "differs",
      shown:
        quoted !== null && owned && asWritten(quoted, found) && asWritten(said, sentence)
          ? { measured: quoted, claimed: said }
          : null,
    };
  }
  if (!owned) return { kind: "unread" };
  if (found.length > 0) return { kind: "same" };
  // Only a table's cell may name nothing of its own: a number in prose has its measure beside it.
  const where = quoted === null && !namesSomething(quote) ? placed() : null;
  return where !== null && where !== "ambiguous" && where.kind === "row"
    ? { kind: "unnamed" }
    : { kind: "unread" };
}
