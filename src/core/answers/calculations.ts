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
  type Figure,
  type FigureContext,
  type FigureFacts,
  type FigureUnit,
  figureContextOf,
  figureContextOfFacts,
  figureLanguageTag,
  markedFootnotes,
  namedCurrencies,
  pageScale,
  type Reading,
  readFigures,
  readStatedUnits,
  type StatedCurrency,
  type StatedUnit,
  scaleExponent,
  statesAmountScale,
  statesForWholeDocument,
  unsettledScales,
} from "../../shared/figures";
import {
  evaluateFormula,
  FORMULA_VERSION,
  type FormulaInput,
  type FormulaLiteral,
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
  unitLocation,
} from "../../shared/locations";
import { memoized } from "../../shared/memo";
import { misreadDigits, numberDigits } from "../../shared/misreadWords";
import { findQuote, type TextRange } from "../../shared/quoteMatch";
import { anchorsOf, cellNumber } from "../../shared/units";
import type {
  CalculatedFigure,
  Citation,
  FigureInput,
  FigureShowOptions,
  InputNumber,
} from "../api";
import type { PageText } from "../documents/passages";
import { mixedNumberWord, unsureSpansIn } from "../documents/scan/layout";
import { detectLanguage } from "../documents/textLanguage";
import type { Language } from "../language";
import { WORKBOOK_TOOLS } from "../tools";
import {
  type AnswerDocuments,
  type Matching,
  type Quoted,
  type QuoteInput,
  quotePlaceProblem,
  unsureWordsCovered,
} from "./citations";
import type { CiteOptions } from "./engine";
import { setAsideRowsOf } from "./sheetRows";

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

/** The one line a figure read from a scan's unsure word is refused with (#535). */
const UNSURE_INPUT =
  "That number was read from a scan and may be misread; it can't be an input until the User confirms it.";

/** The parts of a quote around its ellipses, with where each starts in it. */
function quoteParts(quote: string): TextRange[] {
  const parts: TextRange[] = [];
  let from = 0;
  for (const match of quote.matchAll(/(?:\.{3,}|…)/gu)) {
    const at = match.index ?? 0;
    if (at > from) parts.push({ start: from, end: at });
    from = at + match[0].length;
  }
  if (from < quote.length) parts.push({ start: from, end: quote.length });
  return parts;
}

const beforeOnLine = (text: string, at: number) =>
  text.slice(text.lastIndexOf("\n", at - 1) + 1, at);

/** The most lines above a number alone that its row's label is looked for in: a ten-year record. */
const MOST_LINES_UP = 12;

const WORDS = /[\p{L}%]/u;
/** A note's reference, as a column beside a row's amounts prints it: "12(a)", "Note 12". */
const NOTE_REF = /^(?:notes?\s*)?\d+(?:\.\d+)*\s*(?:\(?[a-z]\)?)?$/i;
// A number on its own; "m2" or "CO2" in a row head is part of its words.
const NUMBER = /(?<![\p{L}\d.,])\d[\d,.]*[)）%]?/u;
// A label: no figure and no sentence's end. "Earnings per share are shown in note 9." is prose.
const LABEL_LIKE = /^[^\d.。!?！？]{1,80}[^.。!?！？]?\s*$/u;

/** Whether every number on `line` is written as `chars` is, to the same decimal places: one column. */
function writtenLike(line: string, chars: string): boolean {
  const places = (each: string) => /\.(\d+)/.exec(each)?.[1]?.length ?? 0;
  const numbers = line.match(/\d[\d,.]*/g) ?? [];
  return numbers.length > 0 && numbers.every((each) => places(each) === places(chars));
}

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
  /** The numbers written in its formula that the model says are constants of the arithmetic, not supposed values. */
  constants: number[];
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
    constants: givenConstants(figure.constants),
  };
}

/** Numbers as written ("12", "5%", 0.05), alone or in a list. */
function givenConstants(value: unknown): number[] {
  const list = Array.isArray(value) || typeof value === "string" ? givenList(value) : [value];
  const written = list.length === 0 && typeof value === "string" ? [value] : list;
  return written.flatMap((each) => {
    const match = /^([-+]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec((text(each) ?? "").replace(/[\s,]/g, ""));
    if (!match) return [];
    const number = Number(match[1]);
    return [match[2] === "%" ? number / 100 : number];
  });
}

/** Text as numbers are compared: full-width as half-width, no spaces. */
// A footnote's mark is no digit of the figure (#2474): "1,240.50¹" and "1,240.50" are one number, "1,240.501" isn't.
const squeezed = (value: string) => markedFootnotes(value).normalize("NFKC").replace(/\s+/g, "");

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

/**
 * The inputs read from rows the file strikes through or hides (#1979), said after the figure: a
 * total over an earlier version's rows read as the sheet's current one. "" when none is.
 */
function setAsideNote(reads: readonly Pick<ReadInput, "given" | "quoted" | "cell">[]): string {
  const said = reads.flatMap((read) => {
    const row = Number(/\d+$/.exec(read.cell?.ref ?? "")?.[0]);
    const how =
      read.cell && Number.isInteger(row)
        ? setAsideRowsOf(read.quoted.units)(read.cell.sheet, row)
        : null;
    return how ? [`${read.given.name} is in row ${row}, which the file ${how}`] : [];
  });
  if (said.length === 0) return "";
  return ` ${said.join("; ")}: the file has set ${said.length === 1 ? "that row" : "those rows"} aside, so a figure from ${said.length === 1 ? "it" : "them"} is never the sheet's current one. Where you give this figure, say so.`;
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
  /**
   * Why no unitQuote can settle it: the scale is stated only in a running header or footer, or in
   * another part of the Document, which this Passage doesn't hold, or written in a form that reads
   * more than one way ("in MM").
   */
  unquotable?: "header" | "elsewhere" | "unsettled" | "noted" | "row" | "after" | "sheet";
  /** For one stated elsewhere: where. */
  where?: string;
  /** Stated in another Passage that may state it for this number too: the model may quote it (#2365). */
  quotable?: true;
}

/** A scale line in a Unit of a Document version: the line as written, the scale it states, and where the Unit is. */
interface ElsewhereScale {
  unit: PageText;
  /** The scale the reader found in it, as written ("£'000", "in thousands"). */
  statement: string;
  /** Its whole line, which the model quotes, and which says whether it holds for the whole Document. */
  line: string;
  where: string;
}

/** Why a line in a section that doesn't state the number's scale can't be its unitQuote. */
function sectionLineProblem(quote: string, chars: string): string {
  return `the unitQuote "${quote}" is in a section that doesn't state ${chars}'s scale; a scale line states only the numbers in its own section, or in a section that says it holds for the whole Document. Give the line above ${chars} in its own section as unitQuote, or one that says all amounts are in it.`;
}

/** Why a line on another page can't be the number's unitQuote. */
function pageLineProblem(quote: string, chars: string): string {
  return `the unitQuote "${quote}" is on another page, and it doesn't state ${chars}'s scale: a page's line states the numbers on its own page, or those after it only when it says it holds for the whole Document.`;
}

/** Why a line after the number can't be its unitQuote. */
function afterLineProblem(quote: string, chars: string): string {
  return `the unitQuote "${quote}" is after ${chars}; a scale line states the numbers under it, not those above it.`;
}

/** Why a caption in the number's own Unit can't be its unitQuote. */
function partLineProblem(quote: string, chars: string): string {
  return `the unitQuote "${quote}" names another table or note, and a line between it and ${chars} states none of its own; a line states only the numbers under it, in its own table or note. Quote the line above ${chars} in its table, or one that says all amounts are in it.`;
}

// A caption that binds its scale to a part: "Table 1", "Note 12", "this table", 表1, 本表.
const PART_NAMED =
  /\b(?:tables?|figures?|notes?|schedules?|exhibits?|annexes?|appendices)\s+\d+|\bthis\s+(?:table|note|schedule|figure|block)\b|(?:表|图|圖)\s*\d+|附(?:注|註|表|图|圖)\s*\d*|本(?:表|图|圖|附注|附註)|[上下](?:表|图|圖)/i;
const partNames = (text: string): string[] =>
  [...text.matchAll(new RegExp(PART_NAMED.source, "gi"))].map((match) =>
    (match[0] ?? "").replace(/\s+/g, " ").trim().toLowerCase(),
  );

/** Why a number with no unit of its own can't be calculated where its page states a scale. */
function candidateProblem(chars: string, where: string, candidate: Stated): string {
  if (candidate.unquotable === "sheet")
    return `${chars} has no unit, and its sheet's name ("${candidate.statement}") states a scale that no Passage quotes; it can't be calculated without guessing its scale.`;
  if (candidate.unquotable === "header")
    return `${chars} has no unit, and a running header or footer at ${where} states a scale ("${candidate.statement}") that no Passage quotes; it can't be calculated without guessing its scale.`;
  if (candidate.unquotable === "elsewhere")
    return `${chars} has no unit, and ${candidate.where || "another part of its Document"} states a scale ("${candidate.statement}") that ${where} doesn't; it can't be calculated without guessing whether that scale applies.`;
  if (candidate.unquotable === "noted")
    return `${chars} is on a per-share row, and "${candidate.statement}" scales its Document's amounts except where it notes otherwise; it can't be calculated without guessing its scale.`;
  if (candidate.unquotable === "unsettled")
    return `${chars} has no unit, and ${where} writes "${candidate.statement}", which can be read as more than one scale or unit; it can't be calculated without guessing its scale.`;
  if (candidate.unquotable === "row")
    return `${chars} is on a row whose head writes "${candidate.statement}", which may state a scale; it can't be calculated without guessing its scale.`;
  if (candidate.unquotable === "after")
    return `${chars} has no unit, and "${candidate.statement}" is below it; a scale line states the numbers under it, so it can't be ${chars}'s scale; it can't be calculated without guessing its scale.`;
  if (candidate.quotable)
    return `${chars} has no unit, and ${candidate.where ? `${candidate.where} states a scale ("${candidate.statement}") in another Passage of the same Document` : `another Passage of the same Document states a scale ("${candidate.statement}")`}; give that line as unitQuote.`;
  return `${chars} has no unit, and ${where} says "${candidate.statement}"; give that line as unitQuote.`;
}

// A per-share row names itself, or is a "Basic" or "Diluted" row under one; "Diluted shares" is a count.
const PER_SHARE = /per[- \u00a0]share|\bEPS\b|^\s*(?:basic|diluted)\b(?!.*\bshares?\b)|每股/i;
// A figure per unit of something, as a per-share figure is; "per annum" or "per month" is an amount.
const PER_UNIT =
  /\bper[- \u00a0](?:unit|user|customer|subscriber|member|tonne|ton|barrel|boe|ounce|oz|head|employee|room|passenger|vehicle|store|visit|order|kg|kilogram|litre|liter|mwh|kwh|square (?:foot|feet|metre|meter)|sq\.? ?(?:ft|m))\b|\bARPU\b|每吨|每单位|单位产品|人均|每户|每人|每平方米|每桶|每盎司/i;
// A row head's unit of measure, which no money scale applies to: "Capacity (MW)", "Sales (millions
// of m2)", "装机容量（兆瓦）". The measure may sit anywhere inside the bracket.
const MEASURE =
  "(?:[kMGT]Wh?|m2|m²|m3|m³|sq\\.? ?(?:m|ft)|km|kt|tonnes?|t|bbls?|boe|oz|kg|litres?|liters?|units|吨|万吨|千吨|平方米|立方米|兆瓦|千瓦|千瓦时|兆瓦时|公里|桶|盎司|千克|公斤)";
const MEASURE_HEAD = new RegExp(
  `[(（][^()（）\\n]{0,40}(?<![A-Za-z])${MEASURE}(?![A-Za-z])[^()（）\\n]{0,40}[)）]`,
  "i",
);
// A row head's bare "(M)" or "(m)": millions, metres or another scale, which the row doesn't settle.
const UNSETTLED_ROW_HEAD = /([(（]\s*[Mm]\s*[)）])/u;
const SHARE_COUNT = /\bshares\b|股数|普通股加权平均|加权平均股份/i;
const MISREAD_SCALE = /^(?:thousands?|millions?|billions?|trillions?)$/;

/** The unsure word in `units` that reads as a scale word once 0, 5 and 1 are taken as o, s and l. */
function misreadScaleWord(units: readonly PageText[]): string | null {
  for (const unit of units) {
    for (const [from, to] of unsureSpansIn(unit)) {
      const word = unit.text.slice(from, to);
      const lower = word.toLowerCase();
      const letters = lower.replace(/0/g, "o").replace(/5/g, "s").replace(/1/g, "l");
      if (letters !== lower && MISREAD_SCALE.test(letters)) return word;
    }
  }
  return null;
}

/** Whether `statement`'s exception ("in millions, except per share data") leaves out the number labelled `label`. */
function exceptedBy(statement: StatedUnit, label: string): boolean {
  if (statement.except !== "per-share" && statement.except !== "shares") return false;
  return PER_SHARE.test(label) || (statement.except === "shares" && SHARE_COUNT.test(label));
}

// Rows whose numbers aren't amounts a scale line applies to: a percent, a ratio or multiple, basis
// points, a count of shares, people or things, a year, a date or an identifier, and a per-share
// figure no exception leaves out. A share count is often in the line's millions, but not always.
const NOT_AN_AMOUNT: readonly [string, RegExp][] = [
  ["share count", SHARE_COUNT],
  ["percent", /%|per ?cent|percentage|\bmargin\b|百分比|率/i],
  ["ratio", /\bratio\b|\(x\)|\btimes\b|\bmultiple\b|倍/i],
  ["basis points", /\bbps\b|basis points|基点/i],
  [
    "count",
    /\bemployees\b|\bheadcount\b|\bstaff\b|\bcount\b|\bnumber of\b|\bunits\b|\bcustomers\b|\bstores\b|人数|员工|数量|门店|户数|家数/i,
  ],
  [
    "year or date",
    /^\s*(?:(?:financial |fiscal )?year|date)\s*$|\byear (?:founded|established|of incorporation)\b|\bdate\b|年份|日期/i,
  ],
  ["identifier", /\bID\b|\bcode\b|\bISIN\b|\bno\.|\bphone\b|\btel\b|编号|代码|电话/i],
];

// The words of an amount's row, which outweigh a kind's word beside them: "Staff costs", "Profit
// for the year", "Revenue from stores", 员工薪酬, 汇率变动的影响. A per-share row is still per share.
const AMOUNT_WORDS =
  /\b(?:profits?|income|revenues?|sales|turnover|costs?|expenses?|amounts?|dividends?|assets?|liabilit(?:y|ies)|equity|cash|debt|loans?|borrowings?|payables?|receivables?|inventor(?:y|ies)|tax(?:ation)?|charges?|fees?|capital|reserves?|provisions?|interest|depreciation|amorti[sz]ation|impairment|goodwill|deposits?|losse?s?|gains?|earnings|surplus|deficit|premiums?|claims?|accruals?|creditors|debtors|wages|salaries|remuneration|proceeds|payments?|investments?|property|plant|equipment|intangibles?|total)\b|收入|成本|费用|薪酬|利润|资产|负债|权益|现金|收益|款|金额|税|存货|准备|折旧|摊销|减值|商誉|股本|损失|利得|影响|支出|开支|余额|合计|总额/i;

// A percent, a multiple or a rate by its sign, or by the noun its label ends with, whatever amount
// it is of: "Return on equity (%)", "Net interest margin", 净资产收益率, "Debt ratio".
const RATE_ROW =
  /%|per ?cent|percentage|\bbps\b|basis points|基点|[(（]\s*(?:x|times|倍)\s*[)）]|(?:\bmargin|\bratio|\brate|\byield|\bmultiple|率|倍|比例)[\s:：)）]*$|\breturn on (?:equity|assets|capital|investments?|sales|revenue)\b|\b(?:interest|dividend|earnings) cover\b|\bgearing\b|\bnet debt to ebitda\b|\bcover\b[\s:：)）]*$|\bdays?\b[\s:：)）]*$/i;

