/**
 * A number an Answer types that its Analyses' code printed (#2351) becomes the figure it is:
 * calculated by code and not checked, as a `result()` figure is, never a recalculated one. The
 * model reads what code prints and copies its numbers, and the model never types a number
 * (ADR-0025 decision 3). The Answer reads the same: the number's own characters are the
 * figure's shown text, and one that would read differently as a figure stays as it is.
 *
 * A number matches a printed one as the figure check matches a sentence's number to a
 * calculated figure (./checks/calculated): the same unit, scale, percent and sign, at the
 * Answer's own rounding, so "12.3" is the 12.345 code printed. Where the printed numbers it
 * matches differ, one printed exactly as written decides; else it matches none. A number its
 * sentence's Citation quotes is the Citation's, and one that matches nothing stays as typed,
 * for the checks every typed number goes through.
 */
import { FENCE, paragraphsOf } from "../../shared/answerSentences";
import { type PlacedFigure, withFigureText } from "../../shared/figureMarkers";
import { type Figure, figureContextOf, readFigures, readingsOf } from "../../shared/figures";
import { FORMULA_VERSION, sameNumber } from "../../shared/formula";
import { tableCellRanges } from "../../shared/markdownTables";
import { type PrintedValue, printedValues } from "../../shared/printedFigures";
import type { AnswerAnalysis, CalculatedFigure } from "../api";
import type { Language } from "../language";
import { agreesAtShownPrecision } from "./checks/calculated";

/** Lines that hold no figure of the Answer's own: headings, footnote definitions and rules. */
const SKIPPED_LINE = /^\s*(?:#{1,6}\s|\[\^\d{1,4}\]:|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const MATH_FENCE = /^\s*\$\$\s*$/;
/** What a number inside is no figure the Answer gives: code, markers, links and addresses. */
const NOT_PROSE =
  /`[^`\n]*`|\[\^\d{1,4}\]|\[=[^\]\n]*\]|\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]*>|\bhttps?:\/\/\S+/g;
const CITATION = /\[\^(\d{1,4})\]/g;
const FIGURE_AFTER = /^\s*\[=\d{1,4}\]/;
/** Stands for the figure being tried while its text is compared: no figure has it. */
const TRIED = 0;

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

/** The figures of a line the Answer writes as its own, by offset in `text`. */
function proseFigures(text: string, language: Language): Figure[] {
  const found: Figure[] = [];
  let fenced = false;
  let math = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const fence = FENCE.test(line);
    const mathFence = !fenced && MATH_FENCE.test(line);
    if (fence) fenced = !fenced;
    if (mathFence) math = !math;
    if (fence || mathFence || fenced || math || SKIPPED_LINE.test(line)) continue;
    const prose = line.replace(NOT_PROSE, (masked) => " ".repeat(masked.length));
    for (const figure of readFigures(prose, { language })) {
      found.push({ ...figure, start: start + figure.start, end: start + figure.end });
    }
  }
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

/** The one value of what `stated` matches, among `candidates`; null when they disagree or none does. */
function matched(stated: Figure, candidates: readonly Candidate[]): Candidate | null {
  const agreeing = candidates.filter(
    (candidate) => agreesAtShownPrecision(stated, asCalculated(candidate.reading)) === true,
  );
  const exact = agreeing.filter((candidate) => sameNumber(candidate.value.value, stated.value));
  const chosen = exact.length > 0 ? exact : agreeing;
  const [first] = chosen;
  if (!first) return null;
  return chosen.every((each) => sameNumber(each.value.value, first.value.value)) ? first : null;
}

export interface PrintedNumbersOptions {
  language: Language;
  /** Records a figure as one of the Answer's: its marker. */
  record(figure: CalculatedFigure): number;
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
  return (text: string, given: PrintedNumbersText): string => {
    const candidates: Candidate[] = given.analyses.flatMap((analysis) =>
      printedValues(analysis).map((printed) => ({ ...printed, analysis: analysis.number })),
    );
    if (candidates.length === 0) return text;
    const sentences = paragraphsOf(text).flatMap((paragraph) => paragraph.sentences);
    const placed = new Map<number, PlacedFigure>();
    const figureOf = (marker: number) => placed.get(marker) ?? given.figureOf(marker);
    const cited = (stated: Figure, claim: Span) =>
      [...text.slice(claim.start, claim.end).matchAll(CITATION)].some((found) => {
        const quote = given.quoteOf(Number(found[1]));
        if (!quote) return false;
        return readFigures(quote, figureContextOf(quote)).some((figure) =>
          readingsOf(figure).some((reading) =>
            agreesAtShownPrecision(stated, asCalculated(reading)),
          ),
        );
      });
    let marked = text;
    // From the end, so each number's offsets hold while the ones after it become markers.
    for (const stated of proseFigures(text, options.language).reverse()) {
      if (stated.ambiguous.length > 0 || FIGURE_AFTER.test(text.slice(stated.end))) continue;
      if (cited(stated, claimAround(text, sentences, stated.start))) continue;
      const source = matched(stated, candidates);
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
      const tried = withFigureText(at(TRIED), (marker) =>
        marker === TRIED ? figure : figureOf(marker),
      );
      if (tried !== withFigureText(marked, figureOf)) continue;
      const key = JSON.stringify([source.analysis, source.value.name, stated.chars]);
      const marker = recorded.get(key) ?? options.record(figure);
      recorded.set(key, marker);
      placed.set(marker, figure);
      marked = at(marker);
    }
    return marked;
  };
}
