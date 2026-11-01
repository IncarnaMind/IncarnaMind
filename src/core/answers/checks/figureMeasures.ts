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

/** Which word of `text` `words` start at, word for word; null when `text` doesn't hold them. */
function placeIn(text: string, words: string): number | null {
  const all = wordsOf(text);
  const part = wordsOf(words);
  if (part.length === 0) return null;
  for (let at = 0; at + part.length <= all.length; at++) {
    if (part.every((word, index) => all[at + index] === word)) return at;
  }
  return null;
}

const holds = (text: string, words: string): boolean => placeIn(text, words) !== null;

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
 * The words as a reason shows them: a capital that only starts its sentence ("Revenue grew 12%")
 * is lower case in the middle of the reason's.
 */
function shown(words: string, texts: readonly string[]): string {
  const opens = texts.some((text) => placeIn(text, words) === 0);
  return opens && /^\p{Lu}\p{Ll}/u.test(words)
    ? words.charAt(0).toLowerCase() + words.slice(1)
    : words;
}

export type MeasureFinding =
  | { kind: "same" }
  /** `measured`: null when the quote is a bare number the reply names nothing for. */
  | { kind: "differs"; measured: string | null; claimed: string }
  /** The quote is a bare number and the reply names nothing for it: its table's headings decide. */
  | { kind: "unnamed" }
  /** Words the reply doesn't give, or that aren't where it says it copied them. */
  | { kind: "unread" };

/**
 * Whether a figure's source measures what the sentence's figure does. `sentence`: the texts the
 * sentence's words may come from (the sentence, its figure's label and context, its paragraph);
 * `quote`: the source quote; `passage`: the text around a bare quote, read only when it is one.
 */
export function measureFinding(
  measure: FigureMeasure | null,
  sentence: readonly string[],
  quote: string,
  passage: () => readonly string[],
): MeasureFinding {
  if (!measure) return { kind: "unread" };
  const said = measure.sentence;
  if (!namesSomething(said) || !sentence.some((text) => holds(text, said)))
    return { kind: "unread" };
  const bare = !namesSomething(quote);
  const quoted = measure.quote;
  if (quoted === null && !bare) return { kind: "unread" };
  if (quoted === null)
    return measure.match === "same"
      ? { kind: "unnamed" }
      : { kind: "differs", measured: null, claimed: shown(said, sentence) };
  const found = holds(quote, quoted)
    ? [quote]
    : bare
      ? passage().filter((text) => holds(text, quoted))
      : [];
  if (!namesSomething(quoted) || found.length === 0) return { kind: "unread" };
  if (measure.match === "same") return { kind: "same" };
  return { kind: "differs", measured: shown(quoted, found), claimed: shown(said, sentence) };
}
