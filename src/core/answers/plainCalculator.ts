/**
 * The calculator an Answer's model, and a check's, calls (#3393): each figure's inputs are plain
 * numbers with the quotes they come from, an expression over them and a label that says what the
 * figure is. IncarnaMind confirms by digits that each number stands in its quote
 * (../../shared/plainFigures), does the arithmetic, keeps the figure with its working and tells the
 * model the result. An Answer's model then writes the figure in its text, its marker right after
 * it, and the figure shows as written there once its digits carry the result. It reads no unit or
 * scale: what a number means is the model's to say, in its label and its text.
 */
import { MAX_INPUTS_PER_FIGURE } from "../../shared/calculatedFigures";
import { FIGURE_MARKER, writtenBefore } from "../../shared/figureMarkers";
import { readFigures } from "../../shared/figures";
import { FORMULA_VERSION, sameNumber } from "../../shared/formula";
import { anchorsCovered, quoteInUnits } from "../../shared/locations";
import {
  digitsOf,
  locate,
  type PlainInput,
  resultText,
  shownCarries,
  workPlain,
  writtenNumbers,
  writtenValue,
} from "../../shared/plainFigures";
import { anchorsOf, cellNumber } from "../../shared/units";
import type { CalculatedFigure, FigureInput } from "../api";
import { WORKBOOK_TOOLS } from "../tools";
import {
  type CalculationSessionOptions,
  createCalculationSession,
  FIX_FIGURES,
  type FigureProblem,
  givenList,
  MAX_CALLS_PER_ANSWER,
  MAX_FIGURES_PER_CALL,
  UNSURE_INPUT,
  whole,
} from "./calculations";
import { type Quoted, type QuoteInput, quotePlaceProblem } from "./citations";
import type { CiteOptions } from "./engine";
import { setAsideRowsOf } from "./sheetRows";

interface GivenInput {
  name: string;
  label: string;
  value: number | null;
  /** The number as the quote writes it, when the model named it. */
  written: string | null;
  citation: number | null;
  record: QuoteInput | null;
}

interface GivenFigure {
  marker: number | null;
  label: string;
  formula: string;
  inputs: GivenInput[];
  /** Numbers written in the formula that the model says are constants of the arithmetic. */
  constants: number[];
}

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | null =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : null;

/** A value given as a number, or as a number written plainly ("45600000", "1.42"). */
function plainValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?\s*$/i.test(value))
    return null;
  return Number(value);
}

function givenInput(value: unknown): GivenInput {
  const input = fields(value);
  const quote = text(input.quote);
  const passage = text(input.passage);
  return {
    name: text(input.name) ?? "",
    label: text(input.label) || text(input.name) || "",
    value: plainValue(input.value),
    written: text(input.number),
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
  };
}

function givenFigure(value: unknown): GivenFigure {
  const figure = fields(value);
  return {
    marker: whole(figure.marker),
    label: text(figure.label) ?? "",
    formula: text(figure.formula) ?? "",
    inputs: givenList(figure.inputs).map(givenInput),
    constants: givenList(figure.constants).flatMap((each) => {
      const value = plainValue(each);
      return value === null ? [] : [value];
    }),
  };
}

/**
 * The cell of a workbook's rows that holds an input's number, found by its digits among the cells
 * the quote covers; null outside a sheet's rows, or when more than one cell has those digits.
 */
function cellOf(quoted: Quoted, value: number): FigureInput["cell"] {
  const { units } = quoted;
  if (!units.some((unit) => unit.kind === "rows")) return null;
  const ranges = quoteInUnits(units, quoted.citation.quote);
  if (!ranges) return null;
  const digits = digitsOf(value);
  const cells = anchorsCovered(units, ranges).filter(({ unit, target }) => {
    const anchor = anchorsOf(unit).find((each) => each.target === target);
    return (
      anchor !== undefined &&
      writtenNumbers(unit.text.slice(anchor.start, anchor.end)).some(
        (each) => each.digits === digits,
      )
    );
  });
  const [only, ...more] = cells;
  if (!only || more.length > 0) return null;
  return {
    sheet: only.unit.label?.sheet ?? null,
    ref: only.target,
    stored: cellNumber(only.unit.label, only.target),
  };
}

