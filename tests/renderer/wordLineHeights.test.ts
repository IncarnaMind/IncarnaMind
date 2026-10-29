import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { paragraphLineHeight, singleLineOf } from "../../src/renderer/src/editor/wordLineHeights";

const pt = (points: number) => `${points}pt`;

/** A WOFF font's tables, each inflated. */
function woffTables(path: string): Record<string, Buffer> {
  const font = readFileSync(path);
  const tables: Record<string, Buffer> = {};
  for (let at = 0; at < font.readUInt16BE(12); at++) {
    const entry = 44 + at * 20;
    const offset = font.readUInt32BE(entry + 4);
    const stored = font.readUInt32BE(entry + 8);
    const raw = font.subarray(offset, offset + stored);
    tables[font.toString("latin1", entry, entry + 4)] =
      stored < font.readUInt32BE(entry + 12) ? inflateSync(raw) : raw;
  }
  return tables;
}

/** Word's single line of a font, as Windows measures it, from the font's own tables. */
function measuredSingleLine(path: string): number {
  const { head, hhea, "OS/2": os2 } = woffTables(path);
  if (!head || !hhea || !os2) throw new Error(`${path} lacks a table.`);
  const win = os2.readUInt16BE(74) + os2.readUInt16BE(76);
  const typo = hhea.readInt16BE(4) - hhea.readInt16BE(6);
  const leading = Math.max(0, hhea.readInt16BE(8) - (win - typo));
  return Math.round(((win + leading) / head.readUInt16BE(18)) * 10000) / 10000;
}

describe("a Word paragraph's lines are as tall as Word makes them", () => {
  test("Calibri's single line is read from its tables, as the Carlito the app ships has them", () => {
    const carlito = join(
      __dirname,
      "../../node_modules/@fontsource/carlito/files/carlito-latin-400-normal.woff",
    );
    expect(singleLineOf({ font: "Calibri" }, false)).toBe(measuredSingleLine(carlito));
    expect(singleLineOf({ font: "Calibri" }, false)).toBeGreaterThan(1.2);
    // Unknown fonts keep the Mind's single line.
    expect(singleLineOf({ font: "A Font Nobody Has" }, false)).toBe(1.15);
  });

  test("a line is its font's height at its size, in whole twips; spacing multiplies it", () => {
    const calibri = { font: "Calibri", size: 11 };
    const look = { body: 11 };
    // 11 × 1.2207 = 13.428 pt, laid out as 13.45 pt.
    expect(Number(paragraphLineHeight({}, calibri, look, pt).lineHeight) * 11).toBeCloseTo(
      13.45,
      3,
    );
    const double = paragraphLineHeight({ line: { rule: "auto", value: 2 } }, calibri, look, pt);
    expect(Number(double.lineHeight) * 11).toBeCloseTo(26.9, 2);
    expect(paragraphLineHeight({ line: { rule: "exact", value: 18 } }, calibri, look, pt)).toEqual({
      single: String(Math.round((13.45 / 11) * 10000) / 10000),
      lineHeight: "18pt",
    });
    expect(
      paragraphLineHeight({ line: { rule: "atLeast", value: 18 } }, calibri, look, pt).lineHeight,
    ).toMatch(/^max\(1\.22\d*em, 18pt\)$/);
  });

  test("on a document grid a line takes a whole number of pitches, unless the paragraph keeps off it", () => {
    const simsun = { font: "Times New Roman", eastAsia: "宋体", size: 10.5 };
    const grid = { body: 10.5, linePitch: 15.6, eastAsian: true as const };
    const body = Number(paragraphLineHeight({}, simsun, grid, pt).lineHeight);
    expect(body * 10.5).toBeCloseTo(15.6, 3);
    const heading = { font: "黑体", eastAsia: "黑体", size: 22 };
    expect(Number(paragraphLineHeight({}, heading, grid, pt).lineHeight) * 22).toBeCloseTo(31.2, 3);
    const off = paragraphLineHeight({ snapToGrid: false }, simsun, grid, pt);
    expect(Number(off.lineHeight) * 10.5).toBeLessThan(15.6);
    const exact = paragraphLineHeight({ line: { rule: "exact", value: 28 } }, simsun, grid, pt);
    expect(exact.lineHeight).toBe("28pt");
    const oneAndHalf = paragraphLineHeight(
      { line: { rule: "auto", value: 1.5 } },
      simsun,
      grid,
      pt,
    );
    expect(Number(oneAndHalf.lineHeight) * 10.5).toBeCloseTo(23.4, 2);
  });

  test("with East Asian text a line takes the taller of its two fonts; without, only its Latin one", () => {
    const run = { font: "Calibri", eastAsia: "微软雅黑" };
    expect(singleLineOf(run, true)).toBeGreaterThan(singleLineOf(run, false));
    expect(singleLineOf(run, false)).toBe(singleLineOf({ font: "Calibri" }, false));
  });
});
