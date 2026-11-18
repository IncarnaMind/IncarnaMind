import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { secondsIn } from "../../scripts/unitDurations";
import { balance, secondsOf, slowestFirst } from "../setup/shards";

const durations: Record<string, number> = JSON.parse(
  readFileSync(join(__dirname, "..", "durations.json"), "utf8"),
);

describe("the unit test shards", () => {
  test("deal the slowest files first, each to the shard with the least time so far", () => {
    const files = [
      { id: "tests/a.test.ts", seconds: 10 },
      { id: "tests/b.test.ts", seconds: 9 },
      { id: "tests/c.test.ts", seconds: 1 },
      { id: "tests/d.test.ts", seconds: 1 },
    ];
    expect(balance(files, 1, 2)).toEqual(["tests/a.test.ts", "tests/d.test.ts"]);
    expect(balance(files, 2, 2)).toEqual(["tests/b.test.ts", "tests/c.test.ts"]);
  });

  test("put every file in exactly one of eight shards, within a minute of each other", () => {
    const files = Object.entries(durations).map(([id, seconds]) => ({ id, seconds }));
    const eight = [1, 2, 3, 4, 5, 6, 7, 8];
    const shards = eight.map((index) => balance(files, index, eight.length));
    expect(shards.flat().sort()).toEqual(files.map((file) => file.id).sort());
    const totals = shards.map((ids) => ids.reduce((sum, id) => sum + (durations[id] ?? 0), 0));
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(60);
  });

  test("a shard past the number of files is empty", () => {
    expect(balance([{ id: "tests/a.test.ts", seconds: 1 }], 2, 2)).toEqual([]);
  });

  test("a shard runs its slowest files first, whatever their size", () => {
    const files = [
      { id: "tests/long.test.ts", seconds: 1 },
      { id: "tests/short.test.ts", seconds: 30 },
      { id: "tests/also.test.ts", seconds: 1 },
    ];
    expect(slowestFirst(files).map((file) => file.id)).toEqual([
      "tests/short.test.ts",
      "tests/also.test.ts",
      "tests/long.test.ts",
    ]);
  });

  test("a file the table doesn't know counts by its size, a known one as it was measured", () => {
    expect(secondsOf("tests/core/new.test.ts", 200_000)).toBeCloseTo(54);
    expect(secondsOf("tests/core/new.test.ts", 2_000)).toBeLessThan(1);
    expect(secondsOf("tests/core/calculations.test.ts", 1)).toBe(
      durations["tests/core/calculations.test.ts"],
    );
  });
});

describe("the table of seconds, from a run's log", () => {
  const at = "Unit tests (3/8)\tUNKNOWN STEP\t2026-11-17T21:41:42.8331096Z";

  // As `gh run view --log` prints them: the escape character of each colour code as "^[".
  test("takes each passed file's seconds, and counts a skipped file as nothing", () => {
    const log = [
      `${at}  ^[[32m✓^[[39m tests/core/wholeRead.test.ts ^[[2m(^[[22m^[[2m51 tests^[[22m^[[2m)^[[22m^[[33m 102349^[[2mms^[[22m^[[39m`,
      `${at}  ^[[32m✓^[[39m tests/core/addedUncited.test.ts ^[[2m(^[[22m^[[2m23 tests^[[22m^[[2m)^[[22m^[[32m 22^[[2mms^[[22m^[[39m`,
      `${at}  ^[[2m^[[90m↓^[[39m^[[22m tests/live/tieOut.live.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m | ^[[22m^[[33m2 skipped^[[39m^[[2m)^[[22m`,
      `${at}    ^[[32m✓^[[39m every row reads as measured ^[[33m 29412^[[2mms^[[22m^[[39m`,
      `${at} ^[[2m Test Files ^[[22m ^[[1m^[[32m194 passed^[[39m^[[22m^[[2m | ^[[22m^[[33m25 skipped^[[39m^[[90m (219)^[[39m`,
    ].join("\n");
    expect(secondsIn(log)).toEqual({
      "tests/core/wholeRead.test.ts": 102.3,
      "tests/core/addedUncited.test.ts": 0,
      "tests/live/tieOut.live.test.ts": 0,
    });
  });
});