/**
 * The inputs read from rows the file strikes through or hides (#1979), said after the figure: a
 * total over an earlier version's rows read as the sheet's current one. "" when none is.
 */
function setAsideNote(
  inputs: readonly { name: string; quoted: Quoted; cell: FigureInput["cell"] }[],
) {
  const said = inputs.flatMap(({ name, quoted, cell }) => {
    const row = Number(/\d+$/.exec(cell?.ref ?? "")?.[0]);
    const how =
      cell && Number.isInteger(row) ? setAsideRowsOf(quoted.units)(cell.sheet, row) : null;
    return how ? [`${name} is in row ${row}, which the file ${how}`] : [];
  });
  if (said.length === 0) return "";
  return ` ${said.join("; ")}: the file has set ${said.length === 1 ? "that row" : "those rows"} aside, so a figure from ${said.length === 1 ? "it" : "them"} is never the sheet's current one. Where you give this figure, say so.`;
}

interface Recorded {
  figure: CalculatedFigure;
  quotes: { input: Quoted; source: number | QuoteInput }[];
  cited?: readonly QuoteInput[];
}

/** What the model is told a recorded figure came to: "Recorded [=1] = 66560 (Saving (£): 512,000 × 0.13 = 66,560)." */
const told = (marker: number, figure: CalculatedFigure, working: string) =>
  `Recorded [=${marker}] = ${figure.shown} (${figure.label ? `${figure.label}: ` : ""}${working}).`;

/** How an Answer writes its figures, told after they are recorded. */
const WRITE_FIGURES =
  'Write each figure in your text as it should read, with its unit and scale, and its marker right after it, as in "grew 20.4% [=1] in 2025".';

/** A figure an Answer's text writes at its marker that doesn't carry its result, or has none. */
export interface UnwrittenFigure {
  marker: number;
  /** Null when no figure was recorded for the marker. */
  result: string | null;
  /** What the text writes right before the marker; null when it writes no number there. */
  wrote: string | null;
}

/** Where `text` writes code, fenced or inline: a marker there is how it is written, not a figure. */
const codeSpans = (text: string): [number, number][] =>
  [...text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((found) => [
    found.index,
    found.index + found[0].length,
  ]);

/** `text` with its Citation and figure markers blanked, so their digits are never a figure's. */
const withoutMarkers = (text: string): string =>
  text.replace(/\[(?:\^|=)[^\]\n]{1,12}\]/g, (marker) => " ".repeat(marker.length));

/** Where the sentence, line or table cell that ends `before` starts. */
function clauseStart(before: string): number {
  let start = 0;
  for (const found of before.matchAll(/[.!?;](?=\s)|[。！？；\n|]/gu)) start = found.index + 1;
  return start;
}

/** What an Answer's model is asked once more with, a line for each figure it didn't write. */
export function unwrittenFiguresNote(unwritten: readonly UnwrittenFigure[]): string {
  const lines = unwritten.map(({ marker, result, wrote }) =>
    result === null
      ? `[=${marker}] has no figure, so "${wrote}" before it isn't worked out: fix it with calculate, or leave that number out.`
      : wrote === null
        ? `[=${marker}] is ${result}, and its sentence writes no number with those digits before its marker.`
        : `[=${marker}] is ${result}, and "${wrote}" right before its marker doesn't write it.`,
  );
  return `${lines.join("\n")}\n${WRITE_FIGURES} Write your reply again.`;
}

/**
 * One Answer's or check's figures: what `calculate` takes, and the figures by marker. A check's
 * model only reads the results: `checking`.
 */
