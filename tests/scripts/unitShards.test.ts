import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { balance } from "../setup/shards";

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

  test("put every file in exactly one of four shards, within a minute of each other", () => {
    const files = Object.entries(durations).map(([id, seconds]) => ({ id, seconds }));
    const shards = [1, 2, 3, 4].map((index) => balance(files, index, 4));
    expect(shards.flat().sort()).toEqual(files.map((file) => file.id).sort());
    const totals = shards.map((ids) => ids.reduce((sum, id) => sum + (durations[id] ?? 0), 0));
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(60);
  });

  test("a shard past the number of files is empty", () => {
    expect(balance([{ id: "tests/a.test.ts", seconds: 1 }], 2, 2)).toEqual([]);
  });
});
