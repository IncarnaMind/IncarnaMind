import { describe, expect, test } from "vitest";
import { wrappedFocus } from "../../src/renderer/src/editor/cardFocus";

describe("Tab through a sentence's check card (#1762)", () => {
  test("moves on through the actions in the middle", () => {
    expect(wrappedFocus(0, 3, false)).toBeNull();
    expect(wrappedFocus(1, 3, false)).toBeNull();
    expect(wrappedFocus(1, 3, true)).toBeNull();
    expect(wrappedFocus(2, 3, true)).toBeNull();
  });

  test("wraps from the last action to the first, and back", () => {
    expect(wrappedFocus(2, 3, false)).toBe(0);
    expect(wrappedFocus(0, 3, true)).toBe(2);
  });

  test("a card with one action keeps it", () => {
    expect(wrappedFocus(0, 1, false)).toBe(0);
    expect(wrappedFocus(0, 1, true)).toBe(0);
  });

  test("a card with no action moves nowhere", () => {
    expect(wrappedFocus(-1, 0, false)).toBeNull();
    expect(wrappedFocus(-1, 0, true)).toBeNull();
  });

  test("the focus on the card itself goes to its first or last action", () => {
    expect(wrappedFocus(-1, 3, false)).toBe(0);
    expect(wrappedFocus(-1, 3, true)).toBe(2);
  });
});