// A price or a cost per unit, which a caption's money scale doesn't scale: "Average selling price
// (£)", "Closing share price (p)", "Unit cost (US$)".
const PRICE_ROW =
  /\b(?:average|unit|selling|closing|opening)\s+(?:selling\s+|unit\s+)?(?:share\s+)?(?:price|cost)\b|\bshare\s+price\b|\bpence\b/i;

// A currency's minor unit, by a word that means nothing else: "US cents", "pence", "港仙".
const MINOR_UNIT = "(?:[A-Z]{2,3}[ \\u00a0])?cents\\b|\\bpence\\b|¢|港仙|美分|便士";
// In a row head, "(US cents)", "(pence)", "（港仙）"; as a unit column's whole cell, "US cents".
const MINOR_UNIT_HEAD = new RegExp(
  `[(（][^()（）\\n]{0,20}?(${MINOR_UNIT})[^()（）\\n]{0,20}[)）]`,
  "iu",
);
const MINOR_UNIT_CELL = new RegExp(`^\\s*(?:${MINOR_UNIT})\\s*$`, "iu");
// A "(p)" that ends a row's label, or a "p" unit cell, is pence only in a table in pounds: "(P)"
// also writes Private in a name ("Sun (P) Ltd") (#2365).
const PENCE_HEAD = /[(（]\s*p\s*[)）]\s*[:：]?\s*$/i;
const PENCE_CELL = /^\s*p\s*$/i;

/** The kind of row `label` names that a scale line's amounts don't include, or null for an amount's. */
function notAnAmount(label: string): string | null {
  if (PER_SHARE.test(label)) return "per-share";
  if (PER_UNIT.test(label)) return "per-unit";
  if (MEASURE_HEAD.test(label)) return "unit of measure";
  if (PRICE_ROW.test(label)) return "price or unit cost";
  if (RATE_ROW.test(label)) return "percent, rate or multiple";
  // "Payment date", "付款日期", "Supplier ID": a date or an identifier, whatever it is of.
  if (/\bdates?\b|日期|\bID\b|\bISIN\b|\bphone\b|\btel\b|编号|代码|电话/i.test(label))
    return "date or identifier";
  if (AMOUNT_WORDS.test(label)) return null;
  return NOT_AN_AMOUNT.find(([, pattern]) => pattern.test(label))?.[0] ?? null;
}

// A row head's own scale word, inside a unit of measure's bracket: "Sales (millions of m2)".
const HEAD_SCALE =
  /\b(thousands?|millions?|billions?|trillions?|bn|mn|k|m)\b|(万亿|亿|千万|百万|十万|万|千|仟)/i;

const ROW_BRACKET = /[(（]([^()（）\n]{1,40})[)）]/g;

function rowScaleOf(label: string): { statement: string; exponent: number } | null {
  for (const bracket of label.normalize("NFKC").matchAll(ROW_BRACKET)) {
    const inside = bracket[1] ?? "";
    // A bare "(M)"/"(m)" stays unsettled: millions, metres or another scale.
    if (/^\s*[Mm]\s*$/.test(inside)) continue;
    const word = HEAD_SCALE.exec(inside)?.[0];
    const exponent = word ? scaleExponent(word) : 0;
    if (exponent > 0) return { statement: bracket[0], exponent };
  }
  return null;
}

// A bracket states the row's scale only when the whole bracket is one scale, in at most one
// currency: "(K)", "(£k)", "(thousands)", "(百万元)". "(m/s)" is a speed.
const WHOLE_BRACKET_SCALE =
  /^\s*(?:in\s+)?(?:(?:US\$|HK\$|A\$|C\$|S\$|NT\$|\$|€|£|¥|₹|USD|RMB|CNY|HKD|EUR|GBP|JPY|AUD|CAD|SGD|TWD|CHF|INR)\s*)?(?:'?000(?:'?s)?|thousands?|millions?|billions?|trillions?|bn|bln|mn|mln|[kKmMbB]|Mio\.?|Mrd\.?|Tsd\.?|(?:万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千|仟)(?:元)?)\s*$/i;
const BRACKET_SCALE_WORD =
  /'?000(?:'?s)?|\b(?:thousands?|millions?|billions?|trillions?|bn|bln|mn|mln|k|m|b)\b|Mio\.?|Mrd\.?|Tsd\.?|万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千|仟/i;

function wholeScaleBracket(text: string): { statement: string; exponent: number } | null {
  for (const bracket of text.normalize("NFKC").matchAll(ROW_BRACKET)) {
    if (!WHOLE_BRACKET_SCALE.test(bracket[1] ?? "")) continue;
    const word = BRACKET_SCALE_WORD.exec(bracket[1] ?? "")?.[0];
    const exponent = word ? scaleExponent(word) : 0;
    if (exponent > 0) return { statement: bracket[0], exponent };
  }
  return null;
}

/** One scale or currency a Unit writes, with its offset; a running header's marker is at 0. */
interface UnitScale {
  start: number;
  end: number;
  text: string;
  /** Its power of ten; 0 when it can't be settled. */
  scale: number;
  unit: FigureUnit | null;
  /** An unread currency-and-scale form ("(in £, thousands)"), not a statement. */
  unread?: boolean;
  /** A statement on a tab-separated sheet row, such as a column's currency head. */
  columnHead?: boolean;
}

const UNREAD_SCALE_WORDS =
  /\b(?:thousands?|millions?|billions?|trillions?|lakhs?|crores?|mn|bn|mln|bln|MM)\b|['’]0{3}s?|(?<![\d,'’])000s(?![A-Za-z0-9])/gi;
// Only separators, "in" and at most one currency code may stand between a currency and the scale
// word it states. The code slot is case-sensitive, so "per thousand" is not the amounts' scale.
const AFTER_CURRENCY =
  /^\s*[,;，；、]?\s*(?:in\s+)?(?:(?:US\$|HK\$|A\$|C\$|S\$|NT\$|[£$€¥₹]|[A-Z]{2,3})\s+)?(.*)$/;
const SCALE_AT_START =
  /^(?:'?000(?:'?s)?|000s|thousands?|millions?|billions?|trillions?|lakhs?|crores?|mn|bn|mln|bln|MM)\b/i;

// An unread form settles a scale only when it has exactly one scale word right after its
// currency, or is a × form with no scale word; any other form stays unsettled and refuses (#2365).
function unreadScaleExponent(form: string): number {
  const words = form.match(UNREAD_SCALE_WORDS) ?? [];
  const timesForm = /[×✕]/.test(form);
  if (timesForm ? words.length > 0 : words.length !== 1) return 0;
  if (!timesForm) {
    const currency = CURRENCY_IN_BRACKET.exec(form);
    if (!currency) return 0;
    const after = form.slice(currency.index + currency[0].length);
    if (!SCALE_AT_START.test(AFTER_CURRENCY.exec(after)?.[1] ?? "")) return 0;
  }
  const times =
    /[×✕]\s*(?:US\$|HK\$|A\$|C\$|S\$|NT\$|[£$€¥₹]|[A-Z]{3})?\s*(\d[\d,]*(?:\.\d+)?)/.exec(form) ??
    /\bunits?\s+of\s+(\d[\d,]*(?:\.\d+)?)/i.exec(form);
  const digits = times?.[1];
  if (digits !== undefined) {
    const power = Math.log10(Number(digits.replace(/,/g, "")));
    if (Number.isInteger(power) && power >= 1) return power;
    return 0;
  }
  return scaleExponent(words[0] ?? "");
}

