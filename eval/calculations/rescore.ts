/**
 * Scores a calculations report again from the Answers it kept, with the
 * set and the scoring as they are now, and writes the result as a new
 * report beside it: no model is asked.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/tsResolve.mjs \
 *     eval/calculations/rescore.ts eval/results/<start time>-calculations/report.json
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CALCULATION_CASES } from "./cases.ts";
import { type CalculationsReport, summaryLines, writeCalculationsReport } from "./report.ts";
import { scoreCase } from "./score.ts";

const path = process.argv[2];
if (!path) throw new Error("Give the report.json to score again.");
const report = JSON.parse(await readFile(path, "utf8")) as CalculationsReport;
const rescored: CalculationsReport = {
  run: { ...report.run, startedAt: new Date().toISOString(), rescoredFrom: path },
  arms: report.arms.map((arm) => ({
    ...arm,
    cases: arm.answers.map(({ id, observed }) => {
      const test = CALCULATION_CASES.find((each) => each.id === id);
      if (!test) throw new Error(`${path} has an Answer to ${id}, which the set no longer has.`);
      return scoreCase(test, observed);
    }),
  })),
};
const dir = await writeCalculationsReport(rescored, join(dirname(path), ".."));
console.log(summaryLines(rescored, dir).join("\n"));
