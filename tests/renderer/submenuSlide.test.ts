import { describe, expect, test } from "vitest";
import { isSlidingTo } from "../../src/renderer/src/components/submenuSlide";

/** A submenu to the right of its item, with its near edge at x = 300 from y = 100 to y = 220. */
const box = { left: 300, right: 500, top: 100, bottom: 220 };
const apex = { x: 120, y: 114 };

describe("The way from a submenu's item to the submenu", () => {
  test("takes in the rows a diagonal slide to a lower choice crosses", () => {
    expect(isSlidingTo({ x: 200, y: 150 }, apex, box)).toBe(true);
    expect(isSlidingTo({ x: 280, y: 190 }, apex, box)).toBe(true);
  });

  test("ends where the pointer leaves it: straight down the menu, or up and away", () => {
    expect(isSlidingTo({ x: 122, y: 180 }, apex, box)).toBe(false);
    expect(isSlidingTo({ x: 200, y: 20 }, apex, box)).toBe(false);
    expect(isSlidingTo({ x: 280, y: 260 }, apex, box)).toBe(false);
  });

  test("allows a hand's wobble just behind where it started", () => {
    expect(isSlidingTo({ x: 116, y: 115 }, apex, box)).toBe(true);
  });

  test("works the same toward a submenu that opened on the left", () => {
    const left = { left: 0, right: 100, top: 100, bottom: 220 };
    expect(isSlidingTo({ x: 180, y: 160 }, { x: 260, y: 114 }, left)).toBe(true);
    expect(isSlidingTo({ x: 262, y: 200 }, { x: 260, y: 114 }, left)).toBe(false);
  });
});
