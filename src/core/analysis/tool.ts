import { type AnalysisInput, noAnalysisOutput } from "../../shared/analysis";
import type { UnitText } from "../../shared/units";
import type { AnalysisRuntime } from "../adapters";
import { setAsideRowsOf } from "../answers/sheetRows";
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
import { documentTableInput } from "./documentTables";
import {
  type AnalysisRecorder,
  createAnalysisRecorder,
  MAX_ANALYSES_PER_ANSWER,
  noMarkers,
} from "./recorder";

export { MAX_ANALYSES_PER_ANSWER };

import { parseRange, type ReadRange, readRange, sheetRows, sheetsOf } from "./ranges";
import { analysisReport } from "./report";

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
  /** Numbers its runs and their results, shared with `run_code` in the same Answer. */
  recorder?: AnalysisRecorder;
  /** Whether run_code can take a range cut here, at this call: then it is run again there. */
  codeOffered?: () => boolean;
}

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

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
 * Two inputs that read the same cells of one sheet or Document table. Every Passage of a sheet
 * or a table reads the whole of it, so a model that gives each Passage it found as an input, then
 * joins them, counts each row as often (#2346): such inputs are refused before anything runs.
 */
function readTwice(reads: readonly ReadInput[]): string | null {
  const ranges = reads.flatMap((read) =>
    read.job.kind === "table" && read.record.kind === "range"
      ? [{ job: read.job, citation: read.record.citation, table: read.record.table?.number }]
      : [],
  );
  const rowsOf = (job: (typeof ranges)[number]["job"]) =>
    job.rowNumbers ?? job.rows.map((_, index) => job.firstRow + index);
  for (const [at, first] of ranges.entries()) {
    const rows = new Set(rowsOf(first.job));
    for (const second of ranges.slice(at + 1)) {
      const sameSheet =
        first.citation.documentId === second.citation.documentId &&
        sheetOf(first.citation) === sheetOf(second.citation) &&
        first.table === second.table;
      if (!sameSheet) continue;
      const sharesRows = rowsOf(second.job).some((row) => rows.has(row));
      const sharesColumns = second.job.columns.some((column) => first.job.columns.includes(column));
      if (!sharesRows || !sharesColumns) continue;
      const sheet = sheetOf(first.citation);
      return `"${first.job.name}" and "${second.job.name}" read the same rows of ${sheet ? `the sheet "${sheet}" in ` : ""}"${first.citation.documentName}", so joined they would count each row twice. ${first.table === undefined ? "Every Passage of a sheet reads the whole sheet: give the sheet once" : `Every Passage of table ${first.table} reads the whole table: give it once`}, as one input, and pick its rows in the code`;
    }
  }
  return null;
}

/** What the model reads once an Answer has run as many Analyses as it may. */
export const analysesAtTheLimit = () =>
  `You have run ${MAX_ANALYSES_PER_ANSWER} analyses for this Question, as many as one Answer may: answer now with their results.`;

const sheetOf = (citation: Citation): string | null =>
  citation.location?.kind === "rows" ? citation.location.sheet : null;

/**
 * A range of a sheet as an Analysis reads it: the job's table, its rows numbered as the sheet
 * numbers them, and the record the Answer keeps, cited to its rows under `source`'s Passage,
 * quoting the headings. `units` are those its rows were read from.
 */
export function rangeInput(
  name: string,
  source: CitationSource,
  units: readonly UnitText[],
  named: string | null,
  read: ReadRange,
): { job: Extract<AnalysisInput, { kind: "table" }>; record: Omit<AnalysisRangeInput, "sha256"> } {
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
  // A sum over a sheet that keeps an earlier version of its rows counted both (#1979); a paid
  // invoice struck through in a tracker is still one to count. The code reads every row, told
  // which ones the file sets aside.
  const setAsideHow = setAsideRowsOf(units);
  const setAside = {
    struck: read.rowNumbers.filter((row) => setAsideHow(named, row)?.includes("strikes")),
    hidden: read.rowNumbers.filter((row) => setAsideHow(named, row)?.includes("hides")),
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
    ...(setAside.struck.length + setAside.hidden.length > 0 && { setAside }),
  };
  return {
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
}

export function analysisTool(options: AnalysisToolOptions): Tool {
  const recorder = options.recorder ?? createAnalysisRecorder(options);

  const readRangeInput = (name: string, given: Record<string, unknown>): Read => {
    const passageId = text(given.passage);
    const found = options.passage(passageId);
    if (!found)
      return { ok: false, problem: `${passageId || "passage"} isn't a Passage you were given` };
    const { source, units } = found;
    const parsed = parseRange(text(given.range) || undefined);
    if (!parsed.ok) return { ok: false, problem: parsed.problem };
    const sheets = sheetsOf(units);
    if (sheets.length === 0) return documentTableInput(name, given, source, units);
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
    return { ok: true, ...rangeInput(name, source, units, named, read) };
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

  return {
    name: ANALYSIS_TOOLS.run,
    provider: ANALYSIS_PROVIDER,
    providerTool: ANALYSIS_TOOLS.run,
    description:
      'Run Python over sheets, CSV files and the tables of PDF, Word and PowerPoint files you found, to work out totals, groups, changes, tables, statistics and models. Give title, inputs and code. An input is a range, {"name": "sales", "passage": "P3", "range": "A1:F1240"} (range optional: the whole sheet, its first row the headings; every Passage of a sheet reads the whole sheet, so give each sheet once; it holds the rows the file strikes through or hides too, which the result names: drop such rows by their numbers where they are an earlier version of rows the sheet shows plainly), a table a Passage of a PDF, Word file or deck shows, {"name": "costs", "passage": "P5"} (the whole table, over every page it runs to, its headings row 1; add "table": 2 where the Passage shows more than one), or a quoted number as calculate takes one, {"name": "rate", "citation": 1, "number": "5%"}. The code has pd (pandas) and np (numpy) imported, can import scipy, statsmodels, sklearn and matplotlib, and reads inputs["sales"] (a DataFrame whose index is each row\'s number in the sheet, named row) and inputs["rate"] (a number). Give each sum, mean, min, max or count of an input\'s column with figure(name, df["Revenue"], "sum", label, unit), after any filtering: IncarnaMind works it out again from the cells. A number of rows is the count of a column every row fills: figure("orders", df["order_id"], "count", "Orders"). Give any other figure or table with result(name, value, label, unit), each a number or a table. Every figure worked out from an input\'s rows (a coefficient, a forecast, a p-value, a share) passes those rows as of=, the DataFrame after any filtering, so its Citation leads to them: result("slope", fit.params["Price"], "Slope", of=df). For a percent figure, give a fraction: result("growth", 0.081, "Growth", "%") shows 8.1%. step(label, df) records each step that changes the rows, chart(kind, df, x, y, title) draws a bar, line, pie or scatter chart, and a plot drawn with matplotlib.pyplot comes back as a picture (its text in Latin letters or common Chinese characters). The result says each figure\'s marker [=n], each table\'s [=table n], each chart\'s [=chart n] and each picture\'s [=picture n].',
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
              table: { type: "number" },
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
      if (recorder.full()) return analysesAtTheLimit();
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
      const number = recorder.next();
      const ok = reads.flatMap((read) => (read.ok ? [read] : []));
      const run = await runAnalysis(
        options.runtime,
        { language: "python", code, inputs: ok.map((read) => read.job) },
        signal,
      );
      const output = run.result.end.kind === "unavailable" ? noAnalysisOutput() : run.result.output;
      const usable = run.result.end.kind === "done";
      const marked = usable
        ? recorder.mark(
            number,
            output,
            ok.map((read) => read.job),
          )
        : { markers: noMarkers() };
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
        ...marked,
      };
      options.ran(toolCallId, analysis);
      return analysisReport(analysis, options.language, options.codeOffered?.() === true);
    },
  };
}
