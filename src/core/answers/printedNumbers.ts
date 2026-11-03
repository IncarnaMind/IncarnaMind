/**
 * A number an Answer types that its Analyses' code printed (#2351) becomes the figure it is:
 * calculated by code and not checked, as a `result()` figure is, never a recalculated one. The
 * model reads what code prints and copies its numbers, and the model never types a number
 * (ADR-0025 decision 3). The Answer reads the same: the number's own characters are the
 * figure's shown text, and one that would read differently as a figure stays as it is.
 *
 * A number matches a printed one as the figure check matches a sentence's number to a
 * calculated figure (./checks/calculated): the same unit, scale, percent and sign, at the
 * Answer's own rounding, so "12.3" is the 12.345 code printed. A whole number written plainly
 * matches only the same number printed: rounded to a whole, every count and id in a reply would
 * match a printed decimal. Where the printed numbers it matches differ, one printed exactly as
 * written decides; else it matches none. A number its sentence's Citation quotes is the
 * Citation's, one a `figure()` figure whose cells came to another number also matches is never
 * made a figure, and one that matches nothing stays as typed, for the checks every typed number
 * goes through.
 */
import { FENCE, paragraphsOf } from "../../shared/answerSentences";
import { type PlacedFigure, withFigureText } from "../../shared/figureMarkers";
import { type Figure, figureContextOf, readFigures, readingsOf } from "../../shared/figures";
import { FORMULA_VERSION, sameNumber } from "../../shared/formula";
import { tableCellRanges, tableStart } from "../../shared/markdownTables";
import { type PrintedValue, printedValues } from "../../shared/printedFigures";
import type { AnswerAnalysis, CalculatedFigure } from "../api";
import type { Language } from "../language";
import { agreesAtShownPrecision } from "./checks/calculated";

