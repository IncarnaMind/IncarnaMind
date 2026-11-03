/**
 * Prints the report of the saved runs named in INCARNAMIND_EVAL_RUNS (paths separated by commas),
 * and with INCARNAMIND_EVAL_DETAIL=1 each Answer's checks and the results it got wrong.
 */
import { readFileSync } from "node:fs";
import { test } from "vitest";
import type { RunRecord } from "./record";
import { byModel, modelResults, reportLines } from "./report";

test("the any-analysis report", () => {
  const paths = (process.env.INCARNAMIND_EVAL_RUNS ?? "").split(",").filter(Boolean);
  if (paths.length === 0) throw new Error("Name the saved runs in INCARNAMIND_EVAL_RUNS.");
  const runs = paths.map((path) => JSON.parse(readFileSync(path, "utf8")) as RunRecord);
  console.log(reportLines(runs).join("\n"));
  if (process.env.INCARNAMIND_EVAL_DETAIL !== "1") return;
  for (const result of modelResults(byModel(runs).map((each) => each.record))) {
    for (const score of result.run.scores) {
      const failed = (["C1", "C2", "C3", "C4", "C5"] as const).filter(
        (check) => !score.checks[check],
      );
      const wrong = score.expectations
        .filter((each) => each.outcome !== "right")
        .map((each) => `${each.id} ${each.outcome}: ${each.detail}`);
      console.log(
        [
          `${result.model} ${score.task} ${score.language}: ${score.passed ? "pass" : `${failed.join(" ")} ${score.failure}`} (${score.end}, ${Math.round(score.seconds)} s)`,
          ...wrong,
          ...score.notes,
          ...score.falseRecalculated,
          ...score.troubles.map((each) => `trouble: ${each}`),
        ].join("\n  "),
      );
    }
  }
});
