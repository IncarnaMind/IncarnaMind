/**
 * Where a quote that starts with a figure is on its page (#1981): the occurrence inside the Passage it
 * was taken from, not an earlier mention of the same words on the same page.
 */
import { describe, expect, test } from "vitest";
import { quoteOnPage } from "../../src/core/answers/calculations";
import { type FigureContext, readFigures } from "../../src/shared/figures";

const HEADING = "3.1 收入";
const PASSAGE = `${HEADING}\n收入为400.0`;
const PAGE = `详见 ${HEADING}。\n${PASSAGE}`;
const FIGURES = "88.0 和 91.5（2025年上半年、2026年上半年）";
const ZH: FigureContext = { language: "zh-CN" };

const lineBefore = (text: string, at: number) => text.slice(text.lastIndexOf("\n", at - 1) + 1, at);

describe("A quote whose page mentions it before its Passage (#1981)", () => {
  // protects=the quote is placed at the heading inside its own Passage, offset 11 with nothing before it on its line, so 3.1 stays a heading's number; fails_when=the earlier mention at offset 3, after "详见 ", is placed and 3.1 is read as a figure; no_claim=none beyond protects.
  test("is placed inside its Passage, not at the earlier mention", () => {
    expect(quoteOnPage(PAGE, HEADING, PASSAGE)).toEqual({ at: 11, midLine: false });
    expect(lineBefore(PAGE, 11)).toBe("");
    expect(readFigures(HEADING, { ...ZH, midLine: false })).toEqual([]);
  });

  // protects=a quote found twice in its Passage is read from the middle of a line only when every place it is starts there, so a line-start heading keeps main's reading; fails_when=the earlier mention at offset 3 gives midLine true and 3.1 is read as a figure; no_claim=none beyond protects.
  test("is not read from a line's middle when any place it is starts a line", () => {
    expect(quoteOnPage(PAGE, HEADING, PAGE)).toEqual({ at: 3, midLine: false });
  });

  // protects=with the Passage's own text off the page, its cited Units are searched for every place the quote is: a line-start place keeps the heading's reading, and a quote found only mid-line keeps the figure's; fails_when=one placement decides for both; no_claim=none beyond protects.
  test("falls back to every place on the page when the Passage's text isn't there", () => {
    expect(quoteOnPage(PAGE, HEADING, "")).toEqual({ at: 3, midLine: false });
    expect(quoteOnPage(PAGE, HEADING, "另一处的文字")).toEqual({ at: 3, midLine: false });
    const once = `详见 ${FIGURES}。`;
    expect(quoteOnPage(once, FIGURES, "")).toEqual({ at: 3, midLine: true });
  });
});
