/**
 * The any-analysis set's published results (#2411, eval/any-analysis/README.md) come again from
 * the Answers kept in eval/evidence/2411-any-analysis/, scored now with no model and no network:
 * a change to the set or the scorer that moves them fails here first.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { RunRecord } from "../../eval/any-analysis/record";
import { byModel, modelResults } from "../../eval/any-analysis/report";

const FOLDER = join(__dirname, "../../eval/evidence/2411-any-analysis");

/** What README.md publishes for each model: tasks passed per need, in English, and the failure classes. */
const HAIKU = {
  passed: { P: "21/25", N: "3/8", F: "3/4", T: "3/6", X: "0/1" },
  chinese: "6/8",
  failures: {
    "not offered": 6,
    incomplete: 3,
    "wrong method": 3,
    "wrong number": 1,
    "limit hit": 1,
    slow: 1,
  },
};
const SONNET = {
  passed: { P: "25/25", N: "4/8", F: "4/4", T: "5/6", X: "0/1" },
  chinese: "0/0",
  failures: { "not offered": 5, "limit hit": 1 },
};

const runs: RunRecord[] = readdirSync(FOLDER)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(FOLDER, name), "utf8")) as RunRecord);

const results = modelResults(byModel(runs).map((each) => each.record));
const of = (model: string) => {
  const found = results.find((each) => each.model === model);
  if (!found) throw new Error(`No kept run of ${model}.`);
  return found;
};

describe.each([
  ["anthropic/claude-haiku-5-5", HAIKU],
  ["anthropic/claude-sonnet-5-5", SONNET],
] as const)("%s", (model, published) => {
  test("passes the tasks the README says, per need", () => {
    const result = of(model);

    expect(
      Object.fromEntries(
        Object.entries(result.passed).map(([need, count]) => [need, `${count.passed}/${count.of}`]),
      ),
    ).toEqual(published.passed);
  });

  test("passes the Chinese tasks the README says", () => {
    const chinese = of(model).run.scores.filter((score) => score.language === "zh");

    expect(`${chinese.filter((score) => score.passed).length}/${chinese.length}`).toBe(
      published.chinese,
    );
  });

  test("names the failures the README counts", () => {
    expect(of(model).failures).toEqual(published.failures);
  });

  test("has no C4 failure and no false recalculated figure", () => {
    const { run } = of(model);

    expect(run.notContained).toBe(0);
    expect(run.outside).toBe(0);
    expect(run.falseRecalculated).toBe(0);
    expect(run.scores.length).toBeGreaterThan(0);
  });
});
