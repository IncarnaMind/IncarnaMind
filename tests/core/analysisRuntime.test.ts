import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { runAnalysis } from "../../src/core/analysis";
import { createFakeAnalysisRuntime, FAKE_PYTHON } from "../../src/core/analysis/fake";
import {
  ANALYSIS_LIMITS,
  type AnalysisInput,
  type AnalysisJob,
  type AnalysisTable,
} from "../../src/shared/analysis";
import { createTempDataFolder, startCore } from "../helpers/core";

const SALES: AnalysisInput = {
  kind: "table",
  name: "sales",
  columns: ["region", "revenue"],
  rows: [
    ["North", 120],
    ["South", 80.5],
  ],
  firstRow: 2,
};

const job = (code: string, inputs: readonly AnalysisInput[] = [SALES]): AnalysisJob => ({
  language: "python",
  code,
  inputs,
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const tableOf = (rows: number, columns = 2): AnalysisTable => ({
  columns: Array.from({ length: columns }, (_, index) => `c${index}`),
  rows: Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => row * columns + column),
  ),
  rowCount: rows,
  columnCount: columns,
});

const running = () => new AbortController().signal;

describe("an Analysis run through the runtime's port", () => {
  test("a run that succeeds gives its results, and records the hashes of its code and inputs and the versions it ran with", async () => {
    const runtime = createFakeAnalysisRuntime({
      answer: () => ({
        output: {
          steps: [{ label: "Read the sales", rows: 2, columns: 2 }],
          results: [{ kind: "figure", name: "total", label: "Total", unit: "USD", value: 200.5 }],
          printed: "200.5\n",
        },
      }),
    });
    const code = 'result("total", inputs["sales"]["revenue"].sum(), "Total", "USD")';

    const run = await runAnalysis(runtime, job(code), running());

    expect(run.result.end).toEqual({ kind: "done" });
    expect(run.result.output.results).toEqual([
      { kind: "figure", name: "total", label: "Total", unit: "USD", value: 200.5 },
    ]);
    expect(run.result.output.steps).toEqual([{ label: "Read the sales", rows: 2, columns: 2 }]);
    expect(run.code).toBe(sha256(code));
    expect(run.inputs).toEqual([
      {
        name: "sales",
        sha256: sha256(
          JSON.stringify([
            ["region", "revenue"],
            [
              ["North", 120],
              ["South", 80.5],
            ],
          ]),
        ),
      },
    ]);
    expect(run.versions).toEqual(FAKE_PYTHON);
    expect(runtime.jobs).toHaveLength(1);
  });

  test("the same job gives the same output hash; other values in an input give another input hash", async () => {
    const runtime = createFakeAnalysisRuntime({
      answer: (asked) => ({ output: { printed: `${asked.inputs.length} inputs` } }),
    });
    const first = await runAnalysis(runtime, job("print(1)"), running());
    const again = await runAnalysis(runtime, job("print(1)"), running());
    const changed = await runAnalysis(
      runtime,
      job("print(1)", [{ ...SALES, rows: [["North", 121]] }]),
      running(),
    );

    expect(again.output).toBe(first.output);
    expect(again.code).toBe(first.code);
    expect(changed.inputs[0]?.sha256).not.toBe(first.inputs[0]?.sha256);
    const number = await runAnalysis(
      runtime,
      job("print(1)", [{ kind: "number", name: "rate", value: 0.2 }]),
      running(),
    );
    expect(number.inputs).toEqual([{ name: "rate", sha256: sha256("0.2") }]);
  });

  test("an error in the code is its result: Python's message, its line, and what was given before it", async () => {
    const message =
      "Traceback (most recent call last):\n  File \"<analysis>\", line 2\nKeyError: 'regoin'";
    const runtime = createFakeAnalysisRuntime({
      answer: () => ({
        end: { kind: "error", message, line: 2 },
        output: { steps: [{ label: "Read the sales", rows: 2, columns: 2 }] },
      }),
    });

    const run = await runAnalysis(runtime, job('df = inputs["sales"]\ndf["regoin"]'), running());

    expect(run.result.end).toEqual({ kind: "error", message, line: 2 });
    expect(run.result.output.steps).toHaveLength(1);
  });

  test("code that never ends is stopped at its time limit, and when its signal aborts", async () => {
    const runtime = createFakeAnalysisRuntime({ answer: () => "hang" });

    const late = await runAnalysis(
      runtime,
      { ...job("while True: pass"), timeLimitMs: 20 },
      running(),
    );
    expect(late.result.end).toEqual({ kind: "timed-out", limitMs: 20 });

    const controller = new AbortController();
    const stopping = runAnalysis(runtime, job("while True: pass"), controller.signal);
    controller.abort();
    expect((await stopping).result.end).toEqual({ kind: "stopped" });
  });

  test("running out of memory and a runtime that can't run here are results too; a runtime that throws ends the run as unavailable", async () => {
    const memory = createFakeAnalysisRuntime({
      answer: () => ({ end: { kind: "out-of-memory" } }),
    });
    expect((await runAnalysis(memory, job("x = [0] * 10**12"), running())).result.end).toEqual({
      kind: "out-of-memory",
    });

    const noSandbox = createFakeAnalysisRuntime({ unavailable: true });
    expect((await runAnalysis(noSandbox, job("print(1)"), running())).result.end).toMatchObject({
      kind: "unavailable",
      reason: "start",
    });

    const none = await runAnalysis(undefined, job("print(1)"), running());
    expect(none.result.end).toMatchObject({ kind: "unavailable", reason: "missing" });
    expect(none.versions).toBeNull();

    const broken = createFakeAnalysisRuntime();
    const throwing = {
      ...broken,
      run: () => Promise.reject(new Error("The window went away.")),
    };
    expect((await runAnalysis(throwing, job("print(1)"), running())).result.end).toEqual({
      kind: "unavailable",
      reason: "start",
      detail: "The window went away.",
    });
  });

  test("the numbers written in the code are listed, with their lines, as the runtime found them", async () => {
    const literals = [
      { value: 0.2, line: 1, text: "0.2" },
      { value: 1000, line: 2, text: "1_000" },
    ];
    const runtime = createFakeAnalysisRuntime({ answer: () => ({ output: { literals } }) });

    const run = await runAnalysis(runtime, job("rate = 0.2\nbase = 1_000"), running());

    expect(run.result.output.literals).toEqual(literals);
  });

  test("whatever a runtime gives is cut to the limits again: rows, tables, figures, charts and printed text, each saying how much", async () => {
    const runtime = createFakeAnalysisRuntime({
      answer: () => ({
        output: {
          results: [
            ...Array.from({ length: ANALYSIS_LIMITS.tables + 3 }, (_, index) => ({
              kind: "table" as const,
              name: `t${index}`,
              label: `Table ${index}`,
              unit: null,
              table: tableOf(index === 0 ? ANALYSIS_LIMITS.rows + 50 : 2, index === 0 ? 40 : 2),
            })),
            ...Array.from({ length: ANALYSIS_LIMITS.figures + 2 }, (_, index) => ({
              kind: "figure" as const,
              name: `f${index}`,
              label: `Figure ${index}`,
              unit: null,
              value: index,
            })),
          ],
          charts: Array.from({ length: ANALYSIS_LIMITS.charts + 1 }, () => ({
            kind: "bar" as const,
            title: "Revenue",
            x: "c0",
            y: ["c1"],
            table: tableOf(3),
          })),
          printed: "x".repeat(ANALYSIS_LIMITS.printed + 10),
        },
      }),
    });

    const { output } = (await runAnalysis(runtime, job("print(1)"), running())).result;

    const tables = output.results.filter((each) => each.kind === "table");
    expect(tables).toHaveLength(ANALYSIS_LIMITS.tables);
    expect(output.results.filter((each) => each.kind === "figure")).toHaveLength(
      ANALYSIS_LIMITS.figures,
    );
    const first = tables[0]?.kind === "table" ? tables[0].table : null;
    expect(first?.rows).toHaveLength(ANALYSIS_LIMITS.rows);
    expect(first?.columns).toHaveLength(ANALYSIS_LIMITS.columns);
    expect(first).toMatchObject({ rowCount: ANALYSIS_LIMITS.rows + 50, columnCount: 40 });
    expect(output.charts).toHaveLength(ANALYSIS_LIMITS.charts);
    expect(output.printed).toHaveLength(ANALYSIS_LIMITS.printed);
    expect(output.cut).toMatchObject({ tables: 3, figures: 2, charts: 1, printed: true });
  });

  test("the core closes the runtime when it closes, freeing the interpreter", async () => {
    const runtime = createFakeAnalysisRuntime();
    const core = startCore(await createTempDataFolder(), { analysisRuntime: runtime });

    core.close();

    expect(runtime.closes).toBe(1);
  });
});
