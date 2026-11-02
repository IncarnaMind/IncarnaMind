/**
 * The `run_code` Tool on its own (ADR-0025), with a stand-in runner: what it keeps of a run and
 * tells the model. A figure() figure is worked out again from the cells IncarnaMind read, and
 * only against a table the code read; only a match gets a marker; a run that ended in an error
 * gives none.
 */
import { describe, expect, test } from "vitest";
import type { ExecResult } from "../../src/core/adapters";
import { readRange, sheetRows, WHOLE } from "../../src/core/analysis/ranges";
import { createAnalysisRecorder } from "../../src/core/analysis/recorder";
import { rangeInput } from "../../src/core/analysis/tool";
import type { AnswerAnalysis, CalculatedFigure } from "../../src/core/api";
import type { CitationSource } from "../../src/core/documents";
import { extractCsv } from "../../src/core/documents/formats/csv";
import type { CodeRun, CodeRunner, CodeTable } from "../../src/core/runCode";
import { runCodeTool } from "../../src/core/runCode/tool";
import { type AnalysisEnd, noAnalysisOutput } from "../../src/shared/analysis";

const SOURCE: CitationSource = {
  passageId: "passage-sales",
  text: "region\trevenue",
  pageFrom: null,
  pageTo: null,
  documentId: "doc-sales",
  documentName: "sales",
  documentKind: "csv",
  contentHash: "a".repeat(64),
  documentDeleted: false,
  notCited: false,
};

/** sales.csv's table as the runner reads it: North 10, South 20, on rows 2 and 3. */
function salesTable(): CodeTable {
  const { units } = extractCsv(new TextEncoder().encode("region,revenue\nNorth,10\nSouth,20\n"), {
    rows: 100,
    cells: 1000,
  });
  const read = readRange(sheetRows(units, null), WHOLE, { rows: 100, cells: 1000 });
  if (!read) throw new Error("The test's table didn't read.");
  return { ...rangeInput("sales.csv", SOURCE, units, null, read), file: "sales.csv", sheet: null };
}

const EXEC: ExecResult = {
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

/** A run that gave the total `value` with figure() over sales.csv's revenue, having read `read`. */
function ran(value: number, read: string[], end: AnalysisEnd = { kind: "done" }): CodeRun {
  return {
    kind: "ran",
    end,
    output: {
      ...noAnalysisOutput(),
      results: [
        {
          kind: "figure",
          name: "total",
          label: "Total revenue",
          unit: null,
          value,
          of: { input: "sales.csv", columns: ["revenue"], rows: [[2, 3]], count: 2, how: "sum" },
        },
      ],
    },
    ms: 5,
    exec: EXEC,
    files: [],
    out: [],
    outLeft: 0,
    tables: [salesTable()],
    read,
    versions: {
      language: "python",
      languageVersion: "3.14.10",
      runtime: "test",
      packages: {},
      helper: "",
      app: "0.0.0-test",
    },
  };
}

async function call(run: CodeRun) {
  const runner: CodeRunner = {
    level: "os",
    hasPython: true,
    pythonUsable: () => true,
    run: async () => run,
  };
  const figures: CalculatedFigure[] = [];
  const analyses: AnswerAnalysis[] = [];
  const tool = runCodeTool({
    runner,
    document: async (id) => (id === "P1" ? { source: SOURCE, path: "/stand-in/sales.csv" } : null),
    recorder: createAnalysisRecorder({
      figure: (figure) => figures.push(figure),
      language: "en",
    }),
    language: "en",
    now: () => new Date("2026-11-02T12:00:00Z"),
    ran: (_id, analysis) => analyses.push(analysis),
    analysisOffered: true,
  });
  const report = await tool.call(
    { title: "Revenue", language: "python", documents: ["P1"], code: "figure(...)" },
    { toolCallId: "call-1", signal: new AbortController().signal },
  );
  return { report, analysis: analyses[0], figures };
}

describe("run_code's Tool", () => {
  test("a figure that matches the cells is worked out again and gets a marker", async () => {
    const { report, analysis, figures } = await call(ran(30, ["sales.csv"]));
    expect(analysis?.recalculations).toEqual([
      { result: "total", check: { kind: "same", value: 30 } },
    ]);
    expect(analysis?.markers.figures).toEqual([{ result: "total", marker: 1 }]);
    expect(figures).toHaveLength(1);
    expect(analysis?.inputs.map((input) => input.kind === "range" && input.name)).toEqual([
      "sales.csv",
    ]);
    expect(report).toContain("[=1]");
  });

  test("a figure that doesn't match gets no marker, and the model is told what the cells come to", async () => {
    const { report, analysis, figures } = await call(ran(31, ["sales.csv"]));
    expect(analysis?.recalculations).toEqual([
      { result: "total", check: { kind: "differs", value: 30 } },
    ]);
    expect(analysis?.markers.figures).toEqual([]);
    expect(figures).toEqual([]);
    expect(report).toContain(
      "figure() gave 31, but the sum of revenue in those rows of sales.csv comes to 30",
    );
  });

  test("a figure over a table the code didn't read isn't worked out again, and isn't cited", async () => {
    const { analysis, figures } = await call(ran(30, []));
    expect(analysis?.inputs).toEqual([]);
    expect(analysis?.recalculations?.map((each) => each.check.kind)).toEqual(["unchecked"]);
    expect(analysis?.markers.figures).toEqual([]);
    expect(figures).toEqual([]);
  });

  test("a run that ended in an error gives no marker and no figure", async () => {
    const { report, analysis, figures } = await call(
      ran(30, ["sales.csv"], { kind: "error", message: "NameError: x", line: 3 }),
    );
    expect(analysis?.markers.figures).toEqual([]);
    expect(analysis?.recalculations).toBeUndefined();
    expect(figures).toEqual([]);
    expect(report).toContain("It stopped with an error on line 3:\nNameError: x");
  });
});
