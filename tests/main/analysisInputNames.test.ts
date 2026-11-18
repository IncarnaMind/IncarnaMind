/**
 * An Analysis's code reads an input by its bare name as well as through inputs["name"] (#2525):
 * models write `len(files)` about as often as `len(inputs["files"])`, and the first used to stop
 * with a NameError and cost a second request. Checked on the Python the app bundles.
 *
 * Needs resources/python, which the app's build writes (`npm run build`). It is skipped without it.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { AnalysisRuntime } from "../../src/core/adapters";
import type { AnalysisInput } from "../../src/shared/analysis";
import { pyodideAnalysisRuntime } from "../helpers/pyodideAnalysis";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const built = existsSync(join(ROOT, "resources", "python", "pyodide.mjs"));

const table = (name: string): AnalysisInput => ({
  kind: "table",
  name,
  columns: ["name", "kind"],
  firstRow: 2,
  rows: [
    ["Tides", "markdown"],
    ["Harbour office", "word"],
  ],
});

describe.skipIf(!built)("An input read by its bare name", () => {
  let runtime: AnalysisRuntime;
  beforeAll(async () => {
    runtime = await pyodideAnalysisRuntime();
  }, 180_000);

  const run = (code: string, inputs: readonly AnalysisInput[]) =>
    runtime.run({ language: "python", code, inputs }, new AbortController().signal);

  // protects=code that names an input directly runs, and gives what the same code gives through inputs[...]; fails_when=`len(files)` stops with a NameError, so every such check costs a failed run first.
  test("the bare name and inputs[...] give the same rows", async () => {
    const result = await run(
      'result("bare", len(files))\nresult("through", len(inputs["files"]))',
      [table("files")],
    );

    expect(result.end).toEqual({ kind: "done" });
    expect(result.output.results).toMatchObject([
      { kind: "figure", name: "bare", value: 2 },
      { kind: "figure", name: "through", value: 2 },
    ]);
  });

  // protects=an input named like one of Python's own functions, or like the helper's, doesn't take that function's place: the code still calls len and result, and reads the input through inputs[...]; fails_when=an input called "len" or "result" breaks the code that uses them.
  test("an input never takes the place of a function the code calls", async () => {
    const result = await run('result("rows", len(inputs["len"]) + len(inputs["result"]))', [
      table("len"),
      table("result"),
    ]);

    expect(result.end).toEqual({ kind: "done" });
    expect(result.output.results).toMatchObject([{ kind: "figure", name: "rows", value: 4 }]);
  });
});
