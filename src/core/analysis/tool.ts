import { type AnalysisInput, type AnalysisValue, noAnalysisOutput } from "../../shared/analysis";
import { figureText, rawColumn } from "../../shared/figures";
import {
  FORMULA_VERSION,
  type FormulaResult,
  type ResultUnit,
  showResult,
} from "../../shared/formula";
import type { UnitText } from "../../shared/units";
import type { AnalysisRuntime } from "../adapters";
import type {
  AnalysisFigureInput,
  AnalysisRangeInput,
  AnswerAnalysis,
  CalculatedFigure,
  Citation,
  FigureInput,
} from "../api";
import type { CitationSource } from "../documents";
import type { Language } from "../language";
import { ANALYSIS_TOOLS, type Tool, type ToolProviderInfo } from "../tools";
import { runAnalysis, sha256 } from ".";
import { recalculate } from "./figureRows";
import { parseRange, readRange, sheetRows, sheetsOf } from "./ranges";
import { analysisReport } from "./report";

/** The most Analyses one Answer runs: a seventh is refused, so the model answers. */
export const MAX_ANALYSES_PER_ANSWER = 6;

const ANALYSIS_PROVIDER: ToolProviderInfo = { kind: "analysis", id: "analysis", name: "Analysis" };

export interface AnalysisToolOptions {
  runtime: AnalysisRuntime;
  /** A Passage the model was given, by its id ("P3"), and the Units of the Document version it is of. */
  passage(id: string): { source: CitationSource; units: UnitText[] } | null;
  /** A number in a quote, read as `calculate` reads an input; or why it can't be. */
  number(given: unknown): { input: FigureInput } | { problem: string };
  /** Records a figure the Analysis gave as one of the Answer's calculated figures: its marker. */
  figure(figure: CalculatedFigure): number;
  /** The Answer's language, which its figures are shown in. */
  language: Language;
  now(): Date;
  /** An Analysis ran, for its Tool call: the record the Answer keeps. */
  ran(toolCallId: string, analysis: AnswerAnalysis): void;
}

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

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

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Read =
  | {
      ok: true;
      job: AnalysisInput;
      record: Omit<AnalysisRangeInput, "sha256"> | Omit<AnalysisFigureInput, "sha256">;
    }
  | { ok: false; problem: string };

type ReadInput = Extract<Read, { ok: true }>;

/**
 * Two inputs that read the same cells of one sheet. Every Passage of a sheet reads the whole
 * sheet, so a model that gives each Passage it found as an input, then joins them, counts each
 * row as often (#2346): such inputs are refused before anything runs.
 */
function readTwice(reads: readonly ReadInput[]): string | null {
  const ranges = reads.flatMap((read) =>
    read.job.kind === "table" && read.record.kind === "range"
      ? [{ job: read.job, citation: read.record.citation }]
      : [],
  );
  const rowsOf = (job: (typeof ranges)[number]["job"]) =>
    job.rowNumbers ?? job.rows.map((_, index) => job.firstRow + index);
  for (const [at, first] of ranges.entries()) {
    const rows = new Set(rowsOf(first.job));
    for (const second of ranges.slice(at + 1)) {
      const sameSheet =
        first.citation.documentId === second.citation.documentId &&
        sheetOf(first.citation) === sheetOf(second.citation);
      if (!sameSheet) continue;
      const sharesRows = rowsOf(second.job).some((row) => rows.has(row));
      const sharesColumns = second.job.columns.some((column) => first.job.columns.includes(column));
      if (!sharesRows || !sharesColumns) continue;
      const sheet = sheetOf(first.citation);
      return `"${first.job.name}" and "${second.job.name}" read the same rows of ${sheet ? `the sheet "${sheet}" in ` : ""}"${first.citation.documentName}", so joined they would count each row twice. Every Passage of a sheet reads the whole sheet: give the sheet once, as one input, and pick its rows in the code`;
    }
  }
  return null;
}

const sheetOf = (citation: Citation): string | null =>
  citation.location?.kind === "rows" ? citation.location.sheet : null;