export function createPlainCalculator(options: CalculationSessionOptions & { checking?: boolean }) {
  const { quotes, language } = options;
  // A quoted number an Analysis takes as an input is read as it was: run_analysis is unchanged.
  const analysisNumbers = createCalculationSession(options);
  const recorded = new Map<number, Recorded>();
  const failed = new Map<number, FigureProblem>();
  let calls = 0;

  function quoteOf(
    given: GivenInput,
    options: CiteOptions,
  ): { quoted: Quoted; source: number | QuoteInput; unsure: readonly string[] } | string {
    let quoted: Quoted;
    let source: number | QuoteInput;
    if (given.citation !== null) {
      const found = quotes.recorded(given.citation);
      if (!found)
        return `[^${given.citation}] isn't recorded; record it with cite first, or give passage, location and quote.`;
      quoted = found;
      source = given.citation;
    } else if (given.record) {
      const found = quotes.quote(given.record, options);
      if ("problem" in found) return found.problem;
      quoted = found;
      source = given.record;
    } else {
      return "give citation (the marker of a record you gave cite), or passage, location and quote.";
    }
    // A quote must place its number in one place of its Units (#1979).
    const place = quotePlaceProblem(quoted.citation.quote, quoted.units, quoted.matching);
    if (place) return place;
    const { check, checkReason, unsure } = quoted.check();
    if (check === "found") return { quoted, source, unsure: [] };
    // A scan's unsure words don't stop the page being read: a number in one is refused (#535).
    if (checkReason === "unsure-word") return { quoted, source, unsure: unsure ?? [] };
    return `the quote isn't word for word in ${quoted.passage}; copy it exactly.`;
  }

  function work(
    given: GivenFigure,
    marker: number,
    options: CiteOptions,
  ): { recorded: Recorded; working: string; note: string } | { problems: string[] } {
    const lead = `[=${marker}]`;
    const missing = [
      ...(given.inputs.length === 0 ? ["its inputs, each a value and the quote it is in"] : []),
      ...(given.formula === "" ? ["a formula over the inputs' names"] : []),
      ...(given.label === "" ? ["a label that says what the figure is, with its unit"] : []),
    ];
    if (missing.length > 0) return { problems: [`${lead}: give ${missing.join(", ")}.`] };
    if (given.inputs.length > MAX_INPUTS_PER_FIGURE)
      return { problems: [`${lead}: at most ${MAX_INPUTS_PER_FIGURE} inputs in one figure.`] };
    const problems: string[] = [];
    const placed = given.inputs.flatMap((input) => {
      if (!input.name) {
        problems.push(`${lead}: give each input a name the formula uses, such as rev2024.`);
        return [];
      }
      if (input.value === null) {
        problems.push(`${lead} ${input.name}: give value, the number you use, as a plain number.`);
        return [];
      }
      const place = quoteOf(input, options);
      if (typeof place === "string") {
        problems.push(`${lead} ${input.name}: ${place}`);
        return [];
      }
      return [{ input, value: input.value, ...place }];
    });
    if (problems.length > 0) return { problems };
    // A number in a word a scan may have misread, or not found in a quote that holds one, is refused.
    const misread = placed.flatMap(({ input, value, quoted, unsure }) => {
      if (unsure.length === 0) return [];
      const found = locate(value, quoted.citation.quote, input.written);
      return !found ||
        unsure.some((word) => word.includes(found.chars) || found.chars.includes(word))
        ? [`${lead} ${input.name}: ${UNSURE_INPUT}`]
        : [];
    });
    if (misread.length > 0) return { problems: misread };
    const plain: PlainInput[] = placed.map(({ input, value, quoted }) => ({
      name: input.name,
      value,
      quote: quoted.citation.quote,
      written: input.written,
    }));
    const worked = workPlain({ inputs: plain, formula: given.formula });
    if ("problems" in worked)
      return { problems: worked.problems.map((problem) => `${lead} ${problem}`) };
    const cells = placed.map(({ quoted, value }) => cellOf(quoted, value));
    const whatIf = whatIfProblem(
      lead,
      given,
      placed.map(({ input, quoted }, at) => ({
        name: input.name,
        quoted,
        cell: cells[at] ?? null,
      })),
      worked.literals,
    );
    if (whatIf) return { problems: [whatIf] };
    const inputs = placed.map(({ input, value, quoted }, at): FigureInput => {
      const place = worked.located[at] ?? { chars: quoted.citation.quote, start: 0 };
      const written = writtenValue(place.chars) || 1;
      return {
        name: input.name,
        label: input.label,
        citation: quoted.citation,
        number: {
          chars: place.chars,
          at: place.start,
          value,
          scale: Math.abs(value / written) || 1,
          scaleWord: null,
          unit: { kind: "plain" },
          decimals: 0,
          approximate: false,
          reading: null,
        },
        cell: cells[at] ?? null,
        unitStatement: null,
      };
    });
    const figure: CalculatedFigure = {
      label: given.label,
      formula: given.formula,
      inputs,
      value: worked.value,
      unit: { kind: "plain" },
      approximate: false,
      shown: resultText(worked.value),
      show: { language, as: null, decimals: null, scale: null },
      literals: worked.literals,
      engine: FORMULA_VERSION,
      written: null,
    };
    return {
      recorded: {
        figure,
        quotes: placed.map(({ quoted, source }) => ({ input: quoted, source })),
      },
      working: worked.working,
      note: setAsideNote(
        placed.map(({ input, quoted }, at) => ({
          name: input.name,
          quoted,
          cell: cells[at] ?? null,
        })),
      ),
    };
  }

  /**
   * A number written into a figure's formula beside a cell its workbook's formulas work out or read
   * (#2372): a what-if worked out by hand leaves out every formula between them. Null when there is
   * none, or the model named each such number a constant of the arithmetic.
   */
  function whatIfProblem(
    lead: string,
    given: GivenFigure,
    inputs: readonly { name: string; quoted: Quoted; cell: FigureInput["cell"] }[],
    literals: readonly { text: string; value: number }[],
  ): string | null {
    const { partOfFormulas } = options;
    if (!partOfFormulas) return null;
    const written = literals.filter(
      (literal) =>
        literal.value !== 0 &&
        literal.value !== 1 &&
        !given.constants.some((constant) => sameNumber(constant, literal.value)),
    );
    if (written.length === 0) return null;
    const cells = inputs.flatMap(({ name, quoted, cell }) => {
      const sheet = cell?.sheet;
      return cell && sheet && partOfFormulas(quoted.citation, sheet, cell.ref)
        ? [{ name, at: `${sheet}!${cell.ref}`, book: quoted.citation.documentName }]
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

  function calculate(list: readonly unknown[], { structured = false }: CiteOptions = {}): string {
    if (!structured && ++calls > MAX_CALLS_PER_ANSWER)
      return "You have called calculate enough for this Question: write the Answer now with the figures recorded, and say which numbers couldn't be calculated rather than working them out.";
    if (list.length === 0)
      return `Nothing was recorded. ${FIX_FIGURES}\n- give each figure with its marker, label, inputs and formula.`;
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
      const earlier = recorded.get(marker)?.figure;
      if (earlier?.analysis !== undefined || earlier?.workbook !== undefined) {
        problems.push(
          `[=${marker}] belongs to ${earlier.analysis ? "an Analysis" : "a workbook's formulas"}. Keep that marker for its result; choose a new marker for this calculation.`,
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
      const before = recorded.get(marker)?.figure;
      recorded.set(marker, outcome.recorded);
      failed.delete(marker);
      options.onRecord?.(marker, outcome.recorded.figure);
      lines.push(
        told(marker, outcome.recorded.figure, outcome.working) +
          outcome.note +
          (before && before.formula !== outcome.recorded.figure.formula
            ? ` It replaces the earlier [=${marker}] = ${before.shown}: give each figure a marker of its own.`
            : ""),
      );
    }
    const done = lines.length > 0 ? lines.join("\n") : "Nothing was recorded.";
    const next =
      problems.length > 0
        ? `\n${FIX_FIGURES}\n- ${problems.join("\n- ")}`
        : options.checking
          ? ""
          : `\n${WRITE_FIGURES}`;
    return `${done}${next}`;
  }

  /**
   * `text` with each figure's marker right after the number before it, in its sentence or cell, whose
   * digits are the figure's result: a model often writes words between the two ("rose by €4,150
   * thousand in 2025 [=1]"). A marker with no such number stays where it is.
   */
  function placed(text: string): string {
    let out = text;
    const code = codeSpans(text);
    for (const match of [...text.matchAll(FIGURE_MARKER)].reverse()) {
      if (code.some(([from, to]) => match.index >= from && match.index < to)) continue;
      const figure = recorded.get(Number(match[1]))?.figure;
      if (!figure || figure.analysis || figure.workbook || typeof figure.value !== "number")
        continue;
      const value = figure.value;
      const before = out.slice(0, match.index);
      const start = clauseStart(before);
      const found = readFigures(withoutMarkers(before.slice(start)), { language })
        .filter((each) => shownCarries(each.chars, value))
        .at(-1);
      if (!found) continue;
      const end = start + found.end;
      if (out.slice(end, match.index).trim() === "") continue;
      const without =
        out.slice(0, match.index).trimEnd() + out.slice(match.index + match[0].length);
      out = `${without.slice(0, end)} ${match[0]}${without.slice(end)}`;
    }
    return out;
  }

  /** Each figure marker `text` writes, its figure's entry and result, and what the text writes before it. */
  function atMarkers(text: string) {
    return [...text.matchAll(FIGURE_MARKER)].flatMap((match) => {
      const marker = Number(match[1]);
      const entry = recorded.get(marker) ?? null;
      const figure = entry?.figure;
      if (figure?.analysis || figure?.workbook) return [];
      if (figure && typeof figure.value !== "number") return [];
      const wrote = writtenBefore(text.slice(0, match.index), language);
      return [
        { marker, entry, value: typeof figure?.value === "number" ? figure.value : null, wrote },
      ];
    });
  }

  return {
    calculate,

    /** The reply is made anew from the same request (#2925): the figures it worked out are forgotten. */
    anew(): void {
      recorded.clear();
      failed.clear();
      calls = 0;
      analysisNumbers.anew();
    },

    /** A number in a quote as an Analysis takes it (#447), read as it always was. */
    number: analysisNumbers.number,

    /** Records a figure an Analysis or a workbook's formulas gave (#447, #2347) under the next free marker above `above`. */
    record(figure: CalculatedFigure, cited: readonly QuoteInput[] = [], above = 0): number {
      const marker = Math.max(above, ...recorded.keys()) + 1;
      recorded.set(marker, { figure, quotes: [], cited });
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

    placed,

    /** Each figure `text` writes before its marker with its result's digits shows as written there. */
    written(text: string): void {
      for (const { entry, value, wrote } of atMarkers(placed(text))) {
        if (entry && value !== null && wrote !== null && shownCarries(wrote, value))
          entry.figure = { ...entry.figure, shown: wrote };
      }
    },

    /**
     * The figures `text` writes at their markers without their results' digits, and the numbers it
     * writes before a marker no figure was recorded for, each once.
     */
    unwritten(text: string): UnwrittenFigure[] {
      const seen = new Set<number>();
      return atMarkers(placed(text)).flatMap(({ marker, value, wrote }) => {
        if (seen.has(marker)) return [];
        if (value === null ? wrote === null : wrote !== null && shownCarries(wrote, value))
          return [];
        seen.add(marker);
        return [{ marker, result: value === null ? null : resultText(value), wrote }];
      });
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
            const quote = entry.quotes[index];
            return quote
              ? { ...input, citation: { ...input.citation, ...quote.input.check() } }
              : input;
          }),
        };
      }
    },
  };
}

export type PlainCalculator = ReturnType<typeof createPlainCalculator>;
