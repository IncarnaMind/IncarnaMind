/**
 * What the calculator an Answer's model calls (./plainCalculator, #3393) shares with the Answer
 * engine, checks and Analyses: its limits, the language an Answer's figures are shown in, how a
 * Document or Note writes its numbers, and how a model's lists and markers are read.
 */

import {
  type FigureContext,
  type FigureFacts,
  figureContextOf,
  figureContextOfFacts,
  figureLanguageTag,
} from "../../shared/figures";
import { memoized } from "../../shared/memo";
import type { CalculatedFigure, Citation } from "../api";
import type { PageText } from "../documents/passages";
import { detectLanguage } from "../documents/textLanguage";
import type { Language } from "../language";

import type { AnswerDocuments, Quoted, QuoteInput } from "./citations";
import type { CiteOptions } from "./engine";

/** The most figures one call records. */
export const MAX_FIGURES_PER_CALL = 20;

/** How many times one Answer may call `calculate`; later calls are refused, so the model answers. */
export const MAX_CALLS_PER_ANSWER = 5;

export const FIX_FIGURES = "Fix these with another calculate call:";

/** Whether what `calculate` told the model asks it to fix figures, which the Tool loop must not end before. */
export const asksForFigureFixes = (told: string): boolean => told.includes(FIX_FIGURES);

/** The language an Answer to `question` is written in, and so its figures are shown in. */
export function answerLanguage(question: string): Language {
  return detectLanguage(question) === "Chinese" ? "zh-CN" : "en";
}

const LANGUAGE_SAMPLE = 20_000;

/**
 * How a Document version writes its numbers (its language, separators and
 * "¥"), from all of its Units' text: what an input's number is read with, and
 * read again with when it is checked.
 */
export function documentFigureContext(units: readonly { text: string }[]): FigureContext {
  const all = units.map((unit) => unit.text).join("\n");
  return figureContextOf(all, figureLanguageTag(detectLanguage(all.slice(0, LANGUAGE_SAMPLE))));
}

/** The language a Note's numbers are read in, told again only once its opening words change. */
const noteLanguage = memoized(
  4,
  (head: string) => head,
  (head: string) => figureLanguageTag(detectLanguage(head)),
);

/** What a Note's paragraphs, by Block, tell of how it writes its numbers. */
export interface NoteParagraphs {
  words: readonly string[];
  facts(language: string | null): readonly FigureFacts[];
}

/**
 * `documentFigureContext` of a Note's paragraphs, added up from each Block's: the whole Note is
 * read for its separators and language on every change to it (#746).
 */
export function partsFigureContext(blocks: readonly NoteParagraphs[]): FigureContext {
  const head: string[] = [];
  let length = 0;
  for (const words of blocks.flatMap((block) => block.words)) {
    if (length > LANGUAGE_SAMPLE) break;
    head.push(words);
    length += words.length + 1;
  }
  const language = noteLanguage(head.join("\n").slice(0, LANGUAGE_SAMPLE));
  return figureContextOfFacts(
    blocks.flatMap((block) => block.facts(language)),
    language,
  );
}

/** The one line a figure read from a scan's unsure word is refused with (#535). */
export const UNSURE_INPUT =
  "That number was read from a scan and may be misread; it can't be an input until the User confirms it.";

/** A whole number, as given or written as text ("2", "[^2]", "[=2]", "#2"). */
export function whole(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /^\s*\[?[\^=#]?\s*(\d{1,4})\s*\]?\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A list given as an array, as an array written in JSON, or as its one item alone, as some models send it. */
export function givenList(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      return givenList(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  return Object.keys(fields(value)).length > 0 ? [value] : [];
}

/** `value` times 10^`exponent`, without the noise of the multiplication. */
export const shifted = (value: number, exponent: number) =>
  exponent === 0 ? value : Number((value * 10 ** exponent).toPrecision(15));

/** A figure given in structured output that couldn't be worked out: what its one request to fix it shows. */
export interface FigureProblem {
  marker: number;
  /** The figure as the model gave it, as JSON. */
  given: string;
  problems: string[];
  /** The Passages its inputs name: their ids ("P3") and their text, as the model was given it. */
  passages: { id: string; text: string }[];
}

/** What the calculator needs of a Citation session (see `quotes` in ./citations). */
export interface CitationQuotes {
  recorded(marker: number): Quoted | null;
  quote(input: QuoteInput, options?: CiteOptions): Quoted | { problem: string };
  passageText(passage: string): string;
  /**
   * A line another Passage of the same Document holds, given the Unit it is in: kept as its own
   * Citation. A Passage the model wasn't shown can't be named with `quote` (#2365).
   */
  quoteIn(
    document: { documentId: string; contentHash: string },
    unit: PageText,
    quote: string,
  ): Quoted | { problem: string };
}

export interface CalculationSessionOptions {
  documents: Pick<AnswerDocuments, "pageTexts">;
  quotes: CitationQuotes;
  /** The Answer's language: results are written in it. */
  language: Language;
  /** A figure was recorded for a marker (again: it replaces the earlier one). */
  onRecord?(marker: number, figure: CalculatedFigure): void;
  /**
   * Whether a cell an input is read from takes part in its workbook's formulas, when the Answer
   * offers `what_if` (#2372): only then is a number written in beside it refused as a what-if.
   */
  partOfFormulas?(citation: Citation, sheet: string, ref: string): boolean;
}