const CURRENCY_IN_BRACKET =
  /(?:US\$|HK\$|A\$|C\$|S\$|NT\$|\$|€|£|¥|₹|\b(?:USD|RMB|CNY|HKD|EUR|GBP|JPY|AUD|CAD|SGD|TWD|CHF|INR)\b|(?:\b(?:US|U\.S\.|Hong\s+Kong|HK|Australian|Canadian|Singapore)\s+)?dollars?\b|\bpounds?(?:\s+sterling)?\b|\beuros?\b|\byuan\b|\b[Rr]enminbi\b|\bsterling\b|\byen\b)/;
const SCALE_FORM =
  /(?:\b(?:thousands?|millions?|billions?|trillions?|lakhs?|crores?|mn|bn|mln|bln|Mio|Mrd|Tsd)\b|['’]0{3}s?|(?<![\d,'’])000s(?![A-Za-z0-9])|[×✕]\s*|\bx\s*\d|\bunits?\s+of\s+\d)/i;
const BRACKET = /[(（]([^()（）\n]{1,60})[)）]/g;

function unreadCurrencyScales(
  text: string,
  statements: readonly StatedUnit[],
  context: FigureContext,
): UnitScale[] {
  const found: UnitScale[] = [];
  const covered = (from: number, to: number) =>
    statements.some(
      (each) => each.start <= from && from < each.end && each.start <= to && to < each.end,
    );
  const add = (form: string, at: number, end: number, currencyAt: number, scaleAt: number) => {
    if (covered(currencyAt, scaleAt)) return;
    const exponent = unreadScaleExponent(form);
    const [first, second] = [...namedCurrencies(form, context, null)];
    const code = first !== undefined && second === undefined ? first : null;
    found.push({
      start: at,
      end,
      text: form,
      scale: code === null || exponent === 0 ? 0 : 10 ** exponent,
      unit: code === null || exponent === 0 ? null : { kind: "currency", code },
      unread: true,
    });
  };
  for (const bracket of text.matchAll(BRACKET)) {
    const inside = bracket[1] ?? "";
    const currency = CURRENCY_IN_BRACKET.exec(inside);
    const scale = SCALE_FORM.exec(inside);
    if (!currency || !scale) continue;
    const at = bracket.index;
    add(bracket[0], at, at + bracket[0].length, at + 1 + currency.index, at + 1 + scale.index);
  }
  for (const line of text.matchAll(/[^\n]+/g)) {
    const bracket = BRACKET.exec(line[0]);
    BRACKET.lastIndex = 0;
    if (bracket && CURRENCY_IN_BRACKET.test(bracket[1] ?? "") && SCALE_FORM.test(bracket[1] ?? ""))
      continue;
    const currency = CURRENCY_IN_BRACKET.exec(line[0]);
    const scale = SCALE_FORM.exec(line[0]);
    if (!currency || !scale) continue;
    if (readFigures(line[0], { ...context, header: null }).length > 0) continue;
    const at = line.index;
    add(line[0], at, at + line[0].length, at + currency.index, at + scale.index);
  }
  return found;
}

/** Whether `statement` scales its amounts "except where noted", and `label` is a per-share row it may leave out. */
const notedOut = (statement: StatedUnit, label: string): boolean =>
  statement.except === "noted" && PER_SHARE.test(label);

/** A head row's statements that give a number different units or scales: "Revenue (£000)	EPS (£)". */
function conflicting(statements: readonly StatedUnit[]): boolean {
  // "币种：人民币" names the currency of every column, beside "单位：万元".
  const heads = statements.filter(
    (each) => !/^\s*(?:币种|幣種|currency)\s*[:：]/i.test(each.chars),
  );
  const unitOf = (each: StatedUnit) =>
    each.unit.kind === "plain" ? null : JSON.stringify(each.unit);
  return heads.some((a, at) =>
    heads.slice(at + 1).some((b) => {
      const [ua, ub] = [unitOf(a), unitOf(b)];
      if (ua !== null && ub !== null && ua !== ub) return true;
      // "Revenue ($000)	Shares (000s)": a count's column beside a currency's.
      if ((ua === null) !== (ub === null) && (ua === null ? a : b).scale !== 1) return true;
      if (a.scale !== b.scale && ((a.scale !== 1 && b.scale !== 1) || (ua !== null && ua === ub)))
        return true;
      return false;
    }),
  );
}

/**
 * A row's label without the scale statements in it, and the scales its head states for itself. A
 * page's statement with its exception before the row ("单位：千元，每股收益除外营业收入") leaves the words
 * after it; any other scale ("Net debt (£m)", "Revenue (£000) - UK", "收入（百万元）合计") is the row
 * head's, and the words around it stay. Taking a page's plain scale line for the row's own only
 * refuses a unitQuote of another scale, which is right either way. Its own unit ("Diluted EPS ($)", "基本每股收益（元）") stays
 * too, as it changes no scale.
 */
function withoutStatement(text: string): RowLabel {
  // A head's plain currency is its own statement of scale 1, which a wider scale line of another
  // scale doesn't override (#2365).
  const scales = readStatedUnits(text).filter(
    (each) => each.scale !== 1 || each.except || each.unit.kind === "currency",
  );
  const page = [
    ...[...text.matchAll(EXCEPTION_WORDS)].map((each) => ({
      start: each.index,
      end: each.index + each[0].length,
    })),
    ...scales.filter((each) => each.except),
  ];
  const own = scales.filter((each) => !page.includes(each));
  const from = Math.max(0, ...page.map((each) => each.end));
  let label = text.slice(from);
  for (const each of [...own].sort((a, b) => b.start - a.start)) {
    if (each.start >= from)
      label = `${label.slice(0, each.start - from)}${label.slice(each.end - from)}`;
  }
  if (!WORDS.test(label) && page.length > 0)
    label = text.slice(0, Math.min(...page.map((each) => each.start)));
  const unsettled = UNSETTLED_ROW_HEAD.exec(label.normalize("NFKC"));
  const ownBracket = rowScaleOf(label);
  const ownScales = own.map((each) => each.scale);
  if (
    ownBracket &&
    notAnAmount(label) !== "unit of measure" &&
    !ownScales.includes(10 ** ownBracket.exponent)
  )
    ownScales.push(10 ** ownBracket.exponent);
  const currencies = [
    ...new Set(
      own.flatMap((each) =>
        each.scale === 1 && each.unit.kind === "currency" ? [each.unit.code] : [],
      ),
    ),
  ];
  const [first, more] = currencies;
  const ownCurrency = first !== undefined && more === undefined ? first : null;
  const ownMinor = MINOR_UNIT_HEAD.exec(label)?.[1] ?? null;
  const ownPence = PENCE_HEAD.test(label);
  return {
    label,
    ownScales,
    ownCurrency,
    ownMinor,
    ownPence,
    ownUnsettled: unsettled?.[1] ?? null,
    ownBracket,
  };
}

/** A row's label, the scales its head states for itself ("Net debt (£m)"), and a bare "(M)"/"(m)" it writes. */
interface RowLabel {
  label: string;
  ownScales: number[];
  /** The one currency its head states with no scale ("Revenue (US$)"), which combines with a line's scale. */
  ownCurrency: string | null;
  /** The minor unit its head writes ("US cents", "pence", "港仙"), which no line's whole currency is. */
  ownMinor: string | null;
  /** Whether its label ends in "(p)", or its unit cell is "p": pence in a table in pounds. */
  ownPence: boolean;
  ownUnsettled: string | null;
  /** A scale inside the row head's own bracket ("(K)", "(millions of m2)"). */
  ownBracket: { statement: string; exponent: number } | null;
}

/** The whole line of `text` that `start`–`end` is on, trimmed. */
function lineOf(text: string, start: number, end: number): string {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const to = text.indexOf("\n", end);
  return text.slice(from, to < 0 ? undefined : to).trim();
}

/** The pieces of `text` between its numbers, a stated scale's digits ("£'000") kept whole. */
function betweenNumbers(text: string): string[] {
  const kept = readStatedUnits(text);
  const pieces: string[] = [];
  let from = 0;
  for (const match of text.matchAll(new RegExp(NUMBER.source, "gu"))) {
    if (kept.some((each) => each.start <= match.index && match.index < each.end)) continue;
    pieces.push(text.slice(from, match.index));
    from = match.index + match[0].length;
  }
  pieces.push(text.slice(from));
  return pieces;
}

// The words that end a scale statement's line: ", except per share data)", "，每股收益除外".
const EXCEPTION_WORDS =
  /except[^)\n]{0,40}?(?:shares?|noted|stated|indicated|shown|disclosed)[^)\n]{0,20}\)?|除[^外\n]{0,12}外|[^\s，,]{0,8}除外/gi;

/** A reading of `base` a thousand times over: a stand-in for a scale that can't be settled, to tell whether a result depends on it. */
const thousandfold = (base: Reading): Reading => ({
  ...base,
  value: base.value * 1000,
  scale: base.scale * 1000,
});

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
  /** Quotes a figure recorded whole is cited to: a workbook figure's cell (#2347). */
  cited?: readonly QuoteInput[];
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

/** What the model is told a recorded figure came to: "[=1] = 20.4% (Revenue growth: $1,482.6 million ÷ $1,231.0 million − 1)". */
export function toldFigure(marker: number, figure: CalculatedFigure): string {
  const byName = new Map(figure.inputs.map((input) => [input.name.toLowerCase(), input]));
  const worked = formulaText(
    figure.formula,
    (name) => byName.get(name.toLowerCase())?.number.chars ?? null,
  );
  return `Recorded [=${marker}] = ${figure.shown} (${figure.label ? `${figure.label}: ` : ""}${worked}).`;
}

