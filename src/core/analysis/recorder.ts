/**
 * What an Answer's Analyses give, as the Answer writes it: each `figure()`
 * figure IncarnaMind worked out again to the same number, and each other
 * figure, recorded as one of the Answer's calculated figures with its marker
 * ("[=3]"), and each table, chart and picture numbered across the Answer
 * ("[=table 2]"). One recorder serves every Analysis an Answer runs, in
 * Pyodide or in the OS sandbox (ADR-0025), so their numbers never collide.
 */
import type { AnalysisInput, AnalysisOutput, AnalysisValue } from "../../shared/analysis";
import { figureText, rawColumn } from "../../shared/figures";
import {
  FORMULA_VERSION,
  type FormulaResult,
  type ResultUnit,
  showResult,
} from "../../shared/formula";
import type { AnswerAnalysis, CalculatedFigure } from "../api";
import type { Language } from "../language";
import { recalculate } from "./figureRows";
import { checkTableColumns } from "./tableRules";

/** The most Analyses one Answer runs: a seventh is refused, so the model answers. */
export const MAX_ANALYSES_PER_ANSWER = 6;

/** What models give as a figure's unit to say it has none, taking unit for its type. */
const NO_UNIT = /^(?:number|numeric|float|int|integer|value|none|null|unitless|-)$/i;

/** A figure statistics give far below 0.01, such as a p-value, which two decimals show as 0.00. */
const TINY = 0.005;

function unitOf(unit: string | null): ResultUnit {
  if (!unit || NO_UNIT.test(unit.trim())) return { kind: "plain" };
  if (/^[A-Z]{3}$/.test(unit)) return { kind: "currency", code: unit };
  if (unit === "%" || /^percent$/i.test(unit)) return { kind: "percent" };
  return { kind: "other", word: unit };
}

export interface AnalysisRecorderOptions {
  /** Records a figure an Analysis gave as one of the Answer's calculated figures: its marker. */
  figure(figure: CalculatedFigure): number;
  /** The Answer's language, which its figures are shown in. */
  language: Language;
}

export function createAnalysisRecorder(options: AnalysisRecorderOptions) {
  let runs = 0;
  let tables = 0;
  let charts = 0;
  let pictures = 0;

  const shownFigure = (result: Extract<AnalysisValue, { kind: "figure" }>, analysis: number) => {
    const unit = unitOf(result.unit);
    const worked: FormulaResult = {
      ok: true,
      version: FORMULA_VERSION,
      value: result.value,
      unit,
      approximate: false,
      literals: [],
      scales: [],
    };
    // A count a model gives (its observations, a cluster's size) is whole: "29", not "29.00", and
    // a whole total is written out, "9,450", never rounded to a scale word (#2378).
    const whole = unit.kind === "plain" && Number.isInteger(result.value);
    const show = { language: options.language, as: null, decimals: whole ? 0 : null, scale: null };
    const shown = showResult(worked, show);
    const figure: CalculatedFigure = {
      label: result.label,
      formula: "",
      inputs: [],
      value: result.value,
      unit,
      approximate: false,
      shown: rawColumn(result.label)
        ? String(result.value)
        : unit.kind === "plain" && result.value !== 0 && Math.abs(result.value) < TINY
          ? String(Number(result.value.toPrecision(2)))
          : shown.ok && !whole
            ? shown.shown
            : figureText(options.language, result.value),
      show,
      literals: [],
      engine: FORMULA_VERSION,
      written: null,
      analysis: { analysis, result: result.name },
    };
    return options.figure(figure);
  };

  return {
    /** The Answer has run as many Analyses as it may: the next is refused before anything runs. */
    full: (): boolean => runs >= MAX_ANALYSES_PER_ANSWER,
    /** The next Analysis's number, from 1. */
    next: (): number => ++runs,
    /**
     * The markers of what a finished run gave, a `figure()` figure's only when the cells of
     * `inputs`, as IncarnaMind read them, come to the same number; and what each such check found.
     */
    mark(
      number: number,
      output: AnalysisOutput,
      inputs: readonly AnalysisInput[],
    ): Pick<AnswerAnalysis, "markers" | "recalculations" | "tableChecks"> {
      const markers: AnswerAnalysis["markers"] = {
        figures: [],
        tables: [],
        charts: [],
        pictures: [],
      };
      const recalculations: NonNullable<AnswerAnalysis["recalculations"]> = [];
      const tableChecks: NonNullable<AnswerAnalysis["tableChecks"]> = [];
      for (const result of output.results) {
        if (result.kind === "table") {
          markers.tables.push({ result: result.name, marker: ++tables });
          tableChecks.push({
            table: { result: result.name },
            columns: checkTableColumns(result.table, inputs),
          });
          continue;
        }
        if (result.of?.how) {
          const check = recalculate(result.value, result.of, inputs);
          recalculations.push({ result: result.name, check });
          if (check.kind !== "same") continue;
        }
        markers.figures.push({ result: result.name, marker: shownFigure(result, number) });
      }
      output.charts.forEach((chart, index) => {
        markers.charts.push(++charts);
        tableChecks.push({
          table: { chart: index },
          columns: checkTableColumns(chart.table, inputs),
        });
      });
      for (const _picture of output.pictures ?? []) markers.pictures?.push(++pictures);
      return {
        markers,
        ...(recalculations.length > 0 && { recalculations }),
        ...(tableChecks.length > 0 && { tableChecks }),
      };
    },
  };
}

export type AnalysisRecorder = ReturnType<typeof createAnalysisRecorder>;

export const noMarkers = (): AnswerAnalysis["markers"] => ({
  figures: [],
  tables: [],
  charts: [],
  pictures: [],
});