/** Lines that hold no figure of the Answer's own: headings, footnote definitions and rules. */
const SKIPPED_LINE = /^\s*(?:#{1,6}\s|\[\^\d{1,4}\]:|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const MATH_FENCE = /^\s*\$\$\s*$/;
/** What a number inside is no figure the Answer gives: code, markers, links and addresses. */
const NOT_PROSE =
  /`[^`\n]*`|\[\^\d{1,4}\]|\[=[^\]\n]*\]|\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])|<[^>\n]*>|\bhttps?:\/\/\S+/g;
const CITATION = /\[\^(\d{1,4})\]/g;
const FIGURE_MARKER = /\[=(\d{1,4})\]/g;
/** Emphasis around a number, which a footnote mark's reading would take in: "**12.3**". */
const EMPHASIS_AFTER = /[*_~]+$/u;
const WORD = /[\p{L}\p{N}_/.-]+/gu;
const FIGURE_AFTER = /^\s*\[=\d{1,4}\]/;
/** Stands for the figure being tried while its text is compared: no figure has it. */
const TRIED = 0;
const PLAIN = { kind: "plain" } as const;
const PERCENT = { kind: "percent" } as const;

interface Candidate extends PrintedValue {
  analysis: number;
}

interface Span {
  start: number;
  end: number;
}

const asCalculated = (reading: Pick<Figure, "value" | "unit">) => ({
  value: reading.value,
  unit: reading.unit,
  inputs: [],
  formula: "",
});

/**
 * The figures the Answer writes as its own, by offset in `text`. A table's headings and each
 * row's label name what its figures are, as the checks read a table (`givesValue`), so they are
 * none.
 */
function proseFigures(text: string, language: Language): Figure[] {
  const found: Figure[] = [];
  const lines = text.split("\n");
  let fenced = false;
  let math = false;
  let table: "head" | "delimiter" | "body" | null = null;
  let offset = 0;
  lines.forEach((line, at) => {
    const start = offset;
    offset += line.length + 1;
    const fence = FENCE.test(line);
    const mathFence = !fenced && MATH_FENCE.test(line);
    if (fence) fenced = !fenced;
    if (mathFence) math = !math;
    if (fence || mathFence || fenced || math || SKIPPED_LINE.test(line)) return;
    table = tableStart(lines, at)
      ? "head"
      : table === "head"
        ? "delimiter"
        : table && line.includes("|")
          ? "body"
          : null;
    if (table === "head" || table === "delimiter") return;
    let prose = line.replace(NOT_PROSE, (masked) => " ".repeat(masked.length));
    const [label, ...cells] = table === "body" ? tableCellRanges(line) : [];
    if (label && cells.some((cell) => cell.end > cell.start)) {
      prose = `${prose.slice(0, label.start)}${" ".repeat(label.end - label.start)}${prose.slice(label.end)}`;
    }
    for (const figure of readFigures(prose, { language })) {
      found.push({ ...figure, start: start + figure.start, end: start + figure.end });
    }
  });
  return found;
}

/** The sentence or table cell `at` is in: what a Citation beside it cites. */
function claimAround(text: string, sentences: readonly Span[], at: number): Span {
  const sentence = sentences.find((span) => span.start <= at && at < span.end);
  if (sentence) return sentence;
  const from = text.lastIndexOf("\n", at - 1) + 1;
  const to = text.indexOf("\n", at);
  const line = text.slice(from, to < 0 ? undefined : to);
  const cell = tableCellRanges(line).find(
    (span) => from + span.start <= at && at < from + span.end,
  );
  return cell
    ? { start: from + cell.start, end: from + cell.end }
    : { start: from, end: from + line.length };
}

const wholeAsWritten = (stated: Figure) =>
  stated.decimals === 0 && !stated.approximate && stated.rangeTo === null && !stated.scaleWord;

function agrees(stated: Figure, reading: Pick<Figure, "value" | "unit">): boolean {
  if (wholeAsWritten(stated) && !sameNumber(reading.value, stated.value)) return false;
  return agreesAtShownPrecision(stated, asCalculated(reading)) === true;
}

/** Only a number this near can round to `stated`; the check itself works each out with a formula. */
function nearness(stated: Figure): number {
  if (wholeAsWritten(stated)) return 0;
  if (!stated.approximate && stated.rangeTo === null && typeof stated.precision === "number")
    return stated.precision;
  return Math.abs(stated.value) / 2 + Math.abs((stated.rangeTo ?? stated.value) - stated.value);
}

/** Printed values by value and unit, in order of value: each is tried once, however often printed. */
interface PrintedGroup {
  value: number;
  reading: Figure;
  candidates: Candidate[];
}

function groupsOf(candidates: readonly Candidate[]): PrintedGroup[] {
  const groups = new Map<string, PrintedGroup>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.value.value, candidate.reading.unit]);
    const group = groups.get(key);
    if (group) group.candidates.push(candidate);
    else
      groups.set(key, {
        value: candidate.value.value,
        reading: candidate.reading,
        candidates: [candidate],
      });
  }
  return [...groups.values()].sort((a, b) => a.value - b.value);
}

function within(groups: readonly PrintedGroup[], value: number, near: number): PrintedGroup[] {
  let low = 0;
  let high = groups.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((groups[middle]?.value ?? 0) < value - near - 1e-9 * Math.abs(value)) low = middle + 1;
    else high = middle;
  }
  const found: PrintedGroup[] = [];
  for (let at = low; at < groups.length; at++) {
    const group = groups[at];
    if (!group || group.value > value + near + 1e-9 * Math.abs(value)) break;
    found.push(group);
  }
  return found;
}

/** The one printed value `stated` matches; null when the values it matches differ or none does. */
function matched(stated: Figure, groups: readonly PrintedGroup[]): PrintedGroup | null {
  const agreeing = within(groups, stated.value, nearness(stated)).filter((group) =>
    agrees(stated, group.reading),
  );
  const exact = agreeing.filter((group) => sameNumber(group.value, stated.value));
  const chosen = exact.length > 0 ? exact : agreeing;
  const [first] = chosen;
  if (!first) return null;
  return chosen.every((each) => sameNumber(each.value, first.value)) ? first : null;
}

/** Of the lines that printed the same value, the one sharing most words with the reply's line. */
function closest(candidates: readonly Candidate[], line: string): Candidate | undefined {
  const words = new Set(line.toLowerCase().match(WORD) ?? []);
  const shared = (candidate: Candidate) =>
    (candidate.value.label.toLowerCase().match(WORD) ?? []).filter((word) => words.has(word))
      .length;
  return candidates.reduce<Candidate | undefined>(
    (best, each) => (!best || shared(each) > shared(best) ? each : best),
    undefined,
  );
}

export interface PrintedNumbersOptions {
  language: Language;
  /** Records a figure as one of the Answer's: its marker, above `above`. */
  record(figure: CalculatedFigure, above: number): number;
}

export interface PrintedNumbersText {
  analyses: readonly AnswerAnalysis[];
  /** The quote a Citation marker stands for; null for a marker with none. */
  quoteOf(marker: number): string | null;
  /** The figure a marker already in the text stands for. */
  figureOf(marker: number): PlacedFigure | null;
}

/**
 * Marks the printed numbers of the texts it is given. A number written the same way from the
 * same printed number is recorded once, however often the text it is in is read again, as a
 * Note's text is while it is written.
 */
export function createPrintedNumbers(options: PrintedNumbersOptions) {
  const recorded = new Map<string, number>();
  // A Note's text is read again as it streams, while the Analyses stay the same.
  let grouped: { runs: readonly AnswerAnalysis[]; groups: PrintedGroup[] } | null = null;
  return (text: string, given: PrintedNumbersText): string => {
    const same =
      grouped?.runs.length === given.analyses.length &&
      given.analyses.every((run, at) => grouped?.runs[at] === run);
    if (!grouped || !same) {
      const candidates = given.analyses.flatMap((analysis) =>
        printedValues(analysis).map((printed) => ({ ...printed, analysis: analysis.number })),
      );
      grouped = { runs: [...given.analyses], groups: groupsOf(candidates) };
    }
    const { groups } = grouped;
    if (groups.length === 0) return text;
    const refused = given.analyses.flatMap((analysis) =>
      (analysis.recalculations ?? []).flatMap(({ result, check }) => {
        const figure = analysis.output.results.find((each) => each.name === result);
        if (check.kind !== "differs" || figure?.kind !== "figure") return [];
        return [{ value: figure.value, unit: figure.unit === "%" ? PERCENT : PLAIN }];
      }),
    );
    // A marker the model wrote with no figure stays one: a printed figure never takes its number.
    const above = Math.max(
      0,
      ...[...text.matchAll(FIGURE_MARKER)].map((found) => Number(found[1])),
    );
    const sentences = paragraphsOf(text).flatMap((paragraph) => paragraph.sentences);
    const placed = new Map<number, PlacedFigure>();
    const figureOf = (marker: number) => placed.get(marker) ?? given.figureOf(marker);
    const cited = (stated: Figure, claim: Span) =>
      [...text.slice(claim.start, claim.end).matchAll(CITATION)].some((found) => {
        const quote = given.quoteOf(Number(found[1]));
        if (!quote) return false;
        return readFigures(quote, figureContextOf(quote)).some((figure) =>
          readingsOf(figure).some((reading) => agrees(stated, reading)),
        );
      });
    let marked = text;
    // From the end, so each number's offsets hold while the ones after it become markers.
    for (const read of proseFigures(text, options.language).reverse()) {
      const chars = read.chars.replace(EMPHASIS_AFTER, "");
      const stated = { ...read, chars, end: read.start + chars.length };
      if (stated.ambiguous.length > 0 || FIGURE_AFTER.test(text.slice(stated.end))) continue;
      if (cited(stated, claimAround(text, sentences, stated.start))) continue;
      // At the reply's own rounding even for a whole number: a mismatch is never shown as a figure.
      if (refused.some((value) => agreesAtShownPrecision(stated, asCalculated(value)))) continue;
      const group = matched(stated, groups);
      const from = marked.lastIndexOf("\n", stated.start - 1) + 1;
      const to = marked.indexOf("\n", stated.end);
      const source =
        group && closest(group.candidates, marked.slice(from, to < 0 ? undefined : to));
      if (!source) continue;
      const figure: CalculatedFigure = {
        label: source.value.label,
        formula: "",
        inputs: [],
        value: source.value.value,
        unit: source.reading.unit,
        approximate: false,
        shown: stated.chars,
        show: {
          language: options.language,
          as: null,
          decimals: stated.decimals <= 10 ? stated.decimals : null,
          scale: stated.scaleWord,
        },
        literals: [],
        engine: FORMULA_VERSION,
        written: null,
        analysis: { analysis: source.analysis, result: source.value.name },
      };
      const at = (marker: number) =>
        `${marked.slice(0, stated.start)}[=${marker}]${marked.slice(stated.end)}`;
      // A figure's place reads only its own line.
      const line = (text: string, end: number) => text.slice(from, end < 0 ? undefined : end);
      const shift = `[=${TRIED}]`.length - (stated.end - stated.start);
      const tried = withFigureText(line(at(TRIED), to < 0 ? to : to + shift), (marker) =>
        marker === TRIED ? figure : figureOf(marker),
      );
      if (tried !== withFigureText(line(marked, to), figureOf)) continue;
      const key = JSON.stringify([source.analysis, source.value.name, stated.chars]);
      const marker = recorded.get(key) ?? options.record(figure, above);
      recorded.set(key, marker);
      placed.set(marker, figure);
      marked = at(marker);
    }
    return marked;
  };
}
