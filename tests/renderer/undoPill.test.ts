import { describe, expect, test } from "vitest";
import {
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

  test("a band belongs only to the page under the pill", () => {
    expect(undoBandFor({ groupId: "a", height: 40 }, "a")).toBe(40);
    expect(undoBandFor({ groupId: "a", height: 40 }, "b")).toBe(0);
    expect(undoBandFor({ groupId: null, height: 0 }, "a")).toBe(0);
  });
});
