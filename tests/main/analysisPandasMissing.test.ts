/**
 * The texts a figure worked out again counts as empty cells are pandas' own (#2577), checked on the
 * Python and pandas the app bundles in resources/python, as the built app loads them: the list
 * equals pandas' `STR_NA_VALUES`, pandas' `read_csv` skips each such text and reaches the mean of
 * the numbers beside it, the app's own `figure()` helper gives that mean, and IncarnaMind's work of
 * it again (`recalculate`, and the recorder that gives the figure its marker) reaches the same
 * number. A text pandas doesn't read as missing ("-", "—", "nil", 无, "N/a", " n/a" ...) is no empty
 * cell there, and the recalculation still refuses it.
 *
 * Needs resources/python, which the app's build writes (`npm run build`). It is skipped without it,
 * and fails with INCARNAMIND_TEST_PYTHON_ENGINE=required, as the jobs that build it say.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { AnalysisRuntime } from "../../src/core/adapters";
import { PANDAS_MISSING, recalculate } from "../../src/core/analysis/figureRows";
import { createAnalysisRecorder } from "../../src/core/analysis/recorder";
import type { CalculatedFigure } from "../../src/core/api";
import type {
  AnalysisCell,
  AnalysisFigureRows,
  AnalysisInput,
  AnalysisValue,
} from "../../src/shared/analysis";
import { pyodideAnalysisRuntime } from "../helpers/pyodideAnalysis";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const built = existsSync(join(ROOT, "resources", "python", "pyodide.mjs"));

test.runIf(process.env.INCARNAMIND_TEST_PYTHON_ENGINE === "required")(
  "the app's Python is built",
  () => {
    expect(built, "resources/python is missing: run `npm run build` first").toBe(true);
  },
);

const NUMBERS = [0.06, 0.08, 0.1];
const MEAN = 0.08;

/** The texts pandas doesn't read as missing, which a recalculation must still refuse. */
const NOT_MISSING = [
  "-",
  "—",
  "–",
  "nil",
  "无",
  "暂无",
  "N/a",
  "n/A",
  "NAN",
  "na",
  "none",
  " n/a",
  "n/a ",
];

const growth = (cell: AnalysisCell): AnalysisCell[] => [
  NUMBERS[0] ?? null,
  cell,
  NUMBERS[1] ?? null,
  NUMBERS[2] ?? null,
];

const input = (cell: AnalysisCell): AnalysisInput => ({
  kind: "table",
  name: "loans",
  columns: ["month", "growth"],
  firstRow: 2,
  rows: growth(cell).map((value, month) => [`2026-0${month + 1}`, value]),
});

describe.skipIf(!built)(
  "pandas as the app bundles it, and the cells a figure skips (#2577)",
  () => {
    let runtime: AnalysisRuntime;
    beforeAll(async () => {
      runtime = await pyodideAnalysisRuntime();
    }, 180_000);

    /** Runs `code` over `inputs` in the bundled Python, as the app does, and gives what it printed and gave. */
    async function run(code: string, inputs: readonly AnalysisInput[] = []) {
      const result = await runtime.run(
        { language: "python", code, inputs },
        new AbortController().signal,
      );
      if (result.end.kind !== "done")
        throw new Error(`The run ended: ${JSON.stringify(result.end)}`);
      return result.output;
    }

    /** pandas' own reading of a CSV column with `cell` between its numbers: its type and its mean. */
    async function pandasReads(cell: string) {
      const output = await run(
        [
          "import io, json, pandas as pd",
          `text = "g\\n0.06\\n" + ${JSON.stringify(cell)} + "\\n0.08\\n0.10\\n"`,
          "column = pd.read_csv(io.StringIO(text))['g']",
          "try:",
          "    mean = float(column.mean())",
          "except TypeError:",
          "    mean = None",
          "print(json.dumps({'numeric': bool(pd.api.types.is_numeric_dtype(column)), 'mean': mean}))",
        ].join("\n"),
      );
      return JSON.parse(output.printed.trim()) as { numeric: boolean; mean: number | null };
    }

    /** The app's `figure()` over the column, as the Analysis's code gives it. */
    async function figureOf(cell: AnalysisCell) {
      const output = await run(
        'df = inputs["loans"]\nfigure("growth", df["growth"], "mean", label="Average monthly growth", unit="%")',
        [input(cell)],
      );
      const found = output.results.find(
        (result): result is Extract<AnalysisValue, { kind: "figure" }> => result.kind === "figure",
      );
      if (!found?.of) throw new Error("The helper gave no figure with its rows.");
      return found;
    }

    // protects=the list is pandas' own, not typed from memory: it is the bundled pandas' STR_NA_VALUES without the empty text, which a recalculation already skips (#2577); fails_when=pandas gains or loses a default missing text and the list isn't revisited
    test("the list is the bundled pandas' STR_NA_VALUES", async () => {
      const output = await run(
        [
          "import json",
          "from pandas._libs.parsers import STR_NA_VALUES",
          "print(json.dumps(sorted(STR_NA_VALUES)))",
        ].join("\n"),
      );
      const theirs = (JSON.parse(output.printed.trim()) as string[]).filter((text) => text !== "");

      expect([...PANDAS_MISSING].sort()).toEqual(theirs);
    });

    // protects=for each text pandas reads as missing, pandas' read_csv skips it and reaches the mean of the numbers beside it, the app's figure() gives that mean, and the recalculation and the recorder reach the same number, so the figure gets its marker (#2577); fails_when=the recalculation refuses a text pandas skips, or reaches another number
    test.each([...PANDAS_MISSING])(
      "%s: pandas skips it, and the figure is worked out again to the same number",
      async (text) => {
        const theirs = await pandasReads(text);
        expect(theirs, "pandas' read_csv").toEqual({
          numeric: true,
          mean: expect.closeTo(MEAN, 12),
        });

        const figure = await figureOf(text);
        expect(figure.value, "the app's figure()").toBeCloseTo(MEAN, 12);
        expect(figure.of?.rows, "the rows it names are all four").toEqual([[2, 5]]);
        expect(recalculate(figure.value, figure.of as AnalysisFigureRows, [input(text)])).toEqual({
          kind: "same",
          value: expect.closeTo(MEAN, 12),
        });

        const figures: CalculatedFigure[] = [];
        const recorder = createAnalysisRecorder({
          figure: (each) => figures.push(each),
          language: "en",
        });
        const marked = recorder.mark(
          recorder.next(),
          { ...(await run("pass")), results: [figure] },
          [input(text)],
        );
        expect(marked.markers.figures).toEqual([{ result: "growth", marker: 1 }]);
        expect(figures[0]?.shown).toBe("8.0%");
      },
    );

    // protects=a text pandas doesn't read as missing is no empty cell: pandas' read_csv leaves the column text, and the recalculation still refuses it, naming the cell (#2444, #2577); fails_when=a dash, a word for none or a near miss of a missing text is skipped
    test.each(NOT_MISSING)(
      "%j: pandas does not skip it, and the recalculation refuses it",
      async (text) => {
        const theirs = await pandasReads(text);
        expect(theirs, "pandas' read_csv").toEqual({ numeric: false, mean: null });

        const figure = await figureOf(text);
        expect(recalculate(figure.value, figure.of as AnalysisFigureRows, [input(text)])).toEqual({
          kind: "unchecked",
          reason: `1 cell of growth in the rows it names isn't a number: row 3 "${text}"`,
        });
      },
    );
  },
);
