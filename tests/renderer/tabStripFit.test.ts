import { describe, expect, test } from "vitest";
import { fitStrip, type Span } from "../../src/renderer/src/tabStripFit";

const END_GAP = 10;

/** Tabs side by side after the strip's 10px of padding. */
function tabsOf(widths: number[], start = 10): Span[] {
  let left = start;
  return widths.map((width) => {
    const span = { left, right: left + width };
    left += width;
    return span;
  });
}

const restOf = (widths: number[], room: number, shown = -1, scrollLeft = 0) =>
  fitStrip({ tabs: tabsOf(widths), room, endGap: END_GAP, scrollLeft, shown });

describe("where a strip of tabs comes to rest", () => {
  test("is not cut when every tab fits", () => {
    expect(restOf([166, 166], 375)).toMatchObject({ run: null, scrollLeft: 0 });
    expect(restOf([], 375)).toMatchObject({ run: null, scrollLeft: 0 });
  });

  test("shows whole tabs from the start, cut after the last that fits, keeping the gap before the +", () => {
    expect(restOf([166, 166, 166], 375)).toEqual({
      run: 342,
      gap: END_GAP,
      scrollLeft: 0,
      first: 0,
      last: 1,
    });
  });

  test("brings a hidden tab on the right into view whole, ending the strip with its foot", () => {
    expect(restOf([166, 166, 166], 375, 2)).toEqual({
      run: 342,
      gap: 0,
      scrollLeft: 176,
      first: 1,
      last: 2,
    });
  });

  test("brings a hidden tab on the left to the start, moving no further than it must", () => {
    const widths = [166, 166, 166, 166, 166];
    const atEnd = restOf(widths, 375, 4);
    expect(atEnd.first).toBe(3);
    const back = restOf(widths, 375, 2, atEnd.scrollLeft);
    expect(back).toMatchObject({ first: 2, last: 3, gap: END_GAP });
  });

  test("leaves the strip where it is while the shown tab is in it", () => {
    const widths = [166, 166, 166, 166, 166];
    const middle = restOf(widths, 375, 2, 176 + 166);
    expect(middle).toMatchObject({ first: 2, last: 3 });
    expect(restOf(widths, 375, 3, middle.scrollLeft)).toMatchObject({ first: 2, last: 3 });
  });

  test("settles on the tab edge nearest where the User scrolled to", () => {
    const widths = [166, 166, 166, 166, 166, 166];
    expect(restOf(widths, 375, -1, 176 + 60)).toMatchObject({ first: 1, scrollLeft: 176 });
    expect(restOf(widths, 375, -1, 176 + 110)).toMatchObject({ first: 2, scrollLeft: 342 });
  });

  test("starts the last run early enough to leave no room blank", () => {
    const widths = [166, 166, 166, 166, 166];
    expect(restOf(widths, 375, -1, 10_000)).toMatchObject({ first: 3, last: 4, gap: 0 });
  });

  test("shows a tab wider than the room, and no more", () => {
    expect(restOf([300, 300], 200, 1)).toMatchObject({ first: 1, last: 1, run: 200, gap: 0 });
  });

  test("leaves no tab clipped at either edge for any tabs, room, scroll or shown tab", () => {
    for (const widths of [
      [166, 166, 166, 166, 166, 166, 166, 166],
      [96, 220, 140, 96, 180, 96, 96, 132],
      [150, 150, 150, 220],
    ]) {
      const tabs = tabsOf(widths);
      for (const room of [250, 333, 375, 499, 555, 700]) {
        for (let scrollLeft = 0; scrollLeft < 1400; scrollLeft += 97) {
          for (let shown = -1; shown < widths.length; shown++) {
            const result = fitStrip({ tabs, room, endGap: END_GAP, scrollLeft, shown });
            if (result.run === null) continue;
            const end = result.scrollLeft + result.run;
            expect(result.run + result.gap).toBeLessThanOrEqual(room);
            tabs.forEach((tab, index) => {
              const inside = tab.left >= result.scrollLeft - 0.5 && tab.right <= end + 0.5;
              const outside = tab.right <= result.scrollLeft + 0.5 || tab.left >= end - 0.5;
              const message = `${widths} room ${room} scroll ${scrollLeft} shown ${shown} tab ${index}`;
              expect(inside || outside, message).toBe(true);
              expect(inside, message).toBe(index >= result.first && index <= result.last);
            });
            if (shown >= 0) {
              expect(shown, `${widths} room ${room} shown ${shown}`).toBeGreaterThanOrEqual(
                result.first,
              );
              expect(shown).toBeLessThanOrEqual(result.last);
            }
          }
        }
      }
    }
  });
});