export function analysisTool(options: AnalysisToolOptions): Tool {
  let runs = 0;
  let tables = 0;
  let charts = 0;
  let pictures = 0;

  const readRangeInput = (name: string, given: Record<string, unknown>): Read => {
    const passageId = text(given.passage);
    const found = options.passage(passageId);
    if (!found)
      return { ok: false, problem: `${passageId || "passage"} isn't a Passage you were given` };
    const { source, units } = found;
    const parsed = parseRange(text(given.range) || undefined);
    if (!parsed.ok) return { ok: false, problem: parsed.problem };
    const sheets = sheetsOf(units);
    if (sheets.length === 0) {
      return {
        ok: false,
        problem: `${passageId} is in ${source.documentName}, which has no sheet or CSV rows`,
      };
    }
    const own = units.find(
      (unit) => unit.kind === "rows" && unit.page !== null && unit.page === source.pageFrom,
    );
    const sheet = parsed.sheet ?? text(given.sheet) ?? null;
    const named = sheet || (own?.label?.sheet ?? null);
    if (!sheets.includes(named)) {
      return {
        ok: false,
        problem: `${source.documentName} has no sheet "${named}"; its sheets are ${sheets.map((each) => `"${each}"`).join(", ")}`,
      };
    }
    const read = readRange(sheetRows(units, named), parsed.bounds);
    if (!read || read.rows.length === 0) {
      return {
        ok: false,
        problem: `the range has no rows under its headings in ${source.documentName}`,
      };
    }
    const heading = units.find(
      (unit) =>
        unit.kind === "rows" &&
        (unit.label?.sheet ?? null) === named &&
        unit.label?.rows?.includes(read.headingRow),
    );
    const headingLine = heading?.label?.rows?.indexOf(read.headingRow) ?? -1;
    const citation: Citation = {
      passageId: source.passageId,
      documentId: source.documentId,
      documentName: source.documentName,
      contentHash: source.contentHash,
      pageFrom: source.pageFrom,
      pageTo: source.pageTo,
      location: {
        kind: "rows",
        sheet: named,
        from: read.headingRow,
        to: read.rowNumbers.at(-1) ?? read.headingRow,
      },
      quote: heading?.text.split("\n")[headingLine] ?? source.text,
      check: "found",
      checkReason: null,
    };
    const record: Omit<AnalysisRangeInput, "sha256"> = {
      kind: "range",
      name,
      citation: heading?.page ? { ...citation, pageFrom: heading.page } : citation,
      range: read.range,
      rows: read.rows.length,
      columns: read.columns.length,
      rowCount: read.rowCount,
      cut: read.cut,
    };
    return {
      ok: true,
      job: {
        kind: "table",
        name,
        columns: read.columns,
        rows: read.rows,
        firstRow: read.rowNumbers[0] ?? 2,
        rowNumbers: read.rowNumbers,
      },
      record,
    };
  };

  const readInput = (given: unknown): Read => {
    const input = fields(given);
    const name = text(input.name);
    if (!NAME.test(name)) {
      return { ok: false, problem: `give each input a name the code reads it by, such as "sales"` };
    }
    const lead = (read: Read): Read =>
      read.ok ? read : { ok: false, problem: `${name}: ${read.problem}` };
    if (input.number === undefined && input.value === undefined && input.passage !== undefined) {
      return lead(readRangeInput(name, input));
    }
    const read = options.number(input);
    if ("problem" in read) return lead({ ok: false, problem: read.problem });
    const value = read.input.number.value;
    return {
      ok: true,
      job: { kind: "number", name, value },
      record: { kind: "figure", name, input: read.input },
    };
  };

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
    // A count a model gives (its observations, a cluster's size) is whole: "29", not "29.00".
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
          : shown.ok
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
    name: ANALYSIS_TOOLS.run,
    provider: ANALYSIS_PROVIDER,
    providerTool: ANALYSIS_TOOLS.run,
    description:
      'Run Python over sheets and CSV files you found, to work out totals, groups, changes, tables, statistics and models. Give title, inputs and code. An input is a range, {"name": "sales", "passage": "P3", "range": "A1:F1240"} (range optional: the whole sheet, its first row the headings; every Passage of a sheet reads the whole sheet, so give each sheet once), or a quoted number as calculate takes one, {"name": "rate", "citation": 1, "number": "5%"}. The code has pd (pandas) and np (numpy) imported, can import scipy, statsmodels, sklearn and matplotlib, and reads inputs["sales"] (a DataFrame whose index is each row\'s number in the sheet, named row) and inputs["rate"] (a number). Give each sum, mean, min, max or count of an input\'s column with figure(name, df["Revenue"], "sum", label, unit), after any filtering: IncarnaMind works it out again from the cells. Give any other figure or table with result(name, value, label, unit), each a number or a table; a figure a model or test works out (a coefficient, a forecast, a p-value) also names the input\'s rows it used: result("slope", fit.params["Price"], "Slope", of=df). For a percent figure, give a fraction: result("growth", 0.081, "Growth", "%") shows 8.1%. step(label, df) records each step that changes the rows, chart(kind, df, x, y, title) draws a bar, line, pie or scatter chart, and a plot drawn with matplotlib.pyplot comes back as a picture (its text in Latin letters or common Chinese characters). The result says each figure\'s marker [=n], each table\'s [=table n], each chart\'s [=chart n] and each picture\'s [=picture n].',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: 'What it works out: "Revenue by region, 2025".' },
        inputs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              passage: { type: "string" },
              range: { type: "string" },
              sheet: { type: "string" },
              citation: { type: "number" },
              location: { type: "string" },
              quote: { type: "string" },
              number: { type: "string" },
              unitQuote: { type: "string" },
            },
            required: ["name"],
          },
        },
        code: {
          type: "string",
          description:
            "Python 3 with pandas and numpy; scipy, statsmodels, sklearn and matplotlib can be imported.",
        },
      },
      required: ["title", "inputs", "code"],
    },
    shownInput: ({ title }) => ({ title: text(title) }),
    effects: () => [
      { action: "read", scope: { kind: "documents" } },
      { action: "execute", scope: { kind: "sandbox" } },
    ],
    // What the code prints and gives comes from the User's Documents.
    untrustedResult: true,
    async call(input, { toolCallId, signal }) {
      if (runs >= MAX_ANALYSES_PER_ANSWER) {
        return `You have run ${MAX_ANALYSES_PER_ANSWER} analyses for this Question, as many as one Answer may: answer now with their results.`;
      }
      const title = text(input.title) || "Analysis";
      const code = typeof input.code === "string" ? input.code : "";
      if (!code.trim()) return "Give the code to run.";
      const given = Array.isArray(input.inputs) ? input.inputs : [];
      const reads = given.map(readInput);
      const problems = reads.flatMap((read) => (read.ok ? [] : [read.problem]));
      const names = reads.flatMap((read) => (read.ok ? [read.job.name] : []));
      const twice = names.filter((name, index) => names.indexOf(name) !== index);
      if (twice.length > 0) problems.push(`${twice[0]}: two inputs have this name`);
      const same = readTwice(reads.flatMap((read) => (read.ok ? [read] : [])));
      if (same) problems.push(same);
      if (problems.length > 0) {
        return `Nothing ran. Fix the inputs and run it again:\n- ${problems.join("\n- ")}`;
      }
      const number = ++runs;
      const ok = reads.flatMap((read) => (read.ok ? [read] : []));
      const run = await runAnalysis(
        options.runtime,
        { language: "python", code, inputs: ok.map((read) => read.job) },
        signal,
      );
      const output = run.result.end.kind === "unavailable" ? noAnalysisOutput() : run.result.output;
      const usable = run.result.end.kind === "done";
      const markers: AnswerAnalysis["markers"] = {
        figures: [],
        tables: [],
        charts: [],
        pictures: [],
      };
      const recalculations: NonNullable<AnswerAnalysis["recalculations"]> = [];
      if (usable) {
        const jobInputs = ok.map((read) => read.job);
        for (const result of output.results) {
          if (result.kind === "table") {
            markers.tables.push({ result: result.name, marker: ++tables });
            continue;
          }
          if (result.of?.how) {
            const check = recalculate(result.value, result.of, jobInputs);
            recalculations.push({ result: result.name, check });
            if (check.kind !== "same") continue;
          }
          markers.figures.push({ result: result.name, marker: shownFigure(result, number) });
        }
        for (const _chart of output.charts) markers.charts.push(++charts);
        for (const _picture of output.pictures ?? []) markers.pictures?.push(++pictures);
      }
      const analysis: AnswerAnalysis = {
        number,
        title,
        language: "python",
        code,
        inputs: await Promise.all(
          ok.map(async (read) => ({
            ...read.record,
            sha256: await sha256(
              JSON.stringify(
                read.job.kind === "table" ? [read.job.columns, read.job.rows] : read.job.value,
              ),
            ),
          })),
        ),
        versions: run.versions,
        codeSha256: run.code,
        outputSha256: run.output,
        end: run.result.end,
        output,
        ms: run.result.ms,
        ranAt: options.now().toISOString(),
        markers,
        ...(recalculations.length > 0 && { recalculations }),
      };
      options.ran(toolCallId, analysis);
      return analysisReport(analysis, options.language);
    },
  };
}
