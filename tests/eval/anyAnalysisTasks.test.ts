import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { inputsHash } from "../../eval/any-analysis/inputs";
import type { Reference } from "../../eval/any-analysis/task";
import { TASKS } from "../../eval/any-analysis/tasks";

/*
 * The any-analysis set (eval/any-analysis/README.md) as it is designed: 40 tasks with what each
 * needs, eight in Chinese too, and a reference for every result each Answer is held to, worked out
 * from the same bytes the task writes now.
 */

const referenceOf = (id: string): Reference =>
  JSON.parse(
    readFileSync(join(__dirname, "../../eval/any-analysis/tasks", id, "reference.json"), "utf8"),
  ) as Reference;

describe("the set", () => {
  test("has the 40 tasks, each needing what the design says", () => {
    expect(Object.fromEntries(TASKS.map((task) => [task.id, task.needs.join("+")]))).toEqual({
      F01: "P",
      F02: "P",
      F03: "P",
      F04: "P",
      F05: "P",
      F06: "P",
      F07: "P",
      F08: "P",
      S01: "P",
      S02: "P",
      S03: "P",
      S04: "P",
      S05: "P",
      S06: "P",
      S07: "P",
      M01: "P",
      M02: "P",
      M03: "P",
      M04: "P",
      M05: "N",
      M06: "P",
      E01: "F+N",
      E02: "F+N",
      E03: "F+N",
      E04: "F+N",
      E05: "P",
      E06: "P",
      E07: "X",
      L01: "N",
      L02: "N",
      L03: "P",
      L04: "P",
      L05: "N",
      L06: "P",
      D01: "T",
      D02: "T",
      D03: "T",
      D04: "T",
      D05: "T",
      D06: "T",
    });
  });

  test("asks eight of them in Chinese too", () => {
    expect(TASKS.filter((task) => task.question.zh).map((task) => task.id)).toEqual([
      "F01",
      "F05",
      "S01",
      "M03",
      "E05",
      "E06",
      "L04",
      "L06",
    ]);
  });
});

describe.each(TASKS.map((task) => [task.id, task] as const))("%s", (id, task) => {
  const reference = referenceOf(id);

  test("has a reference value for every result its Answer is held to", () => {
    const needed = task.expect
      .filter((each) => each.kind === "number" || each.kind === "rows")
      .map((each) => each.id);

    expect(reference.task).toBe(id);
    expect(needed.filter((each) => reference.values[each] === undefined)).toEqual([]);
    expect(needed.length).toBeGreaterThan(0);
  });

  test.skipIf(task.large === true)(
    "writes the inputs its reference was worked out from, the Chinese with the same data",
    () => {
      const english = task.inputs("en");

      expect(inputsHash(english)).toBe(reference.inputs.en);
      expect(inputsHash(task.inputs("en"))).toBe(reference.inputs.en);
      if (task.question.zh) {
        const chinese = task.inputs("zh");
        expect(chinese.data).toEqual(english.data);
        expect(inputsHash(chinese)).toBe(reference.inputs.zh);
      }
    },
  );
});
