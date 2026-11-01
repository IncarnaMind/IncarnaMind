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
  const quoted = quote === null || quote === "" ? null : words(quote);
  if (said === null || (quoted === null && quote !== null && quote !== "")) return null;
  if (match !== "same" && match !== "differs") return null;
  return { sentence: said, quote: quoted, match };
}

/** Each word as compared: letters and digits in runs, a Han character on its own, case and width ignored. */
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

/** A table's row as text: its cells apart by tabs or bars. */
const isRow = (line: string): boolean => line.includes("\t") || /\S\s*\|\s*\S/.test(line);
const isRule = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes("-");

/**
 * The headings of the table whose row holds `quote` in `text`, and that row: the rows above a
 * Markdown table's rule, else its first row. Another row's label names another number. Null when
 * no row of a table holds the quote.
 */
function tableOf(text: string, quote: string): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => isRow(line) && holds(line, quote));
  if (at < 0) return null;
  let first = at;
  while (first > 0 && isRow(lines[first - 1] ?? "")) first--;
  const rule = lines.slice(first, at).findIndex(isRule);
  const headings = rule >= 0 ? lines.slice(first, first + rule) : lines.slice(first, first + 1);
  return [...headings, lines[at] ?? ""].join("\n");
}

/** Text as a quote is looked for in it: width, case and spaces aside, a line break inside a paragraph too. */
const flat = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s*\n\s*\n\s*/g, "\u2029")
    .replace(/\s+/g, " ");

/**
 * The words of `text` from the start of the sentence that holds `quote` to the quote's end: a
 * clause such as "up from £4,860.0m a year earlier" takes its measure from the words before it
 * ("Revenue was £4,983.4m, …"). Null when `text` doesn't hold the quote.
 */
function leadingTo(text: string, quote: string): string | null {
  const all = flat(text);
  const part = flat(quote).trim();
  const at = part === "" ? -1 : all.indexOf(part);
  if (at < 0) return null;
  const ends = [...all.slice(0, at).matchAll(/[.!?;](?:\s|$)|[。！？；\u2029]/gu)];
  const last = ends.at(-1);
  const start = last?.index === undefined ? 0 : last.index + last[0].length;
  return all.slice(start, at + part.length);
}

export type MeasureFinding =
  | { kind: "same" }
  /** `shown`: the two measures as a reason names them; null when either can't be shown as written. */
  | { kind: "differs"; shown: { measured: string; claimed: string } | null }
  /** The quote is a bare number and the reply names nothing for it: its table's headings decide. */
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
  const bare = !namesSomething(quote);
  const quoted = measure.quote;
  // A table's cell is named by its row label and its column's heading, which a quote of the cell
  // or its row may leave out; a clause, by its sentence's words before it. Words after the quote,
  // in another row or in another sentence, name another number. The first text that holds the
  // quote decides.
  const around = (words: string): string[] => {
    for (const text of passage()) {
      const place = tableOf(text, quote) ?? leadingTo(text, quote);
      if (place !== null) return namedIn(place, words) ? [place] : [];
    }
    return [];
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
  return quoted === null && bare ? { kind: "unnamed" } : { kind: "unread" };
}
