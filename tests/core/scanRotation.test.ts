import { describe, expect, test } from "vitest";
import type { PagePicture, RecognizedLine } from "../../src/core";
import {
  anchorsBack,
  type QuarterTurn,
  readWithQuarterTurn,
  turnPicture,
  turnPoint,
  turnQuad,
} from "../../src/core/documents/scan/rotation";

const picture: PagePicture = {
  width: 3,
  height: 2,
  pixels: Uint8Array.from([1, 2, 3, 4, 5, 6]),
};

function line(text: string, confidence: number, vertical = false): RecognizedLine {
  const pieces = [...text];
  return {
    text,
    quad: vertical
      ? [
          [0, 0],
          [10, 0],
          [10, 100],
          [0, 100],
        ]
      : [
          [0, 0],
          [100, 0],
          [100, 10],
          [0, 10],
        ],
    confidence,
    characters: pieces.map((piece, index) => ({
      text: piece,
      confidence,
      at: (index + 0.5) / pieces.length,
    })),
  };
}

async function choose(hint: number, readings: readonly RecognizedLine[][]) {
  const queue = [...readings];
  const result = await readWithQuarterTurn(picture, hint, async () => {
    const next = queue.shift();
    if (!next) throw new Error("The page was read more often than expected.");
    return next;
  });
  expect(queue).toEqual([]);
  return result;
}

describe("A scanned page's quarter-turn (#1819)", () => {
  test("pixels turn clockwise at 90, 180 and 270 degrees, with discrete edge indices", () => {
    expect(turnPicture(picture, 0)).toBe(picture);
    expect(turnPicture(picture, 90)).toEqual({
      width: 2,
      height: 3,
      pixels: Uint8Array.from([4, 1, 5, 2, 6, 3]),
    });
    expect(turnPicture(picture, 180)).toEqual({
      width: 3,
      height: 2,
      pixels: Uint8Array.from([6, 5, 4, 3, 2, 1]),
    });
    expect(turnPicture(picture, 270)).toEqual({
      width: 2,
      height: 3,
      pixels: Uint8Array.from([3, 6, 2, 5, 1, 4]),
    });
  });

  test("continuous points use page boundaries, not pixel indices", () => {
    const unit = { width: 1, height: 1 };
    expect(turnPoint([0.2, 0.3], 90, unit)).toEqual([0.7, 0.2]);
    expect(turnPoint([0.2, 0.3], 180, unit)).toEqual([0.8, 0.7]);
    expect(turnPoint([0.2, 0.3], 270, unit)).toEqual([0.3, 0.8]);
  });

  test("a confident horizontal reading stays as displayed after one pass, even with a /Rotate hint", async () => {
    const result = await choose(90, [[line("Upright text", 0.98)]]);
    expect(result).toMatchObject({ turn: 0, passes: 1 });
  });

  test("a high-confidence sideways reading still falls back to the hinted upright frame", async () => {
    const result = await choose(90, [[line("N", 0.982, true)], [line("2", 0.986)]]);
    expect(result).toMatchObject({ turn: 270, passes: 2 });
    expect(result.lines[0]?.text).toBe("2");
  });

  test("a worker transferring the first picture leaves its source available for the fallback", async () => {
    const source = { ...picture, pixels: new Uint8Array(picture.pixels) };
    const queue = [[line("N", 0.982, true)], [line("2", 0.986)]];
    const seen: number[][] = [];
    const result = await readWithQuarterTurn(source, 90, async (input) => {
      seen.push([...input.pixels]);
      const buffer = input.pixels.buffer as ArrayBuffer;
      structuredClone(buffer, { transfer: [buffer] });
      const next = queue.shift();
      if (!next) throw new Error("The page was read more often than expected.");
      return next;
    });

    expect(result).toMatchObject({ turn: 270, passes: 2 });
    expect(seen).toEqual([
      [1, 2, 3, 4, 5, 6],
      [3, 6, 2, 5, 1, 4],
    ]);
    expect([...source.pixels]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a sideways source picture without metadata tries both quarter-turn directions", async () => {
    const result = await choose(0, [
      [line("Sideways text", 0.98, true)],
      [line(" upside ", 0.65)],
      [line("Upright text", 0.98)],
    ]);
    expect(result).toMatchObject({ turn: 270, passes: 3 });
  });

  test("an upside-down reading tries the half-turn first", async () => {
    const result = await choose(0, [[line("garbage", 0.65)], [line("Upright", 0.98)]]);
    expect(result).toMatchObject({ turn: 180, passes: 2 });
  });

  test("a settled candidate does not displace a preferred earlier fallback", async () => {
    const result = await choose(0, [
      [line("aa", 0.6)],
      [line("aa", 0.95), line("bbb", 0.95, true)],
      [line("a", 0.85), line("b", 0.85, true)],
      [],
    ]);

    expect(result).toMatchObject({ turn: 180, passes: 4 });
  });

  test("an ambiguous page of vertical text keeps its first reading", async () => {
    const upright = [line("豎排文字上下閱讀", 0.98, true)];
    const result = await choose(0, [
      upright,
      [line("abcde", 0.65)],
      [line("豎排文字上下閱讀", 0.98, true)],
      [line("fghij", 0.65)],
    ]);
    expect(result).toMatchObject({ turn: 0, passes: 4, lines: upright });
  });

  test.each([0, 90, 180, 270] as const)(
    "final anchor corners round-trip into displayed-page fractions at %i degrees",
    (turn: QuarterTurn) => {
      const displayed = [0.1, 0.2, 0.3, 0.2, 0.3, 0.4, 0.1, 0.4];
      const reading = turnQuad(displayed, turn, { width: 1, height: 1 });
      const [anchor] = anchorsBack([{ start: 2, end: 7, target: "line1", quad: reading }], turn);
      expect(anchor).toMatchObject({ start: 2, end: 7, target: "line1" });
      for (const [index, value] of (anchor?.quad ?? []).entries()) {
        expect(value).toBeCloseTo(displayed[index] ?? 0, 12);
      }
    },
  );
});
