import { describe, expect, test } from "vitest";
import { showsUndoPill } from "../../src/renderer/src/undoPill";

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
