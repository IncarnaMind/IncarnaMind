import { describe, expect, test } from "vitest";
import { type FigureContext, figureReadingSteps, readFigures } from "../../src/shared/figures";

/**
 * A garbled table or a bad scan is read in steps that grow with its length, never faster (#2510):
 * each test bounds the reader's own count of its steps, 8 for each character read.
 */
function read(text: string, context: FigureContext = {}) {
  const before = figureReadingSteps();
  const figures = readFigures(text, context);
  const steps = figureReadingSteps() - before;
  expect(steps).toBeLessThanOrEqual(8 * text.length);
  return figures;
}

const MIXED = "1,2.3,4.5,";

describe("A run of digit groups with mixed separators", () => {
  test("five times over reads as the longest start that is one number, then the rest", () => {
    expect(read(MIXED.repeat(5)).map((figure) => [figure.chars, figure.value])).toEqual([
      ["1,2", 1.2],
      ["3,4", 3.4],
      ["5,1", 5.1],
      ["2.3", 2.3],
      ["4.5", 4.5],
      ["1,2", 1.2],
      ["3,4", 3.4],
      ["5,1", 5.1],
      ["2.3", 2.3],
      ["4.5", 4.5],
      ["1,2", 1.2],
      ["3,4", 3.4],
      ["5", 5],
    ]);
  });

  test.each([
    [50, 125],
    [5_000, 12_500],
    // 100 KB of it.
    [10_000, 25_000],
  ])("%i times over reads the same five numbers over and over", (times, count) => {
    const figures = read(MIXED.repeat(times));
    expect(figures).toHaveLength(count);
    figures.forEach((figure, index) => {
      expect(figure.chars).toBe(["1,2", "3,4", "5,1", "2.3", "4.5"][index % 5]);
      expect(figure.start).toBe(4 * index);
    });
    expect(figures.at(-1)).toMatchObject({ chars: "4.5", value: 4.5, end: 10 * times - 1 });
  });
});

test("100 KB of numbers set apart by single spaces reads each number once", () => {
  const figures = read("12 34 ".repeat(16_666));
  expect(figures).toHaveLength(33_332);
  expect(figures.slice(0, 3).map((figure) => [figure.chars, figure.start])).toEqual([
    ["12", 0],
    ["34", 3],
    ["12", 6],
  ]);
  expect(figures.at(-1)).toMatchObject({ chars: "34", value: 34, start: 99_993 });
});

test("100 KB of bracketed amounts on one line reads the line once, not once for each amount", () => {
  const figures = read("(1,234) ".repeat(12_500));
  expect(figures).toHaveLength(12_500);
  for (const figure of figures) {
    expect(figure.chars).toBe("(1,234)");
    expect(figure.value).toBe(-1234);
  }
});

test("100 KB of Chinese numerals that write no number reads no figure", () => {
  expect(read("一二三四五六七八九十".repeat(10_000))).toEqual([]);
});

test("100 KB of dates passes over each date once", () => {
  const text = "2024-01-01 ".repeat(9_090);
  expect(read(text)).toEqual([]);
  const asked = read(text, { dates: true });
  expect(asked).toHaveLength(27_270);
  expect(asked.slice(0, 3).map((figure) => [figure.chars, figure.value])).toEqual([
    ["2024", 2024],
    ["01", 1],
    ["01", 1],
  ]);
});
