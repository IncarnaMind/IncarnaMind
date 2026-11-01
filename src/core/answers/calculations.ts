/**
 * Calculated figures (ADR-0021): the numbers an Answer works out from numbers
 * in Passages. The model never writes one itself. It calls `calculate` (in
 * structured output, it gives `calculations` in its JSON) with, for each
 * figure, a marker ("[=1]", written in its text where the number goes), its
 * inputs and a formula over their names (../../shared/formula). Each input is
 * a Citation (a record it gave `cite`, or a Passage, Location and quote) and
 * the number in that quote, named as it is written ("1.2亿") or by its
 * position. IncarnaMind checks the quote as the Citation check does, reads the
 * number with the figure reader (../../shared/figures), and does the
 * arithmetic. What it can't do is told to the model in one line, and nothing
 * is recorded for that figure:
 * - a number the quote doesn't have, or has twice;
 * - one the reader can read more than one way (its separator or sign, a
 *   range, points), until the model picks one of the readings it is offered;
 *   a "¥" that could be yuan or yen, until a `unitQuote` names the currency;
 * - a number with no currency or scale of its own where another line states one
 *   (a heading, "单位：万元", or an amount above it, "Sale price £385,000.00"),
 *   when the result depends on it, until the model gives that line as
 *   `unitQuote`: a unit is never guessed, a line states only full money amounts
 *   of two decimals below it in one statement block and table column, a Passage
 *   that names two currencies gives neither, and a Document that writes a
 *   currency next to a scale anywhere is refused;
 * - what the evaluator refuses: a syntax error, units that don't combine,
 *   division by zero;
 * - a formula that changes an amount's scale itself ("rev / 10000" for 万 to
 *   亿): inputs are in base units with their page's scale applied, so the
 *   figure would be 10,000 times too small (#577); `scale` shows it in 亿.
 * In a workbook, the formula uses the number a cell stores (#435), not the one
 * it shows rounded, in the scale its text writes ("+23,770m" over a stored
 * 23770, #1442). A deduction a statement writes in brackets is negative, so
 * a sum that subtracts it is recorded all the same, with a line telling the
 * model it adds (#978).
 */
import { MAX_INPUTS_PER_FIGURE } from "../../shared/calculatedFigures";
import {
  currencyOnItsFigure,
  currencyScaleMarker,
  type Figure,
  type FigureContext,
  type FigureFacts,
  figureContextOf,
  figureContextOfFacts,
  figureLanguageTag,
  namedCurrencies,
  type Reading,
  readFigures,
  readStatedUnits,
  type StatedCurrency,
} from "../../shared/figures";
import {
  evaluateFormula,
  FORMULA_VERSION,
  type FormulaInput,
  type FormulaProblem,
  type FormulaResult,
  formulaText,
  type ScaleChange,
  type ShowAs,
  sameNumber,
  scaleChanges,
  scaleWordOf,
  scaleWords,
  showResult,
  sumOf,
} from "../../shared/formula";
import {
  anchorsCovered,
  citationLocation,
  englishLocation,
  joinUnits,
  quoteInUnits,
} from "../../shared/locations";
import { memoized } from "../../shared/memo";
import { findQuote, type TextRange } from "../../shared/quoteMatch";
import { anchorsOf, cellNumber } from "../../shared/units";
import type {
  CalculatedFigure,
  Citation,
  FigureInput,
  FigureShowOptions,
  InputNumber,
} from "../api";
import { detectLanguage } from "../documents/textLanguage";
import type { Language } from "../language";
import {
  type AnswerDocuments,
  type Matching,
  type Quoted,
  type QuoteInput,
  quotePlaceProblem,
} from "./citations";
import type { CiteOptions } from "./engine";

/** Why a formula mustn't change an amount's scale, and how to show the figure in the scale meant. */
function scaleChangeProblem(change: ScaleChange, language: Language): string {
  const meant = (change.from?.exponent ?? 0) - change.exponent;
  const word = meant > 0 ? scaleWordOf(meant, language) : null;
  const applied = change.from?.word ? ` (${change.from.word} applied)` : "";
  const instead = `write ${change.amount} in place of ${change.text}`;
  const how = word
    ? `to show it in ${word}, give scale: "${word}" and ${instead}`
    : `${instead}, and give scale (${scaleWords(language).join(", ")}) for the scale it is shown in`;
  return `${change.text} changes the scale itself, but inputs are already in base units${applied}; ${how}.`;
}

/** The most figures one call records, and inputs one figure has. */
export const MAX_FIGURES_PER_CALL = 20;
export { MAX_INPUTS_PER_FIGURE } from "../../shared/calculatedFigures";

/** How many times one Answer may call `calculate`; later calls are refused, so the model answers. */
const MAX_CALLS_PER_ANSWER = 5;

const FIX_FIGURES = "Fix these with another calculate call:";

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

/** What reading a quote's figures needs of it: the quote, and the Units it cites. */
export type QuotedText = Pick<Quoted, "units"> & { citation: Pick<Quoted["citation"], "quote"> };

/** The whole lines of its cited Units that a quote is on; the quote itself when it isn't found there. */
export function quotedLines(quoted: QuotedText): string {
  const { quote } = quoted.citation;
  const ranges = quoteInUnits(quoted.units, quote);
  if (!ranges || ranges.length === 0) return quote;
  const { text } = joinUnits(quoted.units);
  const from = Math.min(...ranges.map((range) => range.start));
  const to = Math.max(...ranges.map((range) => range.end));
  const end = text.indexOf("\n", to);
  return text.slice(text.lastIndexOf("\n", from - 1) + 1, end < 0 ? text.length : end);
}

const beforeOnLine = (text: string, at: number) =>
  text.slice(text.lastIndexOf("\n", at - 1) + 1, at);

/** The most places of one quote looked at: more can't be told apart, and keep a line's start reading. */
const MOST_PLACES = 50;

function passageOn(page: string, passage: string, matching: Matching): TextRange | null {
  const found = passage === "" ? null : findQuote(page, passage, matching);
  const first = found?.[0];
  const last = found?.at(-1);
  return first && last ? { start: first.start, end: last.end } : null;
}

function placesOn(
  page: string,
  quote: string,
  own: TextRange | null,
  matching: Matching,
): TextRange[] {
  const from = own?.start ?? 0;
  const text = page.slice(from, own?.end ?? page.length);
  const places: TextRange[] = [];
  for (let at = 0; at < text.length && places.length < MOST_PLACES; ) {
    const found = findQuote(text.slice(at), quote, matching);
    const first = found?.[0];
    const last = found?.at(-1);
    if (!first || !last) break;
    places.push({ start: from + at + first.start, end: from + at + last.end });
    at += Math.max(last.end, 1);
  }
  return places;
}

