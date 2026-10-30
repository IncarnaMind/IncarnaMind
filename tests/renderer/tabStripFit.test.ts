import { describe, expect, test } from "vitest";
import { fitStrip, type TabSpan } from "../../src/renderer/src/tabStripFit";

const END_GAP = 10;
const FADE = 32;
/** A tab's name starts after its icon and ends before its ✕, this far in from each edge. */
const NAME_INSET = 34;
/** How far a strip reaches into a hidden tab: past the blank at its edge, and the fade into its name. */
const INTO = NAME_INSET + FADE;

/** Tabs side by side after the strip's 10px of padding. */
function tabsOf(widths: number[], start = 10): TabSpan[] {
  let left = start;
  return widths.map((width) => {
    const right = left + width;
    const span = { left, right, name: { left: left + NAME_INSET, right: right - NAME_INSET } };
    left = right;
    return span;
  });
}

const restOf = (widths: number[], room: number, shown = -1, scrollLeft = 0) =>
  fitStrip({ tabs: tabsOf(widths), room, endGap: END_GAP, fade: FADE, scrollLeft, shown });

describe("where a strip of tabs comes to rest", () => {
  test("is not cut when every tab fits", () => {
    expect(restOf([166, 166], 375)).toMatchObject({ run: null, scrollLeft: 0 });
    expect(restOf([], 375)).toMatchObject({ run: null, scrollLeft: 0 });
  });

  test("shows whole tabs from the start and the start of the next one's name, keeping the gap before the +", () => {
    expect(restOf([166, 166, 166], 450)).toEqual({
      run: 10 + 166 + 166 + INTO,
      gap: END_GAP,
      scrollLeft: 0,
      first: 0,
      last: 1,
    });
  });

  test("shows the end of a hidden tab's name before the shown tab, whatever room is left (#2244)", () => {
    // Two tabs at their narrowest in a group beside a Citation's page, with room for one.
    const shown = restOf([166, 148], 256, 1);
    expect(shown).toEqual({
      run: INTO + 148 + END_GAP,
      gap: 0,
      scrollLeft: 176 - INTO,
      first: 1,
      last: 1,
    });
    expect(restOf([166, 148], 256, 0)).toEqual({
      run: 10 + 166 + INTO,
      gap: END_GAP,
      scrollLeft: 0,
      first: 0,
      last: 0,
    });
    // Settled again where it rests, after a scroll that wasn't the User's, it stays.
    expect(restOf([166, 148], 256, -1, shown.scrollLeft)).toEqual(shown);
  });

  test("brings a hidden tab on the right into view whole, ending the strip with its foot", () => {
    expect(restOf([166, 166, 166], 450, 2)).toEqual({
      run: INTO + 166 + 166 + END_GAP,
      gap: 0,
      scrollLeft: 176 - INTO,
      first: 1,
      last: 2,
    });
  });

  test("brings a hidden tab on the left to the start, moving no further than it must", () => {
    const widths = [166, 166, 166, 166, 166];
    const atEnd = restOf(widths, 450, 4);
    expect(atEnd).toMatchObject({ first: 3, last: 4 });
    // With names showing on both sides, the room holds the shown tab alone.
    expect(restOf(widths, 450, 2, atEnd.scrollLeft)).toMatchObject({
      first: 2,
      last: 2,
      scrollLeft: 342 - INTO,
    });
  });

  test("leaves the strip where it is while the shown tab is in it", () => {
    const widths = [166, 166, 166, 166, 166];
    const middle = restOf(widths, 450, 2, 342 - INTO);
    expect(middle).toMatchObject({ first: 2, scrollLeft: 342 - INTO });
    expect(restOf(widths, 450, middle.last, middle.scrollLeft)).toEqual(middle);
  });

  test("settles on the tab nearest where the User scrolled to", () => {
    const widths = [166, 166, 166, 166, 166, 166];
    expect(restOf(widths, 450, -1, 176 - INTO + 60)).toMatchObject({ first: 1 });
    expect(restOf(widths, 450, -1, 342 - INTO - 40)).toMatchObject({ first: 2 });
  });

  test("starts the last run early enough to leave no room blank", () => {
    const widths = [166, 166, 166, 166, 166];
    expect(restOf(widths, 450, -1, 10_000)).toMatchObject({ first: 3, last: 4, gap: 0 });
  });

  test("lets the hidden names give way to a shown tab that alone nearly fills the room", () => {
    expect(restOf([166, 148], 180, 1)).toEqual({
      run: 180,
      gap: 0,
      scrollLeft: 176 - 22,
      first: 1,
      last: 1,
    });
  });

  test("shows a tab wider than the room, and no more", () => {
    expect(restOf([300, 300], 200, 1)).toMatchObject({ first: 1, last: 1, run: 200, gap: 0 });
  });

  test("shows whole tabs, and part of a hidden one's name at a side that hides tabs, for any tabs, room, scroll or shown tab", () => {
    for (const widths of [
      [166, 166, 166, 166, 166, 166, 166, 166],
      [96, 220, 140, 96, 180, 96, 96, 132],
      [150, 150, 150, 220],
      [166, 148],
    ]) {
      const tabs = tabsOf(widths);
      const end = (tabs.at(-1)?.right ?? 0) + END_GAP;
      for (const room of [250, 333, 375, 499, 555, 700]) {
        for (let scrollLeft = 0; scrollLeft < 1400; scrollLeft += 97) {
          for (let shown = -1; shown < widths.length; shown++) {
            const result = fitStrip({ tabs, room, endGap: END_GAP, fade: FADE, scrollLeft, shown });
            if (result.run === null) continue;
            const from = result.scrollLeft;
            const to = from + result.run;
            const message = `${widths} room ${room} scroll ${scrollLeft} shown ${shown}`;
            expect(result.run + result.gap, message).toBeLessThanOrEqual(room + 0.5);
            tabs.forEach((tab, index) => {
              const inside = tab.left >= from - 0.5 && tab.right <= to + 0.5;
              expect(inside, `${message} tab ${index}`).toBe(
                index >= result.first && index <= result.last,
              );
              const partly = !inside && tab.right > from + 0.5 && tab.left < to - 0.5;
              if (partly) {
                expect([result.first - 1, result.last + 1], `${message} tab ${index}`).toContain(
                  index,
                );
              }
            });
            // Room for the widest tab and a name on each side: a side that hides tabs shows one.
            if (room >= Math.max(...widths) + 2 * INTO + 2 * END_GAP) {
              if (from > 0.5) {
                expect(tabs[result.first - 1]?.name.right ?? 0, message).toBeGreaterThan(from + 1);
              }
              if (to < end - 0.5) {
                expect(tabs[result.last + 1]?.name.left ?? Infinity, message).toBeLessThan(to - 1);
              }
            }
            if (shown >= 0) {
              expect(shown, message).toBeGreaterThanOrEqual(result.first);
              expect(shown, message).toBeLessThanOrEqual(result.last);
            }
          }
        }
      }
    }
  });
});
