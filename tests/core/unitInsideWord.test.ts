/**
 * A unit character that begins a word names no unit (#2251): 吨 in «单位：吨位分析». After 单位：,
 * where a unit's name is free to run on, the word segmenter says whether the character stands
 * alone, so a real unit still counts.
 */
import { expect, test } from "vitest";
import { readStatedUnits } from "../../src/shared/figures";

// protects=a unit line states its unit only where the unit is a word of its own: 吨 in «单位：吨位分析» is the start of 吨位, while a next line a PDF joined to the unit («单位：吨产量») leaves it standing; fails_when=吨位分析 reads as tonnes, or a joined line loses the unit
test("a unit line's unit is a word of its own", () => {
  expect(readStatedUnits("单位：吨位分析")).toEqual([]);
  expect(readStatedUnits("单位：吨产量").map(({ unit }) => unit)).toEqual([
    { kind: "other", word: "吨" },
  ]);
  expect(readStatedUnits("单位：吨").map(({ unit }) => unit)).toEqual([
    { kind: "other", word: "吨" },
  ]);
});