/**
 * Where `quote` starts in `page`, and whether every place it is there starts after other text on its line:
 * the Passage's own places when its text is on the page, else the page's. `at` is -1 when it isn't there.
 */
export function quoteOnPage(
  page: string,
  quote: string,
  passage: string,
  matching: Matching = {},
): { at: number; midLine: boolean } {
  const places = placesOn(page, quote, passageOn(page, passage, matching), matching);
  const [first] = places;
  if (!first) return { at: page.indexOf(quote), midLine: false };
  return {
    at: first.start,
    midLine:
      places.length < MOST_PLACES &&
      places.every((place) => beforeOnLine(page, place.start).trim() !== ""),
  };
}

const writtenNumber = (reading: Reading) => reading.value / reading.scale;

/**
 * The unit cell of the row a quoted number is in ("收入	100	万元"), which states that row's unit;
 * null when its own row has none, or more than one. Another row's unit is never its own.
 */
function rowUnitCell(quote: string, at: number, context: FigureContext): string | null {
  const end = quote.indexOf("\n", at);
  const row = quote.slice(quote.lastIndexOf("\n", at - 1) + 1, end === -1 ? undefined : end);
  if (!row.includes("\t")) return null;
  const units = new Set(
    row
      .split("\t")
      .map((cell) => cell.trim())
      .filter((cell) => {
        if (!cell || /\d/.test(cell)) return false;
        const [only, ...more] = readStatedUnits(cell, context, true);
        return only?.chars === cell && more.length === 0;
      }),
  );
  return units.size === 1 ? ([...units][0] ?? null) : null;
}

/**
 * A quote's figure as `lines` read it, when they give it a unit or scale of its own: a sheet's
 * unit cell beside the number ("31000 | 万元"), which a quote of the number alone leaves out
 * (#1798). Null when they read it as the quote does, or read its digits more than one way.
 */
export function readOnItsLine(
  lines: string,
  figure: Figure,
  context: FigureContext,
): Figure | null {
  const own = (each: Reading) =>
    `${each.scale}:${each.unit.kind === "currency" ? each.unit.code : each.unit.kind}`;
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  // Only a scale or currency the quote lacks: a quote that reads "310000 GBP" knows more than its
  // row's bare "310000" cell.
  const adds = (each: Reading) =>
    (figure.scale === 1 && each.scale !== 1) ||
    (figure.unit.kind === "plain" && each.unit.kind === "currency");
  const found = readFigures(lines, context).filter(
    (each) => near(writtenNumber(each), writtenNumber(figure)) && adds(each),
  );
  const [first] = found;
  if (!first || !found.every((each) => own(each) === own(first))) return null;
  return first.unit.kind === "plain" ? { ...first, unit: figure.unit } : first;
}

const SHOW_AS: readonly ShowAs[] = ["number", "percent", "points", "currency", "times", "yes-no"];

/** An input as the model gave it. */
interface GivenInput {
  name: string;
  label: string;
  /** The marker of a record it gave `cite`. */
  citation: number | null;
  /** A quote of its own instead. */
  record: QuoteInput | null;
  number: string | null;
  position: number | null;
  unitQuote: string | null;
  reading: number | null;
  rate: string | null;
}

