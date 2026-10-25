import { describe, expect, test } from "vitest";
import { leastGivenUp } from "../../src/renderer/src/components/library/useFittingColumns";

/** `fits` for a page whose names fit from `enough` on, counting how often it is asked. */
function page(enough: number) {
  const asked: number[] = [];
  return {
    asked,
    fits: (step: number) => {
      asked.push(step);
      return step >= enough;
    },
  };
}

describe("the columns a page gives up for its names", () => {
  test("none, when the names fit: one measure", () => {
    const { asked, fits } = page(0);
    expect(leastGivenUp(0, 6, fits)).toBe(0);
    expect(asked).toEqual([0]);
  });

  test("as many as it takes, found going up from the step in force", () => {
    const { asked, fits } = page(3);
    expect(leastGivenUp(0, 6, fits)).toBe(3);
    expect(asked).toEqual([0, 1, 2, 3]);
  });

  test("settled, two measures however many columns are given up: the step in force and the one before", () => {
    const { asked, fits } = page(5);
    expect(leastGivenUp(5, 6, fits)).toBe(5);
    expect(asked).toEqual([5, 4]);
  });

  test("fewer once there is room again, found going down", () => {
    const { asked, fits } = page(2);
    expect(leastGivenUp(5, 6, fits)).toBe(2);
    expect(asked).toEqual([5, 4, 3, 2, 1]);
  });

  test("the last step, though nothing fits, where it stops", () => {
    const { asked, fits } = page(99);
    expect(leastGivenUp(4, 6, fits)).toBe(6);
    expect(asked).toEqual([4, 5, 6]);
  });
});
