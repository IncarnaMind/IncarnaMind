/**
 * The calculations set's published results (#441, eval/calculations/README.md) come again from
 * the Answers kept in eval/evidence/441-calculations/, scored now with no model and no network:
 * a change to the set or the scoring that moves them fails here first.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CALCULATION_CASES } from "../../eval/calculations/cases";
import type { CalculationsReport } from "../../eval/calculations/report";
import { type Rate, scoreCase, scoreGroup } from "../../eval/calculations/score";

const kept = (name: string): CalculationsReport =>
  JSON.parse(
    readFileSync(
      new URL(`../../eval/evidence/441-calculations/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as CalculationsReport;

const counts = (rate: Rate) => `${rate.count}/${rate.of}`;

function table(name: string): string[] {
  return kept(name).arms.flatMap((arm) =>
    (["en", "zh"] as const).map((language) => {
      const cases = arm.answers.flatMap(({ id, observed }) => {
        const test = CALCULATION_CASES.find((each) => each.id === id);
        if (!test)
          throw new Error(`${name} keeps an Answer to ${id}, which the set no longer has.`);
        return test.language === language ? [scoreCase(test, observed)] : [];
      });
      const score = scoreGroup(cases);
      return [
        arm.arm,
        language,
        counts(score.completeness),
        counts(score.figureCorrectness),
        counts(score.inputCorrectness),
        counts(score.toolCoverage),
        counts(score.refusals),
        score.falseChecked,
      ].join(" ");
    }),
  );
}

describe("the published results, scored again from the kept Answers", () => {
  test("Claude Haiku 5.5", () => {
    expect(table("claude-haiku-5-5")).toEqual([
      "on en 40/41 40/40 36/36 36/38 2/2 0",
      "on zh 36/36 36/36 34/34 34/34 2/2 0",
      "off en 40/41 40/40 0/0 0/38 2/2 0",
      "off zh 36/36 34/36 0/0 0/34 2/2 0",
    ]);
  });

  test("DeepSeek Flash", () => {
    expect(table("deepseek-flash")).toEqual([
      "on en 41/41 41/41 39/39 39/39 2/2 0",
      "on zh 36/36 35/36 33/33 33/34 2/2 0",
      "off en 41/41 40/41 0/0 0/39 2/2 0",
      "off zh 36/36 36/36 0/0 0/34 2/2 0",
    ]);
  });

  test("Claude Sonnet 5.5, three Questions with the Tools", () => {
    expect(table("claude-sonnet-5-5")).toEqual([
      "on en 3/3 3/3 3/3 3/3 0/0 0",
      "on zh 2/2 2/2 2/2 2/2 0/0 0",
    ]);
  });
});