/** A figure as the model gave it. */
interface GivenFigure {
  marker: number | null;
  label: string;
  inputs: GivenInput[];
  formula: string;
  as: string | null;
  decimals: number | null;
  scale: string | null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : null;

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

function givenInput(value: unknown): GivenInput {
  const input = fields(value);
  const quote = text(input.quote);
  const passage = text(input.passage);
  return {
    name: text(input.name)?.trim() ?? "",
    label: text(input.label)?.trim() || text(input.name)?.trim() || "",
    citation: whole(input.citation),
    record:
      quote !== null || passage !== null
        ? {
            passage: passage ?? "",
            quote: quote ?? "",
            location: text(input.location),
            pageFrom: typeof input.pageFrom === "number" ? input.pageFrom : null,
            pageTo: typeof input.pageTo === "number" ? input.pageTo : null,
          }
        : null,
    // Some models call the number as written "value"; it is read from the quote all the same.
    number: text(input.number ?? input.value)?.trim() || null,
    position: whole(input.position),
    unitQuote: text(input.unitQuote)?.trim() || null,
    reading: whole(input.reading),
    rate: text(input.rate)?.trim() || null,
  };
}

function givenFigure(value: unknown): GivenFigure {
  const figure = fields(value);
  return {
    marker: whole(figure.marker),
    label: text(figure.label)?.trim() ?? "",
    inputs: givenList(figure.inputs).map(givenInput),
    formula: text(figure.formula)?.trim() ?? "",
    as: text(figure.as)?.trim() || null,
    decimals: typeof figure.decimals === "number" ? figure.decimals : whole(figure.decimals),
    scale: text(figure.scale)?.trim() || null,
  };
}

/** Text as numbers are compared: full-width as half-width, no spaces. */
const squeezed = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");

/**
 * Whether `named` is a figure's own digits written plainly, without its separators, sign, scale
 * or currency: "5704" for "£5,704m", as a model names a number it read.
 */
function writtenAs(figure: Figure, named: string): boolean {
  const plain = named.normalize("NFKC").trim();
  if (!/^\d+(?:\.\d+)?$/.test(plain)) return false;
  return sameNumber(Math.abs(figure.value) / figure.scale, Number(plain));
}

/** Whether `named` is in a figure's characters, not as part of a longer number. */
function namedIn(chars: string, named: string): boolean {
  const all = squeezed(chars);
  const part = squeezed(named);
  if (!/[\d〇零一二两三四五六七八九十百千万亿]/u.test(part)) return false;
  const digit = (char: string | undefined) => char !== undefined && /\d/.test(char);
  for (let at = all.indexOf(part); at >= 0; at = all.indexOf(part, at + 1)) {
    const end = at + part.length;
    const joinsBefore =
      digit(all[at - 1]) || (/[.,]/.test(all[at - 1] ?? "") && digit(all[at - 2]));
    const joinsAfter = digit(all[end]) || (/[.,]/.test(all[end] ?? "") && digit(all[end + 1]));
    if (!joinsBefore && !joinsAfter) return true;
  }
  return false;
}

/** "1 or 3", "1, 3 or 5". */
const either = (items: readonly (string | number)[]) =>
  items.length < 2
    ? String(items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} or ${String(items.at(-1))}`;

/** A number as a message to the model writes it: no float noise. */
const plainNumber = (value: number) => String(Number(value.toPrecision(12)));

const DEDUCTION_LINE =
  /(?:^|[\s|:：(（])(?:less|deduct(?:ion|ions|ed)?|minus|减|扣除|减去)(?![A-Za-z])/i;

function signNote(negatives: readonly { name: string; chars: string; value: number }[]): string {
  const them = negatives.length > 1 ? "them" : "it";
  const read = negatives
    .map((each) => `${each.name} is ${each.chars}, read as ${plainNumber(each.value)}`)
    .join("; ");
  return ` Check the sign: ${read}, so subtracting ${them} adds ${them}. To take a deduction off, add it (price + fee); if adding ${them} is what you meant, the figure stands.`;
}

/** One of the reader's readings, as the model is offered it. */
function readingText(reading: Reading): string {
  const { unit, value } = reading;
  switch (unit.kind) {
    case "percent":
      return `${plainNumber(value * 100)}%`;
    case "points":
      return `${plainNumber(value * 100)} percentage points`;
    case "currency":
      return `${unit.code} ${plainNumber(value)}`;
    case "times":
      return `${plainNumber(value)} times`;
    case "other":
      return `${plainNumber(value)} ${unit.word}`;
    default:
      return plainNumber(value);
  }
}

/** What a reading a model must choose between says about the figure. */
const UNSETTLED: Readonly<Record<string, (chars: string) => string>> = {
  separator: (chars) => `"${chars}" can be read two ways in this Document`,
  sign: (chars) => `"${chars}" may be negative`,
  range: (chars) => `"${chars}" is a range`,
  points: (chars) => `"${chars}" may be percentage points or another kind of points`,
};

/** `value` times 10^`exponent`, without the noise of the multiplication. */
const shifted = (value: number, exponent: number) =>
  exponent === 0 ? value : Number((value * 10 ** exponent).toPrecision(15));

/** The power of ten one value is of another: 4 for 15,234,056 over 1,523.4056. */
const exponentOf = (value: number, of: number) =>
  of === 0 || value === 0 ? 0 : Math.round(Math.log10(Math.abs(value / of)));

/**
 * The number a cell stores, as a reading of its text is worked in. A number format that writes the
 * scale as text ('+#,##0"m"') stores the number before it, 23770 for "+23,770m".
 */
function storedAs(reading: Reading, stored: number): number {
  const written = reading.scale === 1 ? 0 : exponentOf(reading.scale, 1);
  return written > 0 && exponentOf(reading.value, stored) === written
    ? shifted(stored, written)
    : stored;
}

/** A scale or unit stated apart from a number, and how the number reads under it. */
interface Stated {
  statement: string;
  reading: Reading;
}

/** An input as the core read it. */
interface ReadInput {
  given: GivenInput;
  quoted: Quoted;
  /** The cite record's marker it quotes from, or the quote it gave itself. */
  source: number | QuoteInput;
  figure: Figure;
  /** Its own reading, after the model's choice. */
  reading: Reading;
  /** Which of the reader's readings the model chose, from 1. */
  chosen: number | null;
  /** The reading under the line it gave as `unitQuote`, and that line's currency as written when a figure on it writes one. */
  unit: { quoted: Quoted; stated: Reading; currencyChars: string | null } | null;
  /** A scale its page states that would change its value; it isn't applied unless the result needs it. */
  candidate: Stated | null;
  cell: FigureInput["cell"];
  rate: { of: string; per: string } | null;
  /** Where its quote is, for messages: "p. 12". */
  where: string;
}

/** A figure recorded for its marker, with the quotes to check when the Answer ends. */
interface Recorded {
  figure: CalculatedFigure;
  /** What the model is told beside its result, if anything: how it is shown when not as asked. */
  note: string;
  /** The model was told to check a sign (#978): its next figure for the marker is the fix, not a marker given twice. */
  signAsked: boolean;
  /** Each input's quote, and its unit statement's, in order; `source`: its cite record's marker, or the quote it gave. */
  quotes: { input: Quoted; unit: Quoted | null; source: number | QuoteInput }[];
}

/** A figure given in structured output that couldn't be worked out: what its one request to fix it shows. */
export interface FigureProblem {
  marker: number;
  /** The figure as the model gave it, as JSON. */
  given: string;
  problems: string[];
  /** The Passages its inputs name: their ids ("P3") and their text, as the model was given it. */
  passages: { id: string; text: string }[];
}

/** What a calculation session needs of a Citation session (see `quotes` in ./citations). */
export interface CitationQuotes {
  recorded(marker: number): Quoted | null;
  quote(input: QuoteInput, options?: CiteOptions): Quoted | { problem: string };
  passageText(passage: string): string;
}

export interface CalculationSessionOptions {
  documents: Pick<AnswerDocuments, "pageTexts">;
  quotes: CitationQuotes;
  /** The Answer's language: results are written in it. */
  language: Language;
  /** A figure was recorded for a marker (again: it replaces the earlier one). */
  onRecord?(marker: number, figure: CalculatedFigure): void;
}

/** One Answer's calculated figures: what `calculate` takes, and the figures by marker. */
export function createCalculationSession(options: CalculationSessionOptions) {
  const { documents, quotes, language } = options;
  const recorded = new Map<number, Recorded>();
  const failed = new Map<number, FigureProblem>();
  let calls = 0;
  const contexts = new Map<string, FigureContext>();
  const scales = new Map<string, { scale: string | null; stale: boolean }>();

  /** How a Document version writes its numbers, read once from all its text. */
  const contextOf = (citation: Citation): FigureContext => {
    const key = `${citation.documentId}\n${citation.contentHash}`;
    let context = contexts.get(key);
    if (!context) {
      context = documentFigureContext(
        documents.pageTexts(citation.documentId, citation.contentHash, null, null),
      );
      contexts.set(key, context);
    }
    return context;
  };

  /**
   * The scale a Document version states anywhere, read once: a line the reader applies
   * ("in thousands", "单位：万元"), a currency next to a scale token ("£'000"), or a page's
   * running header kept from before it was stripped. `stale`: a page was read before this
   * build kept that marker, so a scale it wrote can't be ruled out (#1001).
   */
  const scaleOf = (citation: Citation): { scale: string | null; stale: boolean } => {
    const key = `${citation.documentId}\n${citation.contentHash}`;
    let found = scales.get(key);
    if (!found) {
      const units = documents.pageTexts(citation.documentId, citation.contentHash, null, null);
      const stated = readStatedUnits(
        units.map((unit) => unit.text).join("\n"),
        contextOf(citation),
      ).find((each) => each.scale !== 1);
      found = {
        scale:
          units.find((unit) => unit.scaleMarker)?.scaleMarker ??
          currencyScaleMarker(units.map((unit) => unit.text).join("\n")) ??
          stated?.chars ??
          null,
        stale: units.some((unit) => unit.scaleMarker === null),
      };
      scales.set(key, found);
    }
    return found;
  };

  /** Where a Citation's quote is, for messages: "p. 12", "Revenue, rows 3–4". */
  const whereOf = (quoted: Quoted): string => {
    const location = citationLocation(quoted.citation);
    return location ? englishLocation(location) : quoted.passage;
  };

  /** Why a quote can't be read from, by its check now; null when it is found. */
  function unreadable(quoted: Quoted, record: number | null): string | null {
    const { check, checkReason } = quoted.check();
    if (check === "found") return null;
    if (checkReason === "document-removed")
      return `${quoted.passage}'s Document was deleted; quote another Passage.`;
    if (check === "cant-check")
      return `${whereOf(quoted)} in ${quoted.passage} has no text to read a number from.`;
    return record === null
      ? `the quote isn't word for word at ${whereOf(quoted)} in ${quoted.passage}; copy it exactly.`
      : `[^${record}]'s quote isn't word for word where it cites; fix it with cite, or give passage, location and quote.`;
  }

  /** Whether an input's quote, recorded with cite or given inline, is where the check can't read it. */
  function onUnreadPage(given: GivenInput): boolean {
    const quoted =
      given.citation !== null
        ? quotes.recorded(given.citation)
        : given.record
          ? quotes.quote(given.record)
          : null;
    return quoted !== null && !("problem" in quoted) && quoted.check().check === "cant-check";
  }

  /** The quote an input reads from; or why it can't. */
  function quoteOf(
    given: GivenInput,
    options: CiteOptions,
  ): { quoted: Quoted; source: number | QuoteInput } | string {
    if (given.citation !== null) {
      const quoted = quotes.recorded(given.citation);
      if (!quoted)
        return `[^${given.citation}] isn't recorded; record it with cite first, or give passage, location and quote.`;
      return unreadable(quoted, given.citation) ?? { quoted, source: given.citation };
    }
    if (!given.record)
      return "give citation (the marker of a record you gave cite), or passage, location and quote.";
    const quoted = quotes.quote(given.record, options);
    if ("problem" in quoted) return quoted.problem;
    return unreadable(quoted, null) ?? { quoted, source: given.record };
  }

  /** The cell of a workbook's rows a figure of a quote is in, and the number the cell stores. */
  function cellOf(quoted: Quoted, figure: Figure, context: FigureContext): FigureInput["cell"] {
    const { units } = quoted;
    if (!units.some((unit) => unit.kind === "rows")) return null;
    const ranges = quoteInUnits(units, quoted.citation.quote);
    if (!ranges) return null;
    const cells = anchorsCovered(units, ranges).flatMap(({ unit, target }) => {
      const anchor = anchorsOf(unit).find((each) => each.target === target);
      if (!anchor) return [];
      return readFigures(unit.text.slice(anchor.start, anchor.end), context).map((found) => ({
        unit,
        ref: target,
        value: found.value,
      }));
    });
    const inQuote = readFigures(quoted.citation.quote, context);
    // A bracketed number's sign comes from the page around it, which a cell read alone lacks: the cell is found by its digits, and its stored number settles the sign.
    const close = (value: number) =>
      Math.abs(Math.abs(value) - Math.abs(figure.value)) <=
      1e-9 * Math.max(1, Math.abs(figure.value));
    let cell =
      cells.length === inQuote.length
        ? cells[inQuote.findIndex((each) => each.start === figure.start)]
        : undefined;
    if (!cell || !close(cell.value)) {
      const same = cells.filter((each) => close(each.value));
      cell = same.length === 1 ? same[0] : undefined;
    }
    if (!cell) return null;
    return {
      sheet: cell.unit.label?.sheet ?? null,
      ref: cell.ref,
      stored: cellNumber(cell.unit.label, cell.ref),
    };
  }

  /** How a figure of `quote` at `start` reads under a stated unit (`header`); null when it doesn't apply. */
  function statedReading(
    quote: string,
    start: number,
    context: FigureContext,
    header: string,
  ): Reading[] {
    const scaleReadings = (with_: FigureContext) =>
      readFigures(quote, with_)
        .find((each) => each.start === start)
        ?.ambiguous.find((each) => each.kind === "scale")?.readings ?? [];
    const own = scaleReadings({ ...context, header: null });
    const all = scaleReadings({ ...context, header });
    return all.slice(Math.max(1, own.length));
  }

  function onPage(quoted: Quoted): { text: string; at: number; midLine: boolean } {
    const { quote } = quoted.citation;
    const { text } = joinUnits(quoted.units);
    const { at, midLine } = quoteOnPage(text, quote, quoted.passageText, quoted.matching);
    return at < 0 ? { text: quote, at: 0, midLine } : { text, at, midLine };
  }

  function lineBefore(quoted: Quoted, figure: Figure): string {
    const { text, at } = onPage(quoted);
    return beforeOnLine(text, at + figure.start);
  }

  /** Whether `quote` is one statement row: a label, then `chars` as its last amount. */
  function statesAmount(quote: string, at: number, chars: string, context: FigureContext): boolean {
    const figures = readFigures(quote, { ...context, header: null });
    const last = figures.at(-1);
    return (
      last !== undefined &&
      last.start === at &&
      last.chars === chars &&
      /\p{L}/u.test(quote.slice(0, at)) &&
      /^[\s.,;:]*$/u.test(quote.slice(at + chars.length))
    );
  }

  /**
   * Why the line a model gave as `unitQuote` can't state the currency of `figure`: the two must
   * be full money amounts in one statement block below it, in its own table column, and the
   * Document must write no currency next to a scale anywhere (#1001).
   */
  function statementProblem(
    quoted: Quoted,
    unit: Quoted,
    line: StatedCurrency,
    figure: Figure,
    context: FigureContext,
  ): string | null {
    const passage = quoted.passageText;
    const statement = findQuote(passage, unit.citation.quote, unit.matching)?.[0];
    const place = findQuote(passage, quoted.citation.quote, quoted.matching)?.[0];
    if (!statement || !place)
      return `the unitQuote "${unit.citation.quote}" isn't word for word in ${quoted.passage}; copy the line that states the unit exactly, from the same Passage.`;
    const first = readFigures(unit.citation.quote, { ...context, header: null })[0];
    if (first?.decimals !== 2 || figure.decimals !== 2)
      return `the unitQuote "${unit.citation.quote}" and ${figure.chars} are not full money amounts with two decimals ("385,000.00"); a statement written in a scale can't pass as one.`;
    const bareAt = place.start + figure.start;
    const bareFrom = passage.lastIndexOf("\n", bareAt - 1) + 1;
    const bareEnd = passage.indexOf("\n", bareAt);
    const bareLine = passage.slice(bareFrom, bareEnd < 0 ? passage.length : bareEnd);
    const atInLine = bareAt - bareFrom;
    if (
      !statesAmount(unit.citation.quote, line.at, first.chars, context) ||
      !/\p{L}/u.test(bareLine.slice(0, atInLine)) ||
      !/^[\s.,;:]*$/u.test(bareLine.slice(atInLine + figure.chars.length))
    )
      return `the unitQuote "${unit.citation.quote}" and ${figure.chars} are not statement rows of a label and one amount; give the line and the number each as one row.`;
    if (place.start + figure.start <= statement.start + line.at)
      return `the unitQuote "${unit.citation.quote}" is not above ${figure.chars} in ${quoted.passage}; a statement states the currency of the bare numbers below it only.`;
    const oneBlock = quoted.units.some(
      (each) =>
        findQuote(each.text, unit.citation.quote, unit.matching) !== null &&
        findQuote(each.text, quoted.citation.quote, quoted.matching) !== null,
    );
    if (!oneBlock)
      return `the unitQuote "${unit.citation.quote}" and ${figure.chars} are not in one statement block in ${quoted.passage}; no page break may stand between them.`;
    const between = passage.slice(statement.start + unit.citation.quote.length, place.start);
    const rows = between.split("\n");
    if (
      rows.slice(1, -1).some((row) => row.trim() !== "" && !statesAmountRow(row, context)) ||
      (rows.length > 2 && rows.slice(1, -1).some((row) => row.trim() === ""))
    )
      return `the unitQuote "${unit.citation.quote}" and ${figure.chars} are not in one statement block: a blank line or a heading stands between them.`;
    const columnOf = (at: number) => passage.slice(passage.lastIndexOf("\n", at - 1) + 1, at);
    const tabs = (text: string) => text.split("\t").length - 1;
    const mine = columnOf(place.start + figure.start);
    const theirs = columnOf(statement.start + line.at);
    if ((theirs.includes("\t") || mine.includes("\t")) && tabs(theirs) !== tabs(mine))
      return `the unitQuote "${unit.citation.quote}" is not in the table column of ${figure.chars} in ${quoted.passage}; a table row's currency states only its own column.`;
    const ownScale = first.scale !== 1 || first.scaleWord !== null ? first.chars : null;
    const stated = scaleOf(quoted.citation);
    if (stated.stale)
      return `the unitQuote "${unit.citation.quote}" gives ${line.code}, but the Document was read by an older build that kept no scale marker; read it again before its amounts can state this number's unit.`;
    const scale = ownScale ?? stated.scale;
    if (scale)
      return `the unitQuote "${unit.citation.quote}" gives ${line.code}, but the Document states a scale ("${scale}"); quote the line that states both as unitQuote.`;
    return null;
  }

  /** Whether `row` is an intervening statement row: a label, then an amount that ends it. */
  function statesAmountRow(row: string, context: FigureContext): boolean {
    const figures = readFigures(row, { ...context, header: null });
    const last = figures.at(-1);
    return (
      last !== undefined &&
      /\p{L}/u.test(row.slice(0, last.start)) &&
      /^[\s.,;:]*$/u.test(row.slice(last.end))
    );
  }

  /** Reads one input; or says why it can't be read. */
  function readInput(
    given: GivenInput,
    options: CiteOptions = {},
    original?: Pick<InputNumber, "at" | "chars">,
  ): ReadInput | string {
    if (!given.name) return "give the input a name the formula uses, such as rev2024.";
    const source = quoteOf(given, options);
    if (typeof source === "string") return source;
    const { quoted } = source;
    const quote = quoted.citation.quote;
    let context = contextOf(quoted.citation);

    let unit: Quoted | null = null;
    let unitProblem: string | null = null;
    if (given.unitQuote) {
      const line = quotes.quote(
        { passage: quoted.passage, quote: given.unitQuote },
        { structured: true },
      );
      if ("problem" in line || line.check().check !== "found")
        unitProblem = `the unitQuote isn't word for word in ${quoted.passage}; copy the line that states the unit exactly, from the same Passage.`;
      else {
        const yen = figureContextOf(line.citation.quote, context.language).yen ?? context.yen;
        context = { ...context, yen };
        unit = line;
      }
    }

    const page = onPage(quoted);
    // A quote from the middle of a line ("…，88.0 和 91.5") starts with no list's or heading's number.
    // A sheet row's cells are numbers whatever they look like: "Gross profit	1922" holds no year.
    const cells = quoted.units.some((unit) => unit.kind === "rows");
    const quoteContext = { ...context, midLine: page.midLine, ...(cells && { dates: true }) };
    const contextProblem = quotePlaceProblem(quote, quoted.units, quoted.matching);
    if (contextProblem) return contextProblem;
    const figures = readFigures(quote, quoteContext);
    const has =
      figures.length === 0
        ? "it has no number"
        : `it has ${figures.map((each) => each.chars).join(", ")}`;
    let figure: Figure | undefined;
    if (original) {
      figure = figures.find((each) => each.start === original.at && each.chars === original.chars);
      if (!figure) return "the number is no longer at its recorded place in the quote.";
    } else if (given.position !== null) {
      figure = figures[given.position - 1];
      if (!figure) return `the quote has no number at position ${given.position}; ${has}.`;
    } else if (given.number !== null) {
      const named = given.number;
      const exact = figures.filter((each) => squeezed(each.chars) === squeezed(named));
      const inChars =
        exact.length > 0 ? exact : figures.filter((each) => namedIn(each.chars, named));
      const found = inChars.length > 0 ? inChars : figures.filter((each) => writtenAs(each, named));
      if (found.length === 0) return `the quote has no number "${named}"; ${has}.`;
      if (found.length > 1)
        return `"${named}" is in the quote ${found.length} times; give its position (${either(found.map((each) => figures.indexOf(each) + 1))}).`;
      figure = found[0];
    } else {
      return "give number, the number as it is written in the quote, or its position.";
    }
    if (!figure) return `the quote has no number "${given.number}"; ${has}.`;

    const currency = figure.ambiguous.find((each) => each.kind === "currency");
    if (currency) {
      const codes = currency.readings.flatMap((each) =>
        each.unit.kind === "currency" ? [each.unit.code] : [],
      );
      return `"${figure.chars}" could be ${either(codes)} here; quote the line that names its currency as unitQuote.`;
    }

    const cell = cellOf(quoted, figure, quoteContext);
    const base: Reading = figure;
    let reading: Reading = base;
    let chosen: number | null = null;
    const choices = figure.ambiguous.filter(
      (each) => each.kind !== "scale" && each.kind !== "currency",
    );
    if (choices.length > 1)
      return `"${figure.chars}" can't be read without guessing (${choices.map((each) => each.kind).join(", ")}); quote a place that writes it plainly.`;
    const [choice] = choices;
    if (choice) {
      const stored = cell?.stored ?? null;
      if (stored !== null && (choice.kind === "sign" || choice.kind === "separator")) {
        // The cell's stored number settles what its shown text doesn't.
        const nearest = choice.readings.reduce((best, each) =>
          Math.abs(each.value - storedAs(each, stored)) <
          Math.abs(best.value - storedAs(best, stored))
            ? each
            : best,
        );
        reading = nearest;
        chosen = choice.readings.indexOf(nearest) + 1;
      } else if (
        given.reading !== null &&
        given.reading >= 1 &&
        given.reading <= choice.readings.length
      ) {
        reading = choice.readings[given.reading - 1] as Reading;
        chosen = given.reading;
      } else {
        const lead = UNSETTLED[choice.kind]?.(figure.chars) ?? `"${figure.chars}" is unclear`;
        return `${lead}; give reading: ${choice.readings.map((each, index) => `${index + 1} for ${readingText(each)}`).join(", ")}.`;
      }
    }

    let stated: ReadInput["unit"] = null;
    let candidate: Stated | null = null;
    const ownUnit =
      figure.scaleWord !== null || (base.unit.kind !== "plain" && base.unit.kind !== "currency");
    // A heading's "(£)" changes no value but gives bare digits their currency, as a unitQuote's would.
    const changes = (each: Reading) =>
      each.value !== base.value || each.unit.kind !== base.unit.kind;
    // A row's unit cell in the quote itself ("收入	100	120	万元") states the unit of each number in
    // it, so the quote needs no unit line, and one that names its heading cell ("单位") is no matter.
    const inRow = ownUnit ? null : rowUnitCell(quote, figure.start, context);
    const ofRow = inRow
      ? statedReading(quote, figure.start, quoteContext, inRow).find(changes)
      : undefined;
    // A number that writes its own scale or unit ("4,979.6百万元") needs no unit line, so one
    // taken from another Passage doesn't stop it being read.
    if (unitProblem && !ownUnit && !ofRow) return unitProblem;
    // A row's unit cell beside the number ("31000 | 万元") states its unit as a heading does.
    const onLine = (line: string) => (ownUnit ? null : readOnItsLine(line, figure, context));
    if (ofRow) stated = { quoted, stated: ofRow, currencyChars: null };
    else if (unit && !ownUnit) {
      const row = onLine(unit.citation.quote);
      const statedLine = readStatedUnits(unit.citation.quote, context, true);
      // A statement may write its currency on its own first figure ("Sale price £385,000.00") instead of in a heading (#1001).
      const onFigure =
        row === null && statedLine.length === 0
          ? currencyOnItsFigure(unit.citation.quote, context)
          : null;
      if (!row && statedLine.length === 0 && !onFigure)
        return `the unitQuote "${unit.citation.quote}" states no unit or scale; give the line that does, such as "单位：万元" or "in millions".`;
      if (onFigure) {
        const problem = statementProblem(quoted, unit, onFigure, figure, context);
        if (problem) return problem;
        const named = namedCurrencies(
          quoted.passageText,
          context,
          readFigures(quoted.passageText, { ...context, header: null }),
        );
        if (named.size > 1)
          return `the unitQuote "${unit.citation.quote}" gives ${onFigure.code}, but ${whereOf(quoted)} names more than one currency (${[...named].join(", ")}); quote the line that applies, from a Passage that names one.`;
        stated = {
          quoted: unit,
          stated: { ...base, unit: { kind: "currency", code: onFigure.code } },
          currencyChars: onFigure.chars,
        };
      } else {
        const readings = row
          ? [row]
          : statedReading(quote, figure.start, quoteContext, unit.citation.quote);
        const scales = new Set(
          readings.filter((each) => each.scale !== 1).map((each) => each.scale),
        );
        if (scales.size > 1)
          return `the unitQuote "${unit.citation.quote}" states more than one scale; give the one line that applies.`;
        const applies =
          readings.find((each) => each.scale !== 1) ??
          readings.find((each) => each.unit.kind !== base.unit.kind) ??
          null;
        if (applies) stated = { quoted: unit, stated: applies, currencyChars: null };
      }
    } else if (!ownUnit) {
      const page = quoted.units.map((each) => each.text).join("\n");
      const found: Stated[] = [];
      const lines = quotedLines(quoted);
      const row = onLine(lines);
      if (row) found.push({ statement: lines, reading: row });
      const same = (a: Reading, b: Reading) =>
        a.value === b.value && JSON.stringify(a.unit) === JSON.stringify(b.unit);
      for (const statement of readStatedUnits(page, context)) {
        for (const each of statedReading(quote, figure.start, quoteContext, statement.chars)) {
          if (!changes(each)) continue;
          if (!found.some((other) => same(other.reading, each)))
            found.push({ statement: statement.chars, reading: each });
        }
      }
      if (found.length > 1)
        return `${figure.chars} has no unit, and ${whereOf(quoted)} states more than one (${found.map((each) => `"${each.statement}"`).join(", ")}); give the line that applies to it as unitQuote.`;
      candidate = found[0] ?? null;
    }

    let rate: ReadInput["rate"] = null;
    if (given.rate) {
      const match = /^([A-Z]{3}) per ([A-Z]{3})$/.exec(given.rate);
      const own = (stated?.stated ?? reading).unit;
      if (!match || match[1] === match[2])
        return `rate: write the currencies it converts as "CNY per USD", for so many yuan to the dollar.`;
      if (own.kind !== "plain" && !(own.kind === "currency" && own.code === match[1]))
        return `rate: an exchange rate is a number with no unit, or an amount in ${match[1]}; "${figure.chars}" isn't.`;
      rate = { of: match[1] as string, per: match[2] as string };
    }

    return {
      given,
      source: source.source,
      quoted,
      figure,
      reading,
      chosen,
      unit: stated,
      candidate,
      cell,
      rate,
      where: whereOf(quoted),
    };
  }

  /**
   * The number an input gives the formula: its reading, under a stated unit
   * (`under`) when one applies, with a workbook cell's stored number in place
   * of the one it shows.
   */
  function numberOf(input: ReadInput, under: Reading | null): FormulaInput & { reading: Reading } {
    const { figure, reading, cell } = input;
    const scaleBy = under ? exponentOf(under.value, figure.value) : 0;
    const shown = under
      ? { ...under, value: shifted(reading.value, scaleBy), decimals: reading.decimals }
      : reading;
    const stored = cell?.stored == null ? null : storedAs(reading, cell.stored);
    const value =
      stored === null ? shown.value : shifted(stored, exponentOf(shown.value, reading.value));
    return {
      name: input.given.name,
      value,
      scale: shown.scale,
      scaleWord: shown.scaleWord,
      unit: input.rate ? { kind: "rate", ...input.rate } : shown.unit,
      decimals: shown.decimals,
      approximate: figure.approximate,
      reading: shown,
    };
  }

  function inputRecord(read: ReadInput, number: FormulaInput & { reading: Reading }): FigureInput {
    return {
      name: read.given.name,
      label: read.given.label,
      citation: read.quoted.citation,
      number: {
        chars: read.figure.chars,
        at: read.figure.start,
        value: number.value,
        scale: number.scale,
        scaleWord: number.scaleWord,
        unit: number.unit,
        decimals: number.decimals,
        approximate: number.approximate,
        reading: read.chosen,
      },
      cell: read.cell,
      unitStatement: read.unit
        ? {
            citation: read.unit.quoted.citation,
            scale: read.unit.stated.scale,
            scaleWord: read.unit.stated.scaleWord,
            currency: read.unit.stated.unit.kind === "currency" ? read.unit.stated.unit.code : null,
            currencyChars: read.unit.currencyChars,
          }
        : null,
    };
  }

  function checkedNumber(read: ReadInput): FigureInput {
    const input = inputRecord(read, numberOf(read, read.unit?.stated ?? null));
    const unit = input.unitStatement;
    return {
      ...input,
      citation: { ...input.citation, ...read.quoted.check() },
      unitStatement:
        unit && read.unit
          ? { ...unit, citation: { ...unit.citation, ...read.unit.quoted.check() } }
          : unit,
    };
  }

  const sameValue = (a: FormulaResult["value"], b: FormulaResult["value"]) =>
    typeof a === "number" && typeof b === "number"
      ? Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b))
      : a === b;

  /** Works out one figure: what to record, or the lines that say why it can't be. */
  function work(
    given: GivenFigure,
    marker: number,
    options: CiteOptions,
  ): { recorded: Recorded } | { problems: string[] } {
    const lead = `[=${marker}]`;
    if (given.inputs.length === 0)
      return {
        problems: [
          `${lead}: give its inputs, each a number in a quote, and a formula over their names.`,
        ],
      };
    if (given.inputs.length > MAX_INPUTS_PER_FIGURE)
      return { problems: [`${lead}: at most ${MAX_INPUTS_PER_FIGURE} inputs in one figure.`] };
    if (!given.formula)
      return { problems: [`${lead}: give a formula over the inputs' names, such as (b - a) / a.`] };
    if (given.as !== null && !SHOW_AS.some((each) => each === given.as))
      return { problems: [`${lead}: as must be one of ${SHOW_AS.join(", ")}.`] };

    const reads: ReadInput[] = [];
    const problems: string[] = [];
    for (const input of given.inputs) {
      const read = readInput(input, options);
      if (typeof read === "string") problems.push(`${lead} ${input.name || "input"}: ${read}`);
      else reads.push(read);
    }
    if (problems.length > 0) return { problems };

    const numbers = (scaled: boolean) =>
      reads.map((read) =>
        numberOf(read, read.unit?.stated ?? (scaled ? (read.candidate?.reading ?? null) : null)),
      );
    const affected = reads.filter((read) => read.candidate !== null);
    if (affected.length > 0) {
      const plain = evaluateFormula(given.formula, numbers(false));
      const scaled = evaluateFormula(given.formula, numbers(true));
      const depends =
        plain.ok && scaled.ok ? !sameValue(plain.value, scaled.value) : plain.ok !== scaled.ok;
      if (depends)
        return {
          problems: affected.map(
            (read) =>
              `${lead} ${read.given.name}: ${read.figure.chars} has no unit, and ${read.where} says "${read.candidate?.statement}"; give that line as unitQuote.`,
          ),
        };
    }

    const inputs = numbers(false);
    const result: FormulaResult | FormulaProblem = evaluateFormula(given.formula, inputs);
    if (!result.ok) return { problems: [`${lead}: ${result.message}`] };
    const changes = scaleChanges(given.formula, inputs);
    if (changes.length > 0)
      return {
        problems: changes.map((change) => `${lead}: ${scaleChangeProblem(change, language)}`),
      };
    const sum = sumOf(given.formula);
    const nameIs = (name: string, other?: string) => name.toLowerCase() === other?.toLowerCase();
    const totalValue = inputs.find((input) => nameIs(input.name, sum?.total))?.value ?? -1;
    const negatives = reads.flatMap((read, index) => {
      const number = inputs[index];
      const deducted = sum?.taken.some((name) => nameIs(name, read.given.name));
      const line = lineBefore(read.quoted, read.figure);
      return totalValue >= 0 && deducted && number && number.value < 0 && DEDUCTION_LINE.test(line)
        ? [{ name: number.name, chars: read.figure.chars, value: number.value }]
        : [];
    });
    let show: FigureShowOptions = {
      language,
      as: SHOW_AS.find((each) => each === given.as) ?? null,
      decimals: given.decimals,
      scale: given.scale,
    };
    let shown = showResult(result, show);
    let note = negatives.length > 0 ? signNote(negatives) : "";
    // A result that can't be shown as asked (a difference of percents "as a percent") is shown in
    // its own unit, which is the right one, rather than refused.
    if (!shown.ok && show.as !== null) {
      const own = showResult(result, { ...show, as: null });
      if (own.ok) note += ` It is shown in its own unit: ${shown.message}`;
      show = { ...show, as: null };
      shown = own;
    }
    if (!shown.ok) return { problems: [`${lead}: ${shown.message}`] };

    const figure: CalculatedFigure = {
      label: given.label,
      formula: given.formula,
      inputs: reads.map((read, index) =>
        inputRecord(read, inputs[index] as FormulaInput & { reading: Reading }),
      ),
      value: result.value,
      unit: result.unit,
      approximate: result.approximate,
      shown: shown.shown,
      show,
      literals: result.literals,
      engine: FORMULA_VERSION,
      written: null,
    };
    return {
      recorded: {
        figure,
        note,
        signAsked: negatives.length > 0,
        quotes: reads.map((read) => ({
          input: read.quoted,
          unit: read.unit?.quoted ?? null,
          source: read.source,
        })),
      },
    };
  }

  /** What the model is told a recorded figure came to: "[=1] = 20.4% (Revenue growth: $1,482.6 million ÷ $1,231.0 million − 1)". */
  function told(marker: number, figure: CalculatedFigure): string {
    const byName = new Map(figure.inputs.map((input) => [input.name.toLowerCase(), input]));
    const worked = formulaText(
      figure.formula,
      (name) => byName.get(name.toLowerCase())?.number.chars ?? null,
    );
    return `Recorded [=${marker}] = ${figure.shown} (${figure.label ? `${figure.label}: ` : ""}${worked}).`;
  }

  /** Takes figures; returns what to tell the model about them. */
  function calculate(list: readonly unknown[], { structured = false }: CiteOptions = {}): string {
    if (!structured && ++calls > MAX_CALLS_PER_ANSWER)
      return "You have called calculate enough for this Question: write the Answer now with the figures recorded, and say which numbers couldn't be calculated rather than working them out.";
    if (list.length === 0)
      return `Nothing was recorded. ${FIX_FIGURES}\n- give each figure with its marker, inputs and formula.`;
    if (list.length > MAX_FIGURES_PER_CALL)
      return `Nothing was recorded. ${FIX_FIGURES}\n- At most ${MAX_FIGURES_PER_CALL} figures in one call, and ${MAX_INPUTS_PER_FIGURE} inputs in one figure.`;
    const lines: string[] = [];
    const problems: string[] = [];
    for (const raw of list) {
      const given = givenFigure(raw);
      const { marker } = given;
      if (marker === null || marker < 1) {
        problems.push("A figure needs a marker number (1, 2, …) that is in the Answer as [=n].");
        continue;
      }
      const earlierFigure = recorded.get(marker)?.figure;
      if (earlierFigure?.analysis !== undefined || earlierFigure?.workbook !== undefined) {
        problems.push(
          `[=${marker}] belongs to ${earlierFigure.analysis ? "an Analysis" : "a workbook's formulas"}. Keep that marker for its result; choose a new marker for this calculation.`,
        );
        continue;
      }
      const outcome = work(given, marker, { structured });
      if ("problems" in outcome) {
        problems.push(...outcome.problems);
        if (structured)
          failed.set(marker, {
            marker,
            given: JSON.stringify(raw),
            problems: outcome.problems,
            passages: [
              ...new Set(
                given.inputs.map((input) =>
                  input.citation !== null
                    ? (quotes.recorded(input.citation)?.passage ?? "")
                    : (input.record?.passage ?? ""),
                ),
              ),
            ].flatMap((id) => {
              const passage = quotes.passageText(id);
              return passage ? [{ id, text: passage }] : [];
            }),
          });
        continue;
      }
      const earlier = recorded.get(marker);
      recorded.set(marker, outcome.recorded);
      failed.delete(marker);
      options.onRecord?.(marker, outcome.recorded.figure);
      lines.push(
        told(marker, outcome.recorded.figure) +
          outcome.recorded.note +
          (earlier &&
          !earlier.signAsked &&
          earlier.figure.formula !== outcome.recorded.figure.formula
            ? ` It replaces the earlier [=${marker}] = ${earlier.figure.shown}: give each figure a marker of its own.`
            : ""),
      );
    }
    const done = lines.length > 0 ? lines.join("\n") : "Nothing was recorded.";
    const next =
      problems.length > 0
        ? `\n${FIX_FIGURES}\n- ${problems.join("\n- ")}`
        : "\nWrite each marker in its number's place, in the text or a table's cell, as in \"grew [=1] in 2025\": it shows the number with its unit, so write neither beside it.";
    return `${done}${next}`;
  }

  return {
    calculate,

    /**
     * A number in a quote, read as an input of `calculate` is, for an
     * Analysis (#447): checked now, as the Analysis runs on it now. A number
     * with no unit of its own where its page states one needs that line as
     * `unitQuote`: alone, its scale always matters.
     */
    number(raw: unknown): { input: FigureInput } | { problem: string; pageUnread?: true } {
      const given = givenInput(raw);
      const read = readInput(given);
      if (typeof read === "string")
        return { problem: read, ...(onUnreadPage(given) && { pageUnread: true as const }) };
      if (read.candidate && !read.unit) {
        return {
          problem: `${read.figure.chars} has no unit, and ${read.where} says "${read.candidate.statement}"; give that line as unitQuote.`,
        };
      }
      return { input: checkedNumber(read) };
    },

    /** Reads the saved UTF-16 span again; it is never an ordinal among a quote's numbers. */
    recheck(input: FigureInput): { input: FigureInput } | { problem: string } {
      const location = citationLocation(input.citation);
      const read = readInput(
        givenInput({
          name: input.name,
          label: input.label,
          passage: input.citation.passageId,
          quote: input.citation.quote,
          ...(location && { location: englishLocation(location) }),
          unitQuote: input.unitStatement?.citation.quote,
          reading: input.number.reading,
          ...(input.number.unit.kind === "rate" && {
            rate: `${input.number.unit.of} per ${input.number.unit.per}`,
          }),
        }),
        {},
        input.number,
      );
      if (typeof read === "string") return { problem: read };
      const current = checkedNumber(read);
      if (
        current.citation.documentId !== input.citation.documentId ||
        current.citation.contentHash !== input.citation.contentHash ||
        JSON.stringify(current.number) !== JSON.stringify(input.number) ||
        JSON.stringify(current.cell) !== JSON.stringify(input.cell) ||
        current.unitStatement?.citation.contentHash !== input.unitStatement?.citation.contentHash ||
        current.unitStatement?.scale !== input.unitStatement?.scale ||
        current.unitStatement?.currency !== input.unitStatement?.currency ||
        (current.unitStatement?.currencyChars ?? null) !==
          (input.unitStatement?.currencyChars ?? null)
      )
        return {
          problem: "the input or its Document has changed since this figure was calculated.",
        };
      return { input: current };
    },

    /** Records a figure an Analysis gave (#447) under the next marker no figure has: that marker. */
    record(figure: CalculatedFigure): number {
      const marker = Math.max(0, ...recorded.keys()) + 1;
      recorded.set(marker, { figure, note: "", signAsked: false, quotes: [] });
      options.onRecord?.(marker, figure);
      return marker;
    },

    /** The figures given in structured output that couldn't be worked out, by marker. */
    problems(): FigureProblem[] {
      return [...failed.values()].sort((a, b) => a.marker - b.marker);
    },

    /** Where a marker's figure's inputs quote from: a cite record's marker, or a quote given directly. */
    inputSources(marker: number): (number | QuoteInput)[] {
      return (recorded.get(marker)?.quotes ?? []).map((each) => each.source);
    },

    /** A marker's figure: "checking" until `check`, then with each input's check; null when none was recorded. */
    figure(marker: number): CalculatedFigure | null {
      return recorded.get(marker)?.figure ?? null;
    },

    /** Checks each figure's quotes, once, when the Answer finishes: the result is stored with each Citation. */
    check(): void {
      for (const entry of recorded.values()) {
        entry.figure = {
          ...entry.figure,
          inputs: entry.figure.inputs.map((input, index) => {
            const quotes = entry.quotes[index];
            if (!quotes) return input;
            const unit = input.unitStatement;
            return {
              ...input,
              citation: { ...input.citation, ...quotes.input.check() },
              unitStatement:
                unit && quotes.unit
                  ? { ...unit, citation: { ...unit.citation, ...quotes.unit.check() } }
                  : unit,
            };
          }),
        };
      }
    },
  };
}

export type CalculationSession = ReturnType<typeof createCalculationSession>;