/** One Answer's calculated figures: what `calculate` takes, and the figures by marker. */
export function createCalculationSession(options: CalculationSessionOptions) {
  const { documents, quotes, language } = options;
  const recorded = new Map<number, Recorded>();
  const failed = new Map<number, FigureProblem>();
  let calls = 0;
  const contexts = new Map<string, FigureContext>();
  const scales = new Map<string, { scale: string | null; stale: boolean }>();
  const unitScales = new Map<string, ElsewhereScale[]>();
  const unitLists = new Map<string, readonly PageText[]>();

  /** Every Unit of a Document version, in reading order, read once. */
  const unitsOf = (citation: Citation): readonly PageText[] => {
    const key = `${citation.documentId}\n${citation.contentHash}`;
    let found = unitLists.get(key);
    if (!found) {
      found = documents.pageTexts(citation.documentId, citation.contentHash, null, null);
      unitLists.set(key, found);
    }
    return found;
  };

  /**
   * Each Unit of a Document version that states a scale, read once: in its text, in a form that
   * reads more than one way, or in a running header or Word header kept beside it.
   */
  const scaledUnitsOf = (citation: Citation): ElsewhereScale[] => {
    const key = `${citation.documentId}\n${citation.contentHash}`;
    let found = unitScales.get(key);
    if (!found) {
      const context = contextOf(citation);
      found = unitsOf(citation).flatMap((unit) => {
        const stated = readStatedUnits(unit.text, context).find((each) => each.scale !== 1);
        const unsettled = stated ? null : (unsettledScales(unit.text, context)[0] ?? null);
        const marker =
          stated || unsettled
            ? null
            : unit.scaleMarker && !unit.text.includes(unit.scaleMarker)
              ? unit.scaleMarker
              : null;
        const statement = stated?.chars ?? unsettled ?? marker;
        if (!statement) return [];
        let line = statement;
        if (stated !== undefined) line = lineOf(unit.text, stated.start, stated.end);
        else if (unsettled !== null) {
          const at = unit.text.indexOf(unsettled);
          if (at >= 0) line = lineOf(unit.text, at, at + unsettled.length);
        }
        const location = unitLocation(unit);
        return [{ unit, statement, line, where: location ? englishLocation(location) : "" }];
      });
      unitScales.set(key, found);
    }
    return found;
  };

  /** The Unit of its Passage that holds `at`, an offset in the Passage's joined Units. */
  function unitAt(quoted: Quoted, at: number): PageText | null {
    const { starts } = joinUnits(quoted.units);
    let found: PageText | null = null;
    quoted.units.forEach((unit, index) => {
      if ((starts[index] ?? 0) <= at) found = unit;
    });
    return found;
  }

  /** The Unit of its Passage that holds `figure`, whose heading path a scale line in another Unit is judged against. */
  function unitOf(quoted: Quoted, figure: Figure): PageText | null {
    const { at } = onPage(quoted);
    return unitAt(quoted, at < 0 ? figure.start : at + figure.start);
  }

  function strictAncestor(other: PageText, number: PageText): boolean {
    const mine = number.label?.path ?? [];
    const theirs = other.label?.path ?? [];
    if (theirs.length === 0 || theirs.length >= mine.length) return false;
    return theirs.every((name, at) => name === mine[at]);
  }

  /**
   * Whether an ancestor heading's section still contains the number: it comes before it, and no
   * later heading of its own level reparents the number in between (#2365). A repeated parent
   * heading starts a new section, so an earlier one's scale doesn't reach across it.
   */
  function ancestorContains(
    units: readonly PageText[],
    ancestor: PageText,
    number: PageText,
  ): boolean {
    if (ancestor.page === null || number.page === null) return false;
    if (!strictAncestor(ancestor, number)) return false;
    const level = (ancestor.label?.path ?? []).length;
    const path = (unit: PageText) => (unit.label?.path ?? []).join("\u0000");
    const section = path(ancestor);
    for (const unit of units) {
      if (unit.page === null || unit.page <= ancestor.page || unit.page >= number.page) continue;
      const theirs = unit.label?.path ?? [];
      if (theirs.length !== level) continue;
      if (path(unit) === section && unit.label?.part !== undefined) continue;
      return false;
    }
    return true;
  }

  /**
   * Whether `line` and `number` are earlier and later parts of one heading section, split by
   * length, rather than two occurrences of a heading with the same text (#2365): a split
   * section's Units run 1, 2, 3… with the same path, and a repeated heading starts again at 1.
   */
  function sameSection(units: readonly PageText[], line: PageText, number: PageText): boolean {
    if (line.kind !== "section" || number.kind !== "section") return false;
    const from = line.page;
    const to = number.page;
    if (from === null || to === null || to <= from) return false;
    const path = (unit: PageText) => (unit.label?.path ?? []).join("\u0000");
    const section = path(line);
    if (section === "" || section !== path(number)) return false;
    if (number.label?.part === undefined) return false;
    return units.every((unit) => {
      if (unit.page === null || unit.page <= from || unit.page >= to) return true;
      return path(unit) === section && unit.label?.part !== undefined;
    });
  }

  function scalesInUnit(unit: PageText, context: FigureContext): UnitScale[] {
    const found: UnitScale[] = [];
    const statements = readStatedUnits(unit.text, context);
    const unread = unreadCurrencyScales(unit.text, statements, context);
    // An unread form reads its own currency and scale whole, so a statement inside it is part of
    // that form, not a separate plain scale ("Remuneration is shown in sterling, in thousands").
    for (const each of statements.filter(
      (one) => !unread.some((form) => form.start <= one.start && one.end <= form.end),
    )) {
      found.push({
        start: each.start,
        end: each.end,
        text: each.chars,
        scale: each.scale,
        unit: each.unit,
        columnHead: lineOf(unit.text, each.start, each.end).includes("\t"),
      });
    }
    for (const each of unsettledScales(unit.text, context)) {
      const at = unit.text.indexOf(each);
      if (at >= 0)
        found.push({ start: at, end: at + each.length, text: each, scale: 0, unit: null });
    }
    for (const each of unread) found.push(each);
    if (unit.scaleMarker && !unit.text.includes(unit.scaleMarker)) {
      const [stated] = readStatedUnits(unit.scaleMarker, context);
      found.push({
        start: 0,
        end: 0,
        text: unit.scaleMarker,
        scale: stated?.scale ?? 0,
        unit: stated?.unit ?? null,
      });
    }
    return found.sort((a, b) => a.start - b.start);
  }

  function statementOf(line: string, context: FigureContext): UnitScale | null {
    const [first] = readStatedUnits(line, context).filter((each) => each.unit.kind !== "percent");
    return first
      ? {
          start: first.start,
          end: first.end,
          text: first.chars,
          scale: first.scale,
          unit: first.unit,
        }
      : null;
  }

  const currencyOf = (unit: FigureUnit | null) => (unit?.kind === "currency" ? unit.code : null);

  /** Whether a nearer statement gives the figure a different scale or currency from the quoted line's. */
  function refutes(scale: UnitScale, from: UnitScale | null): boolean {
    if (scale.unit?.kind === "percent") return false;
    if (scale.scale === 0) return true;
    if (!from) return scale.scale !== 1;
    // A sheet's currency-only column head ("Amount (US$)") combines with a wider plain scale;
    // every other nearer currency and wider scale pair conflicts (#2365).
    const plainCurrency = (each: UnitScale) => each.scale === 1 && each.unit?.kind === "currency";
    const plainScale = (each: UnitScale) =>
      each.scale !== 1 && (each.unit === null || each.unit.kind === "plain");
    if (scale.columnHead && plainCurrency(scale) && plainScale(from)) return false;
    return scale.scale !== from.scale || currencyOf(scale.unit) !== currencyOf(from.unit);
  }

  interface LinePlace {
    lineIndex: number;
    figureIndex: number;
    lineStart: number;
    lineEnd: number;
    figureAt: number;
    lineText: string;
  }

  function placeOf(
    quoted: Quoted,
    figure: Figure,
    lineUnit: PageText,
    lineText: string,
    numbersUnit: PageText,
  ): LinePlace | null {
    const units = unitsOf(quoted.citation);
    const indexOf = (each: PageText) =>
      units.findIndex(
        (other) => other === each || (other.page !== null && other.page === each.page),
      );
    const lineIndex = indexOf(lineUnit);
    const figureIndex = indexOf(numbersUnit);
    if (lineIndex < 0 || figureIndex < 0) return null;
    const range = findQuote(lineUnit.text, lineText, quoted.matching)?.[0] ?? null;
    if (!range) return null;
    const at = quoted.units.indexOf(numbersUnit);
    if (at < 0) return null;
    const { starts } = joinUnits(quoted.units);
    const figureAt = onPage(quoted).at + figure.start - (starts[at] ?? 0);
    if (figureAt < 0) return null;
    return {
      lineIndex,
      figureIndex,
      lineStart: range.start,
      lineEnd: range.end,
      figureAt,
      lineText,
    };
  }

  /**
   * The statement nearer to the figure than the quoted line, between it and the figure, that gives
   * a different scale or currency: in the figure's own Unit before the figure, in a later part of
   * its section, in a section or page between, or in the rest of a section the line is in. A line
   * after the figure never states it (#2365).
   */
  function nearerScale(
    quoted: Quoted,
    figure: Figure,
    place: LinePlace,
    units: readonly PageText[],
    numbersUnit: PageText,
  ): string | null {
    const context = contextOf(quoted.citation);
    const from = statementOf(place.lineText, context);
    // A row label's own currency ("Basic EPS ($)") is the row's, not a nearer line, even when the
    // label is on the line above the number.
    const rowLabel = rowOf(quoted, figure)?.label ?? null;
    const path = (unit: PageText) => (unit.label?.path ?? []).join("\u0000");
    for (let index = place.lineIndex; index <= place.figureIndex; index++) {
      const unit = units[index];
      if (!unit) continue;
      const inLine = index === place.lineIndex;
      const inFigure = index === place.figureIndex;
      // A page keeps its later lines to itself: they state a table below the line, not a figure on
      // a later page. A section's later lines can state a figure further down (#2365).
      if (inLine && !inFigure && unit.kind === "page") continue;
      if (!inLine && !inFigure) {
        const section =
          numbersUnit.kind === "section" &&
          unit.kind === "section" &&
          (strictAncestor(unit, numbersUnit) ||
            (path(unit) === path(numbersUnit) &&
              (unit.label?.part ?? 1) < (numbersUnit.label?.part ?? 1)));
        const page =
          unit.kind === "page" &&
          numbersUnit.kind === "page" &&
          unit.page !== null &&
          numbersUnit.page !== null &&
          unit.page < numbersUnit.page;
        if (!section && !page) continue;
      }
      const figureRow = inFigure
        ? unit.text.lastIndexOf("\n", Math.max(0, place.figureAt - 1)) + 1
        : -1;
      for (const scale of scalesInUnit(unit, context)) {
        if (inLine && scale.start < place.lineEnd) continue;
        if (inFigure && scale.start > place.figureAt) continue;
        // The figure's own row states its own unit ("Diluted EPS ($)"), not a nearer line, and so
        // does any other row that writes an amount: a row's unit states that row, not the next.
        if (inFigure && scale.start >= figureRow) continue;
        if (rowLabel !== null && scale.text !== "" && rowLabel.includes(scale.text)) continue;
        // An unread form ("(in £, thousands)", "(× €1,000)") is judged whether or not its line
        // writes a figure; a settled statement on a figure's line is that figure, not a scale line.
        if (
          !scale.unread &&
          readFigures(lineOf(unit.text, scale.start, scale.end), { ...context, header: null })
            .length > 0
        )
          continue;
        if (refutes(scale, from)) return scale.text;
      }
    }
    return null;
  }

  type LineVerdict = { ok: true } | { ok: false; problem: string };

  interface LineFacts {
    unit: PageText | null;
    text: string;
    inPassage: boolean;
    unsure: boolean;
  }

  /**
   * Whether a quoted line may state the figure's scale, and if not why (#2365, #2386): it must be
   * before the figure, in the figure's own Unit, a later part of its own heading section, a
   * strict ancestor section that says it holds for the whole Document, or an earlier page that
   * says so. An unsure word, a named note or table, a line after the figure and a nearer statement
   * of another scale or currency each refuse; everything else is refused by default.
   */
  function judgeLine(quoted: Quoted, figure: Figure, facts: LineFacts, chars: string): LineVerdict {
    if (facts.unsure)
      return {
        ok: false,
        problem: `the unitQuote "${facts.text}" may include a word the scan misread; quote a line that states the unit clearly.`,
      };
    const numbersUnit = unitOf(quoted, figure);
    if (!numbersUnit || !facts.unit)
      return {
        ok: false,
        problem: `the unitQuote "${facts.text}" can't be placed in ${quoted.passage}; quote the line as it is written there.`,
      };
    const units = unitsOf(quoted.citation);
    const place = placeOf(quoted, figure, facts.unit, facts.text, numbersUnit);
    if (!place)
      return {
        ok: false,
        problem: `the unitQuote "${facts.text}" can't be placed in ${quoted.passage}; quote the line as it is written there.`,
      };
    if (
      place.lineIndex > place.figureIndex ||
      (place.lineIndex === place.figureIndex && place.lineStart > place.figureAt)
    )
      return { ok: false, problem: afterLineProblem(facts.text, chars) };
    const sameSectionLine =
      place.lineIndex === place.figureIndex || sameSection(units, facts.unit, numbersUnit);
    // A caption naming its own table or note states only the rows under it, up to the next line
    // that has no amount; a later table's rows take their own line or none. The whole line that
    // holds the quote is judged, so a fragment of "Table 1 … (in thousands)" carries its caption (#2365).
    const lineFrom = facts.unit.text.lastIndexOf("\n", place.lineStart - 1) + 1;
    const lineBreak = facts.unit.text.indexOf("\n", place.lineEnd);
    const lineTo = lineBreak < 0 ? facts.unit.text.length : lineBreak;
    const caption = facts.unit.text.slice(lineFrom, lineTo);
    if (
      PART_NAMED.test(caption) &&
      facts.unit.text === numbersUnit.text &&
      place.figureAt > lineTo
    ) {
      const context = contextOf(quoted.citation);
      const between = facts.unit.text
        .slice(lineTo, place.figureAt)
        .split("\n")
        .slice(1, -1)
        .filter((line) => line.trim() !== "");
      // A CJK page joins its rows into one line: a caption in the figure's own line prefix
      // that names another part refuses too (#2365).
      const named = partNames(caption);
      const figureLine = facts.unit.text.lastIndexOf("\n", place.figureAt - 1) + 1;
      const other = partNames(
        facts.unit.text.slice(Math.max(lineFrom, figureLine), place.figureAt),
      ).find((name) => !named.includes(name));
      if (other !== undefined || between.some((line) => !statesAmountRow(line, context)))
        return { ok: false, problem: partLineProblem(caption.trim(), chars) };
    }
    if (!sameSectionLine) {
      if (numbersUnit.kind === "section") {
        if (
          !ancestorContains(units, facts.unit, numbersUnit) ||
          !statesForWholeDocument(facts.text)
        )
          return { ok: false, problem: sectionLineProblem(facts.text, chars) };
      } else if (numbersUnit.kind === "page") {
        if (
          facts.unit.kind !== "page" ||
          facts.unit.page === null ||
          numbersUnit.page === null ||
          facts.unit.page >= numbersUnit.page ||
          !statesForWholeDocument(facts.text)
        )
          return { ok: false, problem: pageLineProblem(facts.text, chars) };
      } else if (!facts.inPassage) {
        return { ok: false, problem: sectionLineProblem(facts.text, chars) };
      }
    }
    const nearer = nearerScale(quoted, figure, place, units, numbersUnit);
    if (nearer !== null)
      return {
        ok: false,
        problem: `the unitQuote "${facts.text}" is a wider line, but a nearer line states a scale ("${nearer}"); quote the nearer line, or one that applies to ${chars}.`,
      };
    return { ok: true };
  }

  /** The Unit of `unit`'s Passage that holds its quoted line. */
  function lineUnitOf(unit: Quoted): PageText | null {
    return (
      unit.units.find((each) => findQuote(each.text, unit.citation.quote, unit.matching)) ?? null
    );
  }

  /**
   * The statements of `unit`'s quote that state amounts' scale, each judged in the whole Unit that
   * holds the quote: "单位：万" quoted from "单位：万头营业收入…" writes 头 beside its scale.
   */
  function amountStatements(unit: Quoted, statements: readonly StatedUnit[]): StatedUnit[] {
    const quote = unit.citation.quote;
    const lineUnit = lineUnitOf(unit);
    const range = lineUnit ? findQuote(lineUnit.text, quote, unit.matching)?.[0] : undefined;
    const text = lineUnit?.text ?? "";
    const offset = range && text.slice(range.start, range.end) === quote ? range.start : null;
    return statements.filter((each) =>
      offset === null
        ? statesAmountScale(quote, each)
        : statesAmountScale(text, { ...each, start: each.start + offset, end: each.end + offset }),
    );
  }

  /** A row's minor unit: its head's or unit column's own word, or its "(p)" in a table in pounds. */
  function minorUnitOf(
    row: RowLabel | null,
    quoted: Quoted,
    context: FigureContext,
    line: readonly StatedUnit[],
  ): string | null {
    if (!row) return null;
    if (row.ownMinor !== null) return row.ownMinor;
    if (!row.ownPence) return null;
    const inPounds =
      line.some((each) => each.unit.kind === "currency" && each.unit.code === "GBP") ||
      namedCurrencies(
        quoted.passageText,
        context,
        readFigures(quoted.passageText, { ...context, header: null }),
      ).has("GBP");
    return inPounds ? "pence" : null;
  }

  /**
   * A scale line in the figure's own Unit that the figure may take though the model quoted
   * another line: judged as a quoted line is, and every line between it and the figure must be an
   * amount's, so a line for another table or a line below the figure never applies (#2365).
   */
  function appliesScaleLine(quoted: Quoted, figure: Figure, line: string): Quoted | null {
    const built = quotes.quote({ passage: quoted.passage, quote: line }, { structured: true });
    if ("problem" in built) return null;
    const check = built.check();
    if (check.check !== "found" && check.checkReason !== "unsure-word") return null;
    const numbersUnit = unitOf(quoted, figure);
    const lineUnit = lineUnitOf(built);
    if (!numbersUnit || !lineUnit || lineUnit.text !== numbersUnit.text) return null;
    const place = placeOf(quoted, figure, lineUnit, line, numbersUnit);
    if (!place || place.figureAt <= place.lineEnd) return null;
    const context = contextOf(quoted.citation);
    const between = lineUnit.text
      .slice(place.lineEnd, place.figureAt)
      .split("\n")
      .slice(1, -1)
      .filter((row) => row.trim() !== "");
    // A CJK page joins its rows into one line: a caption in the figure's own line prefix
    // that names another part refuses too (#2365).
    const named = partNames(line);
    const figureLine = lineUnit.text.lastIndexOf("\n", place.figureAt - 1) + 1;
    const other =
      named.length === 0
        ? undefined
        : partNames(lineUnit.text.slice(figureLine, place.figureAt)).find(
            (name) => !named.includes(name),
          );
    if (other !== undefined || between.some((row) => !statesAmountRow(row, context))) return null;
    const verdict = judgeLine(
      quoted,
      figure,
      { unit: lineUnit, text: line, inPassage: true, unsure: check.checkReason === "unsure-word" },
      figure.chars,
    );
    return verdict.ok ? built : null;
  }

  /**
   * The scale lines in other Units of `figure`'s Document: those that may state its scale too,
   * and those that a note, a nearer line, a scan or the line's shape keep to themselves.
   */
  function elsewhereScales(
    quoted: Quoted,
    figure: Figure,
  ): { quotable: ElsewhereScale[]; refused: ElsewhereScale[] } {
    const pages = new Set(quoted.units.map((unit) => unit.page));
    const quotable: ElsewhereScale[] = [];
    const refused: ElsewhereScale[] = [];
    for (const each of scaledUnitsOf(quoted.citation)) {
      if (pages.has(each.unit.page)) continue;
      const ranges = findQuote(each.unit.text, each.line, quoted.matching) ?? [];
      const unsure = unsureWordsCovered([each.unit], ranges).length > 0;
      const verdict = judgeLine(
        quoted,
        figure,
        { unit: each.unit, text: each.line, inPassage: false, unsure },
        figure.chars,
      );
      (verdict.ok ? quotable : refused).push(each);
    }
    return { quotable, refused };
  }

  /**
   * The Unit another Passage holds that writes `line` and may state `figure`'s scale; or the
   * first reason a line found elsewhere can't. The figure's own Unit, not the quote's first,
   * decides where it sits: a Citation may name two Units.
   */
  function unitQuoteElsewhere(
    quoted: Quoted,
    figure: Figure,
    line: string,
  ): { quoted: Quoted } | { problem: string } | null {
    let problem: string | null = null;
    for (const unit of unitsOf(quoted.citation)) {
      if (unit.page !== null && quoted.units.some((each) => each.page === unit.page)) continue;
      if (!findQuote(unit.text, line, quoted.matching)) continue;
      const built = quotes.quoteIn(quoted.citation, unit, line);
      if ("problem" in built) {
        problem ??= built.problem;
        continue;
      }
      const check = built.check();
      const verdict = judgeLine(
        quoted,
        figure,
        {
          unit: lineUnitOf(built),
          text: line,
          inPassage: false,
          unsure: check.checkReason === "unsure-word",
        },
        figure.chars,
      );
      if (verdict.ok) return { quoted: built };
      problem ??= verdict.problem;
    }
    return problem ? { problem } : null;
  }

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
   * scale marker: its PDF running header or Word header, or a form that reads two ways ("in MM",
   * #2365). `stale`: a page was read before this build kept that marker, so a scale it wrote
   * can't be ruled out (#1001).
   */
  const scaleOf = (citation: Citation): { scale: string | null; stale: boolean } => {
    const key = `${citation.documentId}\n${citation.contentHash}`;
    let found = scales.get(key);
    if (!found) {
      const units = documents.pageTexts(citation.documentId, citation.contentHash, null, null);
      found = {
        scale:
          units.find((unit) => unit.scaleMarker)?.scaleMarker ??
          pageScale(units.map((unit) => unit.text).join("\n"), contextOf(citation)),
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
    // A scan's unsure words don't stop the page being read: the number itself is refused below (#535).
    if (checkReason === "unsure-word") return null;
    if (checkReason === "document-removed")
      return `${quoted.passage}'s Document was deleted; quote another Passage.`;
    if (check === "cant-check")
      return `${whereOf(quoted)} in ${quoted.passage} has no text to read a number from.`;
    return record === null
      ? `the quote isn't word for word at ${whereOf(quoted)} in ${quoted.passage}; copy it exactly.`
      : `[^${record}]'s quote isn't word for word where it cites; fix it with cite, or give passage, location and quote.`;
  }

  /**
   * The word a scan may have misread that a figure of the quote lies in (#535);
   * null when it lies in none. A number read from one isn't an input until
   * the User has checked the page.
   */
  function unsureWordAt(quoted: Quoted, figure: Figure): string | null {
    const quote = quoted.citation.quote;
    const ranges = quoteInUnits(quoted.units, quote, quoted.matching);
    const first = ranges?.[0];
    if (!ranges || !first) return null;
    // The quote's parts around an ellipsis match its ranges in order: the figure lies in one of them.
    const parts = quoteParts(quote);
    const pairs =
      ranges.length === 1
        ? [{ part: { start: 0, end: quote.length }, range: first }]
        : ranges.length === parts.length
          ? parts.map((part, index) => ({ part, range: ranges[index] as TextRange }))
          : [];
    const pair = pairs.find(({ part }) => figure.start >= part.start && figure.end <= part.end);
    if (!pair) {
      // The parts can't be paired where they should be: refuse a figure the quote's unsure words hold.
      return (
        unsureWordsCovered(quoted.units, ranges).find(
          (word) => word.includes(figure.chars) || figure.chars.includes(word),
        ) ?? null
      );
    }
    const from = pair.range.start + (figure.start - pair.part.start);
    const to = pair.range.start + (figure.end - pair.part.start);
    const { starts } = joinUnits(quoted.units);
    for (const [index, unit] of quoted.units.entries()) {
      const offset = starts[index] ?? 0;
      for (const [wordFrom, wordTo] of unsureSpansIn(unit)) {
        if (offset + wordFrom < to && offset + wordTo > from) {
          return unit.text.slice(wordFrom, wordTo);
        }
      }
    }
    return null;
  }

  /**
   * Whether `number` is what one of the quote's unsure words reads as (#535). The
   * figure reader finds no number in "7a;45o", so the word itself has to say.
   */
  function readsFromUnsureWord(quoted: Quoted, number: string): boolean {
    // The model may name the number as the page reads it ("7a;45o") or as it means it ("7,450").
    const readings = new Set([numberDigits(number), misreadDigits(number)]);
    readings.delete("");
    return (quoted.check().unsure ?? []).some(
      (word) => mixedNumberWord(word) && readings.has(misreadDigits(word)),
    );
  }

  /** Whether an input's quote, recorded with cite or given inline, is where the check can't read it. */
  function onUnreadPage(given: GivenInput): boolean {
    const quoted =
      given.citation !== null
        ? quotes.recorded(given.citation)
        : given.record
          ? quotes.quote(given.record)
          : null;
    if (quoted === null || "problem" in quoted) return false;
    const check = quoted.check();
    // A scan's unsure word is no unread page: the number itself is refused above (#535).
    return check.check === "cant-check" && check.checkReason !== "unsure-word";
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

  /** How a figure of `quote` at `start` reads under a stated unit (`header`); none when it doesn't apply. */
  function statedReading(
    quote: string,
    start: number,
    context: FigureContext,
    header: string,
  ): Reading[] {
    const readings =
      readFigures(quote, { ...context, header })
        .find((each) => each.start === start)
        ?.ambiguous.find((each) => each.kind === "scale")?.readings ?? [];
    return readings.filter((each) => each.statedIn === "header" || each.statedIn === "both");
  }

  function onPage(quoted: Quoted): { text: string; at: number; midLine: boolean } {
    const { quote } = quoted.citation;
    const { text } = joinUnits(quoted.units);
    const { at, midLine } = quoteOnPage(text, quote, quoted.passageText, quoted.matching);
    return at < 0 ? { text: quote, at: 0, midLine } : { text, at, midLine };
  }

  /**
   * The words a figure's row is labelled with, or null when its page doesn't say which row it is.
   * On its own line: a table row's first cell, or the last words before it ("Diluted earnings per
   * share" in "…412.5 Diluted earnings per share 2.15", as a Chinese PDF's joined rows read). A
   * number alone on its line takes the nearest line above that reads as a label, past a column of
   * numbers written like it (a five- or ten-year record read one cell per line); a blank line, a
   * sentence, a number written otherwise or the scale line itself leaves its row unknown.
   */
  function rowOf(quoted: Quoted, figure: Figure): RowLabel | null {
    const before = lineBefore(quoted, figure);
    const { text, at } = onPage(quoted);
    const start = at + figure.start;
    const end = text.indexOf("\n", start);
    const row = `${before}${text.slice(start, end < 0 ? undefined : end)}`;
    const named = (each: RowLabel) => WORDS.test(each.label);
    if (row.includes("\t")) {
      // A Word row can hold a label merged down its left cells before the row's own: the row's
      // label is the nearest text cell left of the figure, not the first one (#448).
      const cells = row.split("\t");
      const at = cells.findIndex((cell) => cell.includes(figure.chars));
      const [nearest, next] = cells
        .slice(0, at < 0 ? cells.length : at)
        .reverse()
        .filter((cell) => /\p{L}/u.test(cell) && !NOTE_REF.test(cell.trim()));
      // A unit column's minor unit ("Basic EPS | US cents | 24.7") is the row's unit; its label
      // is the cell before it (#2365).
      const unitCell =
        nearest !== undefined && (MINOR_UNIT_CELL.test(nearest) || PENCE_CELL.test(nearest))
          ? nearest
          : null;
      const cell = withoutStatement((unitCell === null ? nearest : next) ?? "");
      if (!named(cell)) return null;
      if (unitCell === null) return cell;
      return PENCE_CELL.test(unitCell)
        ? { ...cell, ownPence: true }
        : { ...cell, ownMinor: unitCell.trim() };
    }
    const own = betweenNumbers(before).map(withoutStatement).findLast(named);
    if (own !== undefined) return own;
    const lines = text
      .slice(0, start - before.length)
      .split("\n")
      .slice(0, -1)
      .reverse();
    for (const line of lines.slice(0, MOST_LINES_UP)) {
      if (line.trim() === "") return null;
      if (!WORDS.test(line)) {
        if (writtenLike(line, figure.chars)) continue;
        return null;
      }
      const label = withoutStatement(line);
      return named(label) && LABEL_LIKE.test(label.label) ? label : null;
    }
    return null;
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
    // "表2", "Table 2": a numbered caption holds no amount of its own (#2365).
    if (PART_NAMED.test(row) && !/\p{L}/u.test(row.replace(PART_NAMED, ""))) return false;
    const figures = readFigures(row, { ...context, header: null });
    const last = figures.at(-1);
    return (
      last !== undefined &&
      /\p{L}/u.test(row.slice(0, last.start)) &&
      /^[\s.,;:]*$/u.test(row.slice(last.end))
    );
  }

  // A generic head word names no column, so a scale after it states the table's, not a column's.
  const GENERIC_HEAD =
    /(?:项目|科目|金额|單位|单位|item|items|amount|amounts|currency|unit|units|description|particulars|note)\s*$/i;

  /** Whether a head line puts a scale inside a bracket between two words (a named column), with no tabs to place it. */
  const cellOfLine = (text: string, at: number) =>
    text.slice(text.lastIndexOf("\n", at - 1) + 1, at).split("\t").length - 1;

  function columnScopedHead(
    unit: Quoted,
    quoted: Quoted,
    figure: Figure,
    context: FigureContext,
  ): boolean {
    const line = unit.citation.quote;
    const statements = readStatedUnits(line, context).filter(
      (each) => each.scale !== 1 && /^\s*[(（]/.test(each.chars),
    );
    if (statements.length === 0) return false;
    const page = onPage(quoted);
    const figureCell = cellOfLine(page.text, page.at + figure.start);
    return statements.some((each) => {
      const before = /([\p{L}\p{N}]+)\s*$/u.exec(line.slice(0, each.start))?.[1] ?? null;
      if (before === null || GENERIC_HEAD.test(before)) return false;
      if (line.includes("\t")) return figureCell !== cellOfLine(line, each.start);
      const words = [
        ...line.slice(0, each.start).matchAll(/[\p{L}][\p{L}\p{N}]*/gu),
        ...line.slice(each.end).matchAll(/[\p{L}][\p{L}\p{N}]*/gu),
      ]
        .map((match) => match[0] ?? "")
        .filter((word) => word !== "" && word !== before && !GENERIC_HEAD.test(word));
      return words.length > 0;
    });
  }

  /** How many amounts the figure's line writes. */
  function amountsOnFigureLine(quoted: Quoted, figure: Figure, context: FigureContext): number {
    const { text, at } = onPage(quoted);
    const start = at + figure.start;
    const from = text.lastIndexOf("\n", start - 1) + 1;
    const to = text.indexOf("\n", start);
    return readFigures(text.slice(from, to < 0 ? undefined : to), {
      ...context,
      header: null,
    }).length;
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
    let lookElsewhere = false;
    if (given.unitQuote) {
      // A line in the figure's own Passage is judged there; only a line that isn't in it at all
      // may be taken from another Passage (#2365, #2386).
      if (quoteInUnits(quoted.units, given.unitQuote, quoted.matching) !== null) {
        const line = quotes.quote(
          { passage: quoted.passage, quote: given.unitQuote },
          { structured: true },
        );
        if ("problem" in line) {
          unitProblem = line.problem;
        } else {
          const check = line.check();
          if (check.check === "found") {
            const yen = figureContextOf(line.citation.quote, context.language).yen ?? context.yen;
            context = { ...context, yen };
            unit = line;
          } else if (check.checkReason === "unsure-word") {
            unitProblem = `the unitQuote "${given.unitQuote}" may include a word the scan misread; quote a line that states the unit clearly.`;
          } else {
            unitProblem = `the unitQuote isn't word for word in ${quoted.passage}; copy the line that states the unit exactly, from the same Passage.`;
          }
        }
      } else {
        unitProblem = `the unitQuote isn't word for word in ${quoted.passage}; copy the line that states the unit exactly, from the Passage it is in.`;
        lookElsewhere = true;
      }
    }

    const page = onPage(quoted);
    // A quote from the middle of a line ("…，88.0 和 91.5") starts with no list's or heading's number.
    // A sheet row's cells are numbers whatever they look like: "Gross profit	1922" holds no year.
    const cells = quoted.units.some((unit) => unit.kind === "rows");
    const around = {
      before: page.text.slice(0, page.at),
      after: page.text.slice(page.at + quote.length),
    };
    let quoteContext: FigureContext = {
      ...context,
      midLine: page.midLine,
      around,
      ...(cells && { dates: true }),
    };
    const contextProblem = quotePlaceProblem(quote, quoted.units, quoted.matching);
    if (contextProblem) return contextProblem;
    const figures = readFigures(quote, quoteContext);
    const has =
      figures.length === 0
        ? "it has no number"
        : `it has ${figures.map((each) => each.chars).join(", ")}`;
    let figure: Figure | undefined;
    const namedFigures = (named: string) => {
      const exact = figures.filter((each) => squeezed(each.chars) === squeezed(named));
      const inChars =
        exact.length > 0 ? exact : figures.filter((each) => namedIn(each.chars, named));
      return inChars.length > 0 ? inChars : figures.filter((each) => writtenAs(each, named));
    };
    if (original) {
      figure = figures.find((each) => each.start === original.at && each.chars === original.chars);
      if (!figure) return "the number is no longer at its recorded place in the quote.";
    } else if (given.position !== null) {
      const at = figures[given.position - 1];
      if (!at) return `the quote has no number at position ${given.position}; ${has}.`;
      // A position beside the number it names settles which one when they agree. One that names
      // another number is the model's slip, and the named number the quote writes once is meant.
      const named = given.number;
      const found = named === null ? null : namedFigures(named);
      if (named === null || found?.includes(at)) {
        figure = at;
      } else if (found?.length === 1) {
        figure = found[0];
      } else if (!found || found.length === 0) {
        return `the quote has no number "${named}"; ${has}.`;
      } else {
        return `"${named}" is in the quote ${found.length} times; give its position (${either(found.map((each) => figures.indexOf(each) + 1))}).`;
      }
    } else if (given.number !== null) {
      const named = given.number;
      const found = namedFigures(named);
      if (found.length === 0) {
        if (readsFromUnsureWord(quoted, named)) return UNSURE_INPUT;
        return `the quote has no number "${named}"; ${has}.`;
      }
      if (found.length > 1)
        return `"${named}" is in the quote ${found.length} times; give its position (${either(found.map((each) => figures.indexOf(each) + 1))}).`;
      figure = found[0];
    } else {
      return "give number, the number as it is written in the quote, or its position.";
    }
    if (!figure) return `the quote has no number "${given.number}"; ${has}.`;

    if (unsureWordAt(quoted, figure) !== null) return UNSURE_INPUT;

    // Another Passage's line is judged from the Unit the figure sits in, not the one the quote starts in.
    if (lookElsewhere && given.unitQuote) {
      const elsewhere = unitQuoteElsewhere(quoted, figure, given.unitQuote);
      if (elsewhere && "quoted" in elsewhere) {
        unit = elsewhere.quoted;
        unitProblem = null;
        const yen = figureContextOf(unit.citation.quote, context.language).yen ?? context.yen;
        context = { ...context, yen };
        quoteContext = { ...quoteContext, yen };
        const at = figure.start;
        const chars = figure.chars;
        const reread = readFigures(quote, quoteContext).find(
          (each) => each.start === at && each.chars === chars,
        );
        if (reread) figure = reread;
      } else if (elsewhere) unitProblem = elsewhere.problem;
    }

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
      let statedLine = readStatedUnits(unit.citation.quote, context, true);
      const ownRow = rowOf(quoted, figure);
      const bracketQuote = wholeScaleBracket(unit.citation.quote);
      const bracketLine =
        bracketQuote && ownRow?.ownBracket && ownRow.ownBracket.statement === bracketQuote.statement
          ? bracketQuote
          : null;
      const label = ownRow?.label ?? null;
      const [unsure] =
        row || statedLine.length > 0 ? [] : unsettledScales(unit.citation.quote, context);
      if (unsure)
        return `the unitQuote "${unit.citation.quote}" writes "${unsure}", which can be read as more than one scale or unit; ${figure.chars} can't be calculated without guessing its scale.`;
      // A statement may write its currency on its own first figure ("Sale price £385,000.00") instead of in a heading (#1001).
      const onFigure =
        row === null && statedLine.length === 0
          ? currencyOnItsFigure(unit.citation.quote, context)
          : null;
      if (!row && statedLine.length === 0 && !onFigure && !bracketLine)
        return `the unitQuote "${unit.citation.quote}" states no unit or scale; give the line that does, such as "单位：万元" or "in millions".`;
      // A line that states a currency on its own amount has its own rule above; a scale line is
      // judged by where its Unit sits, its shape and a nearer line (#2365, #2386).
      if (!onFigure && !bracketLine) {
        const verdict = judgeLine(
          quoted,
          figure,
          {
            unit: lineUnitOf(unit),
            text: unit.citation.quote,
            inPassage: quoteInUnits(quoted.units, unit.citation.quote, quoted.matching) !== null,
            unsure: unit.check().checkReason === "unsure-word",
          },
          figure.chars,
        );
        if (!verdict.ok) return verdict.problem;
      }
      if (
        !onFigure &&
        !bracketLine &&
        !conflicting(statedLine) &&
        columnScopedHead(unit, quoted, figure, context) &&
        amountsOnFigureLine(quoted, figure, quoteContext) > 1
      )
        return `${figure.chars} is in one column of a row whose head states the scale of another ("${unit.citation.quote}"); the text doesn't say which column it is, so its scale can't be settled.`;
      const at = page.at + figure.start;
      const minor =
        base.unit.kind === "currency" ? null : minorUnitOf(ownRow, quoted, context, statedLine);
      const money =
        base.unit.kind === "currency"
          ? base.unit.code
          : (ownRow?.ownCurrency ??
            currencyOnItsFigure(lineOf(page.text, at, at + figure.chars.length), context)?.code ??
            null);
      // An amount its own quote, row head or line writes in a currency takes only the quoted
      // line's statements of amounts' scale, as the currency-only fallback does, so a measure in
      // any spelling never reaches it (#2365).
      if (minor === null && money !== null) {
        const ofAmounts = amountStatements(unit, statedLine);
        const other = statedLine.find((each) => !ofAmounts.includes(each));
        if (other && ofAmounts.length === 0)
          return other.unit.kind === "plain" || other.unit.kind === "currency"
            ? `the unitQuote "${unit.citation.quote}" writes its scale "${other.chars}" with other words beside it, so it doesn't state the scale of amounts, and ${figure.chars} is an amount in ${money}; quote the line that states the scale of its amounts, or give none.`
            : `the unitQuote "${unit.citation.quote}" states a unit of measure ("${other.chars}"), but ${figure.chars} is an amount in ${money}; quote the line that states the scale of its amounts, or give none.`;
        statedLine = ofAmounts;
      }
      // A row in a minor unit ("(US cents)", "（港仙）") is read in that unit: no line's scale or
      // whole currency applies to it (#2365).
      if (minor !== null) stated = null;
      else if (bracketLine) {
        const kind = notAnAmount(label ?? "");
        if (kind)
          return `${figure.chars} is on a ${kind} row ("${(label ?? "").trim()}"), and the unitQuote "${unit.citation.quote}" states a scale for amounts; it can't be calculated without guessing its scale.`;
        const times = 10 ** bracketLine.exponent;
        stated = {
          quoted: unit,
          stated: { ...base, value: base.value * times, scale: base.scale * times },
          currencyChars: null,
        };
      } else if (onFigure) {
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
      } else if (label === null && row === null && statedLine.some((each) => each.scale !== 1)) {
        return `${figure.chars} has no label on its line or above it that says what its row is, and the unitQuote "${unit.citation.quote}" states a scale for amounts; it can't be calculated without guessing its scale.`;
      } else if (statedLine.some((each) => exceptedBy(each, label ?? ""))) {
        // The row's own currency is nearer than the line's: "Basic EPS (HK$)" under "(in US$
        // millions, except per share data)" is in HK$ (#2365).
        const currency =
          money !== null
            ? { kind: "currency" as const, code: money }
            : statedLine.find((each) => each.unit.kind === "currency")?.unit;
        if (currency && base.unit.kind === "plain")
          stated = { quoted: unit, stated: { ...base, unit: currency }, currencyChars: null };
      } else if (statedLine.some((each) => notedOut(each, label ?? ""))) {
        return `${figure.chars} is on a per-share row, and the unitQuote "${unit.citation.quote}" scales its Document's amounts except where it notes otherwise; it can't be calculated without guessing its scale.`;
      } else if (
        statedLine.length === 1 &&
        statedLine[0]?.scale === 1 &&
        statedLine[0]?.unit.kind === "currency" &&
        ownRow?.ownCurrency === statedLine[0].unit.code &&
        notAnAmount(label ?? "") === null
      ) {
        // A row head states its currency; a scale line applies only when it is this figure's,
        // judged as a quoted line is, and its Citation is the one recorded (#2365).
        const rowCurrency = statedLine[0].unit.code;
        const scaleLines: { scale: number; word: string | null; quoted: Quoted }[] = [];
        let otherScale = false;
        for (const each of quoted.units) {
          for (const statement of readStatedUnits(each.text, context)) {
            if (statement.scale === 1 || exceptedBy(statement, label ?? "")) continue;
            // Only a line that states amounts' scale, as a quoted line must, and in this row's
            // currency, can scale it (#2365).
            if (
              !statesAmountScale(each.text, statement) ||
              (statement.unit.kind === "currency" && statement.unit.code !== rowCurrency) ||
              statement.unplacedCurrency !== undefined
            ) {
              otherScale = true;
              continue;
            }
            const line = lineOf(each.text, statement.start, statement.end);
            const applies = appliesScaleLine(quoted, figure, line);
            if (applies)
              scaleLines.push({
                scale: statement.scale,
                word: statement.scaleWord,
                quoted: applies,
              });
            else otherScale = true;
          }
        }
        const scales = new Set(scaleLines.map((each) => each.scale));
        if (scales.size > 1)
          return `${figure.chars} has no unit, and ${whereOf(quoted)} states more than one scale; give the line that applies to it as unitQuote.`;
        const [scale] = scaleLines;
        if (scale)
          stated = {
            quoted: scale.quoted,
            stated: {
              ...base,
              value: base.value * scale.scale,
              scale: base.scale * scale.scale,
              scaleWord: scale.word,
              unit: statedLine[0].unit,
            },
            currencyChars: null,
          };
        else {
          // A retained running header, or a scale in another Unit that might apply, is not
          // this row's to take: it can't be settled without a quote (#2365).
          const header =
            quoted.units.find(({ text, scaleMarker }) => scaleMarker && !text.includes(scaleMarker))
              ?.scaleMarker ?? null;
          const elsewhere =
            header === null
              ? (() => {
                  const found = elsewhereScales(quoted, figure);
                  return found.quotable[0] ?? found.refused[0] ?? null;
                })()
              : null;
          if (otherScale || header !== null || elsewhere !== null) {
            const states = header
              ? `a running header or footer states a scale ("${header}")`
              : elsewhere
                ? `${elsewhere.where || "another part of the Document"} states a scale ("${elsewhere.line}")`
                : `a scale in ${whereOf(quoted)} doesn't apply to it or is in another currency`;
            return `${figure.chars} is on a row whose head states only a currency, and ${states}; quote the line that states its scale, or give none.`;
          }
          stated = {
            quoted: unit,
            stated: { ...base, unit: statedLine[0].unit },
            currencyChars: null,
          };
        }
      } else if (
        ownRow?.ownScales.length &&
        statedLine.some((each) => each.scale !== 1 && !ownRow.ownScales.includes(each.scale))
      ) {
        const lineScales = new Set(
          statedLine.filter((each) => each.scale !== 1).map((each) => each.scale),
        );
        if (lineScales.size > 1)
          return `the unitQuote "${unit.citation.quote}" states more than one scale; give the one line that applies.`;
        const lineScale = statedLine.find(
          (each) => each.scale !== 1 && !ownRow.ownScales.includes(each.scale),
        );
        const lineNamesCurrency = statedLine.some(
          (each) => each.unit.kind === "currency" || each.unplacedCurrency !== undefined,
        );
        const headIsCurrencyOnly = ownRow.ownScales.every((each) => each === 1);
        if (
          lineScale &&
          headIsCurrencyOnly &&
          ownRow.ownCurrency !== null &&
          !lineNamesCurrency &&
          notAnAmount(label ?? "") === null
        )
          stated = {
            quoted: unit,
            stated: {
              ...base,
              value: base.value * lineScale.scale,
              scale: base.scale * lineScale.scale,
              scaleWord: lineScale.scaleWord,
              unit: { kind: "currency", code: ownRow.ownCurrency },
            },
            currencyChars: null,
          };
        else
          return headIsCurrencyOnly
            ? `${figure.chars} is on a row whose head states its own currency, and the unitQuote "${unit.citation.quote}" states a scale with a currency; the text doesn't say whether the row is scaled, so it can't be calculated without guessing its scale.`
            : `${figure.chars} is on a row whose head states its own scale, and the unitQuote "${unit.citation.quote}" states another; quote the row's head as unitQuote.`;
      } else {
        const readings = row
          ? [row]
          : statedReading(quote, figure.start, quoteContext, unit.citation.quote);
        const scales = new Set(
          readings.filter((each) => each.scale !== 1).map((each) => each.scale),
        );
        if (scales.size > 1)
          return `the unitQuote "${unit.citation.quote}" states more than one scale; give the one line that applies.`;
        // A table's head row states each column's unit: "Revenue (£000)	EPS (£)" doesn't say which
        // of them a number is in, so it states none of them for it.
        if (conflicting(statedLine))
          return `the unitQuote "${unit.citation.quote}" states more than one unit or scale; give the line or column head that states the unit of ${figure.chars} alone.`;
        // A scale is dropped silently when the line's currency is not the figure's own: "£m" over
        // "$1,234.5" leaves $900, so the figure is refused instead (#2365).
        const ownCurrency = base.unit.kind === "currency" ? base.unit.code : null;
        const lineCurrency = statedLine.find((each) => each.unit.kind === "currency")?.unit;
        if (
          ownCurrency !== null &&
          lineCurrency?.kind === "currency" &&
          lineCurrency.code !== ownCurrency
        )
          return `the unitQuote "${unit.citation.quote}" states ${lineCurrency.code}, but ${figure.chars} is in ${ownCurrency}; quote a line in ${ownCurrency} that states the scale.`;
        // A quote of the number alone leaves out the currency its own line or row head writes:
        // a line in another currency can't state its scale (#2365).
        if (
          base.unit.kind === "plain" &&
          lineCurrency?.kind === "currency" &&
          money !== null &&
          money !== lineCurrency.code
        )
          return `the unitQuote "${unit.citation.quote}" states ${lineCurrency.code}, but ${figure.chars}'s own line states ${money}; quote a line in ${money} that states the scale, or quote the number with its currency.`;
        const applies =
          readings.find((each) => each.scale !== 1) ??
          readings.find((each) => each.unit.kind !== base.unit.kind) ??
          null;
        // A row head's bare "(M)"/"(m)" may be millions, metres or another scale: only a page that
        // states millions settles a capital (M); every other scale would be a guess (#2365).
        const ownScale = ownRow?.ownUnsettled ?? null;
        if (
          ownScale &&
          applies &&
          applies.scale !== 1 &&
          !(ownScale === "(M)" && applies.scale === 1e6)
        )
          return `${figure.chars} is on a row whose head writes "${ownScale}", which can be read as more than one scale or unit, and the unitQuote "${unit.citation.quote}" states a scale for amounts; it can't be calculated without guessing which scale applies.`;
        const kind = applies && applies.scale !== 1 ? notAnAmount(label ?? "") : null;
        if (kind)
          return `${figure.chars} is on a ${kind} row ("${(label ?? "").trim()}"), and the unitQuote "${unit.citation.quote}" states a scale for amounts; it can't be calculated without guessing its scale.`;
        if (applies) stated = { quoted: unit, stated: applies, currencyChars: null };
      }
    } else if (!ownUnit) {
      const page = quoted.units.map((each) => each.text).join("\n");
      const found: Stated[] = [];
      const refusedHere: Stated[] = [];
      let noted: string | null = null;
      const lines = quotedLines(quoted);
      const row = onLine(lines);
      if (row) found.push({ statement: lines, reading: row });
      const same = (a: Reading, b: Reading) =>
        a.value === b.value && JSON.stringify(a.unit) === JSON.stringify(b.unit);
      const ownRow = rowOf(quoted, figure);
      const rowLabel = ownRow?.label ?? "";
      // A per-share row a line excepts keeps the currency its own head states (#2365).
      if (
        ownRow?.ownCurrency !== null &&
        ownRow?.ownCurrency !== undefined &&
        base.unit.kind === "plain" &&
        quoted.units.some((unit) =>
          readStatedUnits(unit.text, context).some((each) => exceptedBy(each, rowLabel)),
        )
      )
        stated = {
          quoted,
          stated: { ...base, unit: { kind: "currency", code: ownRow.ownCurrency } },
          currencyChars: null,
        };
      const rowMinor = base.unit.kind === "plain" ? minorUnitOf(ownRow, quoted, context, []) : null;
      const numbersUnit = unitOf(quoted, figure);
      const numberIndex = numbersUnit ? quoted.units.indexOf(numbersUnit) : -1;
      const { starts } = joinUnits(quoted.units);
      const figureAt =
        numberIndex >= 0 ? onPage(quoted).at + figure.start - (starts[numberIndex] ?? 0) : -1;
      for (const [unitIndex, unit] of quoted.units.entries()) {
        for (const statement of readStatedUnits(unit.text, context)) {
          if (exceptedBy(statement, rowLabel) || rowMinor !== null) continue;
          if (notedOut(statement, rowLabel)) {
            noted = noted ?? statement.chars;
            continue;
          }
          // A line on an earlier page of the same Passage can't be quoted for the figure: the
          // rule refuses it, so the tool must not tell the model to quote it (#2365).
          const elsewherePage =
            numbersUnit?.kind === "page" &&
            unit.kind === "page" &&
            unit.page !== null &&
            numbersUnit.page !== null &&
            unit.page < numbersUnit.page &&
            !statesForWholeDocument(lineOf(unit.text, statement.start, statement.end));
          const afterFigure =
            figureAt >= 0 &&
            (unitIndex > numberIndex || (unitIndex === numberIndex && statement.start > figureAt));
          const line = lineOf(unit.text, statement.start, statement.end);
          for (const each of statedReading(quote, figure.start, quoteContext, line)) {
            if (!changes(each)) continue;
            const refused = elsewherePage || afterFigure;
            const target = refused ? refusedHere : found;
            if (!target.some((other) => same(other.reading, each)))
              target.push({
                statement:
                  readStatedUnits(line, context).find((one) => one.scale === each.scale)?.chars ??
                  statement.chars,
                reading: each,
                ...(elsewherePage && { unquotable: "elsewhere" as const }),
                ...(afterFigure && !elsewherePage && { unquotable: "after" as const }),
              });
          }
        }
      }
      if (found.length > 1)
        return `${figure.chars} has no unit, and ${whereOf(quoted)} states more than one (${found.map((each) => `"${each.statement}"`).join(", ")}); give the line that applies to it as unitQuote.`;
      const header = quoted.units.find(
        ({ text, scaleMarker }) => scaleMarker && !text.includes(scaleMarker),
      )?.scaleMarker;
      const [unsure] = unsettledScales(page, context);
      const misread = misreadScaleWord(quoted.units);
      // A Word section under a heading that states its scale, or a page after one that does, may
      // be in that scale: the model may quote an ancestor section's line or a whole-Document one,
      // and another section's line is refused rather than read plain (#2365).
      const elsewhere = elsewhereScales(quoted, figure);
      const unquotableAs = (
        statement: string | null | undefined,
        unquotable: Stated["unquotable"],
        where?: string,
      ): Stated[] =>
        statement
          ? [{ statement, reading: thousandfold(base), unquotable, ...(where && { where }) }]
          : [];
      const sheet = numbersUnit?.label?.sheet ?? null;
      const sheetScale =
        sheet !== null && readStatedUnits(sheet, context).some((each) => each.scale !== 1)
          ? sheet
          : null;
      const [quotable] = elsewhere.quotable;
      const [refusedScale] = elsewhere.refused;
      // A row head's own scale, a bare "(M)"/"(m)" or a bracket scale ("(K)"), is not a plain
      // number: it refuses when the result depends on the scale (#2365).
      const rowScale = ownRow?.ownBracket ?? null;
      const rowCandidate: Stated | null = ownRow?.ownUnsettled
        ? { statement: ownRow.ownUnsettled, reading: thousandfold(base), unquotable: "row" }
        : rowScale
          ? {
              statement: rowScale.statement,
              reading: {
                ...base,
                value: base.value * 10 ** rowScale.exponent,
                scale: base.scale * 10 ** rowScale.exponent,
              },
              unquotable: "row",
            }
          : null;
      candidate =
        [
          ...found,
          ...(rowCandidate ? [rowCandidate] : []),
          ...refusedHere,
          ...unquotableAs(noted, "noted"),
          ...unquotableAs(sheetScale, "sheet"),
          ...unquotableAs(header, "header"),
          ...unquotableAs(unsure, "unsettled"),
          ...unquotableAs(misread, "unsettled"),
          ...(quotable
            ? [
                {
                  statement: quotable.line,
                  reading: thousandfold(base),
                  where: quotable.where,
                  quotable: true as const,
                },
              ]
            : unquotableAs(refusedScale?.line, "elsewhere", refusedScale?.where)),
        ][0] ?? null;
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
          problems: affected.flatMap((read) =>
            read.candidate
              ? [
                  `${lead} ${read.given.name}: ${candidateProblem(read.figure.chars, read.where, read.candidate)}`,
                ]
              : [],
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
    const supposed = options.structured ? null : whatIfProblem(lead, given, reads, result.literals);
    if (supposed) return { problems: [supposed] };
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
    let note = (negatives.length > 0 ? signNote(negatives) : "") + setAsideNote(reads);
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

  /**
   * A number written into a formula beside a workbook's own figures or inputs may be a value the
   * Question supposes for one of its inputs (#2372): worked out here, that what-if would leave out
   * every formula between the input and the figure. 0 and 1 are the arithmetic's own; any other
   * number passes once the model names it a constant.
   */
  function whatIfProblem(
    lead: string,
    given: GivenFigure,
    reads: readonly ReadInput[],
    literals: readonly FormulaLiteral[],
  ): string | null {
    const { partOfFormulas } = options;
    if (!partOfFormulas) return null;
    const written = literals.filter(
      (literal) =>
        literal.value !== 0 &&
        literal.value !== 1 &&
        !given.constants.some((constant) => sameValue(constant, literal.value)),
    );
    if (written.length === 0) return null;
    const cells = reads.flatMap((read) => {
      const sheet = read.cell?.sheet;
      return read.cell && sheet && partOfFormulas(read.quoted.citation, sheet, read.cell.ref)
        ? [
            {
              name: read.given.name,
              at: `${sheet}!${read.cell.ref}`,
              book: read.quoted.citation.documentName,
            },
          ]
        : [];
    });
    const [first] = cells;
    if (!first) return null;
    const texts = [...new Set(written.map((literal) => literal.text))];
    const numbers =
      texts.length < 2 ? texts.join("") : `${texts.slice(0, -1).join(", ")} and ${texts.at(-1)}`;
    const beside = cells.map((cell) => `${cell.name} (${cell.at})`).join(", ");
    const one = texts.length === 1;
    return `${lead}: ${numbers} ${one ? "is" : "are"} written into its formula beside ${beside} of ${first.book}, cells that workbook's own formulas work out or read. If ${one ? "it" : "one of them"} is a value the Question supposes for one of the workbook's inputs, this figure is a what-if, and calculate would leave out every formula between that input and the figure: call ${WORKBOOK_TOOLS.whatIf} with the figure's cell, and each input the Question supposes with its new value, instead. Only if ${one ? "it" : "each"} is a constant of the arithmetic itself (12 months in a year, say), give ${one ? "it" : "them"} as "constants" on this figure and call calculate again.`;
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
        toldFigure(marker, outcome.recorded.figure) +
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
        return { problem: candidateProblem(read.figure.chars, read.where, read.candidate) };
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

    /**
     * Records a figure an Analysis or a workbook's formulas gave (#447, #2347) under the next
     * marker no figure has, and above `above`: that marker. `cited`: the quotes the Answer cites
     * it to.
     */
    record(figure: CalculatedFigure, cited: readonly QuoteInput[] = [], above = 0): number {
      const marker = Math.max(above, ...recorded.keys()) + 1;
      recorded.set(marker, { figure, note: "", signAsked: false, quotes: [], cited });
      options.onRecord?.(marker, figure);
      return marker;
    },

    /** The figures given in structured output that couldn't be worked out, by marker. */
    problems(): FigureProblem[] {
      return [...failed.values()].sort((a, b) => a.marker - b.marker);
    },

    /** Where a marker's figure's inputs quote from: a cite record's marker, or a quote given directly. */
    inputSources(marker: number): (number | QuoteInput)[] {
      const entry = recorded.get(marker);
      return [...(entry?.quotes ?? []).map((each) => each.source), ...(entry?.cited ?? [])];
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
