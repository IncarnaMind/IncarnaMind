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
const ZH: FigureContext = { language: "zh-CN" };

const lineBefore = (text: string, at: number) => text.slice(text.lastIndexOf("\n", at - 1) + 1, at);

describe("A quote whose page mentions it before its Passage (#1981)", () => {
  // protects=the quote is placed at the heading inside its own Passage, offset 11 with nothing before it on its line, so 3.1 stays a heading's number; fails_when=the earlier mention at offset 3, after "详见 ", is placed and 3.1 is read as a figure; no_claim=none beyond protects.
  test("is placed inside its Passage, not at the earlier mention", () => {
    expect(PAGE.indexOf(HEADING)).toBe(3);
    const at = quoteOnPage(PAGE, HEADING, PASSAGE);
    expect(at).toBe(11);
    expect(lineBefore(PAGE, at)).toBe("");
    expect(readFigures(HEADING, { ...ZH, midLine: lineBefore(PAGE, at).trim() !== "" })).toEqual(
      [],
    );
  });

  // protects=a page that doesn't have the Passage's own text keeps the quote's first place, as before; fails_when=the quote isn't placed at all; no_claim=none beyond protects.
  test("keeps the first place where the Passage's own text isn't on the page", () => {
    expect(quoteOnPage(PAGE, HEADING, "")).toBe(3);
    expect(quoteOnPage(PAGE, HEADING, "另一处的文字")).toBe(3);
  });
});
