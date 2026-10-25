import { describe, expect, test } from "vitest";
import {
  bandsUnderPill,
  fitsLeftOfText,
  showsUndoPill,
  undoBandFor,
  undoBandHeight,
} from "../../src/renderer/src/undoPill";

describe("the undo line's place", () => {
  test("the sidebar shown: the line is at its foot", () => {
    expect(showsUndoPill({ hidden: false, peeking: false })).toBe(false);
  });

  test("the sidebar hidden: the line is the pill", () => {
    expect(showsUndoPill({ hidden: true, peeking: false })).toBe(true);
  });

  test("the sidebar hidden but peeked out: its foot again, where the User can click", () => {
    expect(showsUndoPill({ hidden: true, peeking: true })).toBe(false);
  });

  test("a window that hasn't said: its foot, as it was before the sidebar could hide", () => {
    expect(showsUndoPill(null)).toBe(false);
  });
});

describe("where the pill keeps clear of the page's text", () => {
  const PILL = 180;

  test("the gutter holds the pill with 8px to spare from the card's edge", () => {
    expect(fitsLeftOfText(PILL + 8, PILL)).toBe(true);
  });

  test("one pixel narrower than the pill and the 8px inset: the page gives it a band", () => {
    expect(fitsLeftOfText(PILL + 8 - 1, PILL)).toBe(false);
  });

  test("the band runs from the page's foot up to the pill's top", () => {
    expect(undoBandHeight(520, 0, 480)).toBe(40);
  });

  test("a page already ending above the pill needs no band", () => {
    expect(undoBandHeight(460, 0, 480)).toBe(0);
  });

  test("the band a page has given already isn't taken twice", () => {
    expect(undoBandHeight(480, 40, 480)).toBe(40);
  });

  test("a band belongs only to its own page", () => {
    expect(undoBandFor({ a: 40 }, "a")).toBe(40);
    expect(undoBandFor({ a: 40 }, "b")).toBe(0);
    expect(undoBandFor({}, "a")).toBe(0);
    expect(undoBandFor({ a: 40 }, undefined)).toBe(0);
  });
});

describe("the pages a wide pill spans", () => {
  // Measured at 1600x900 with three groups (#1914): a long rename made the pill 327px wide, past
  // the 220px group it starts in and into the next page's letters.
  const CARD_LEFT = 8;
  const PILL = { left: 16, right: 343.3, width: 327.3, top: 819.4 };
  const nearPage = { columnLeft: 24, scrollerBottom: 852, applied: 0 };
  const nextPage = { columnLeft: 245, scrollerBottom: 852, applied: 0 };

  test("the page under its left edge and the page it reaches into both give a band", () => {
    expect(
      bandsUnderPill(PILL, CARD_LEFT, [
        { groupId: "first", left: 8, right: 228, ...nearPage },
        { groupId: "second", left: 229, right: 449, ...nextPage },
      ]),
    ).toEqual({ first: 33, second: 33 });
  });

  test("a page the pill doesn't reach keeps its whole view", () => {
    expect(
      bandsUnderPill(PILL, CARD_LEFT, [{ groupId: "third", left: 450, right: 1592, ...nextPage }]),
    ).toEqual({});
  });

  test("a page whose text starts in the gutter right of the pill gives no band", () => {
    expect(
      bandsUnderPill(PILL, CARD_LEFT, [
        { groupId: "wide", left: 8, right: 1592, columnLeft: 400, scrollerBottom: 852, applied: 0 },
      ]),
    ).toEqual({});
  });

  test("a page that has given its band already keeps the same one", () => {
    expect(
      bandsUnderPill(PILL, CARD_LEFT, [
        {
          groupId: "second",
          left: 229,
          right: 449,
          columnLeft: 245,
          scrollerBottom: 819.4,
          applied: 33,
        },
      ]),
    ).toEqual({ second: 33 });
  });

  test("a pill that only touches a group's edge leaves it alone", () => {
    expect(
      bandsUnderPill({ ...PILL, right: 229 }, CARD_LEFT, [
        { groupId: "second", left: 229, right: 449, ...nextPage },
      ]),
    ).toEqual({});
  });
});
