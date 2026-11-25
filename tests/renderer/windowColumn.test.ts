import { describe, expect, it } from "vitest";
import { columnFits, sharesBeside } from "../../src/renderer/src/components/tabs/windowColumn";

/** The card a window this wide holds with the sidebar at its default 248px, 8px from each. */
const cardOf = (window: number, sidebar = true) => window - (sidebar ? 264 : 16);

describe("the window's conversation column beside the tab groups (#3759)", () => {
  // protects=the column stands beside the groups only while its Note keeps about 490px of text and every other group 400px, measured on the whole tab area; fails_when=a Note or a Document beside the column is squeezed narrower, or one group's width decides it
  it("fits where its Note keeps a readable width and every other group 400px", () => {
    expect(columnFits(null, 1)).toBe(false);
    expect(columnFits(cardOf(1440), 1)).toBe(true);
    expect(columnFits(cardOf(1280), 1)).toBe(true);
    expect(columnFits(930, 1)).toBe(true);
    expect(columnFits(929, 1)).toBe(false);
    expect(columnFits(cardOf(1100), 1)).toBe(false);
    expect(columnFits(cardOf(1100, false), 1)).toBe(true);
    expect(columnFits(cardOf(1440), 2)).toBe(false);
    expect(columnFits(cardOf(1440, false), 2)).toBe(true);
    expect(columnFits(cardOf(1600), 2)).toBe(true);
    expect(columnFits(cardOf(1280), 2)).toBe(false);
    expect(columnFits(cardOf(1600), 3)).toBe(false);
  });

  // protects=where a scrollbar takes room beside the Note's text, the Note keeps that room on top of its 570px, so its text is still about 490px; fails_when=a Note with a scrollbar beside its text is left narrower than 490px of text
  it("keeps a scrollbar's room for the Note on top of its readable width", () => {
    expect(columnFits(944, 1, 15)).toBe(false);
    expect(columnFits(945, 1, 15)).toBe(true);
    const px = (shares: number[], room: number) => shares.map((share) => Math.round(share * room));
    expect(px(sharesBeside([0.5, 0.5], 0, 990, 15), 990)).toEqual([585, 405]);
  });

  // protects=beside the column the Note's group keeps 570px and every other group 400px, what they lack taken from the groups wider than they need, the Note's own too, and the shares still fill the room; fails_when=the Note stays narrow, a group the User dragged narrow stays under 400px, or the groups no longer fill the tab area
  it("gives the Note 570px and every other group 400px, from the groups wider than they need", () => {
    const px = (shares: number[], room: number) => shares.map((share) => Math.round(share * room));
    const sum = (shares: number[]) => shares.reduce((all, share) => all + share, 0);
    expect(px(sharesBeside([0.5, 0.5], 0, 975), 975)).toEqual([570, 405]);
    expect(px(sharesBeside([0.5, 0.5], 1, 975), 975)).toEqual([405, 570]);
    // Dragged narrow: the narrow group gets its least back, from the wide one.
    for (const [shares, at, drawn] of [
      [[0.8, 0.2], 0, [575, 400]],
      [[0.2, 0.8], 0, [570, 405]],
      [[0.8, 0.2], 1, [405, 570]],
      [[0.2, 0.8], 1, [400, 575]],
    ] as const) {
      const beside = sharesBeside(shares, at, 975);
      expect(px(beside, 975), `${shares} with the Note at ${at}`).toEqual(drawn);
      expect(sum(beside)).toBeCloseTo(1, 6);
    }
    const three = sharesBeside([1 / 3, 1 / 3, 1 / 3], 1, 1400);
    expect(px(three, 1400)).toEqual([415, 570, 415]);
    expect(sum(three)).toBeCloseTo(1, 6);
    const dragged = sharesBeside([0.45, 0.45, 0.1], 0, 1400);
    expect(px(dragged, 1400)).toEqual([576, 424, 400]);
    expect(sum(dragged)).toBeCloseTo(1, 6);
    expect(sharesBeside([0.5, 0.5], -1, 975)).toEqual([0.5, 0.5]);
  });

  // protects=wherever the column fits, every group gets its least beside it, whatever the User dragged; where the room can't hold them the column doesn't fit, and the shares are given back as kept; fails_when=a fitting column leaves a group under its least, or a room too small gives a group less than nothing
  it("meets every group's least wherever the column fits, and only there", () => {
    for (const scrollbar of [0, 15]) {
      for (const groups of [1, 2, 3]) {
        for (let card = 800; card <= 2200; card += 25) {
          const room = card - 360 - (groups - 1);
          const asKept = (parts: number[]) => {
            const total = parts.reduce((all, part) => all + part, 0);
            return parts.map((part) => part / total);
          };
          for (const shares of [
            asKept(Array.from({ length: groups }, () => 1)),
            asKept(Array.from({ length: groups }, (_, index) => (index === 0 ? 9 : 1))),
            asKept(Array.from({ length: groups }, (_, index) => (index === groups - 1 ? 9 : 1))),
          ]) {
            for (let at = 0; at < groups; at++) {
              const beside = sharesBeside(shares, at, room, scrollbar);
              const least = (index: number) => (index === at ? 570 + scrollbar : 400);
              const met = beside.every((share, index) => share * room >= least(index) - 0.5);
              if (columnFits(card, groups, scrollbar))
                expect(met, `${card} px, ${groups}`).toBe(true);
              else expect(beside).toEqual(shares);
            }
          }
        }
      }
    }
  });

  // protects=the widths the layout keeps are only drawn differently beside the column, never changed, so they come back as it leaves; fails_when=drawing beside the column changes the kept widths
  it("leaves the kept shares as they are", () => {
    const kept = Object.freeze([0.8, 0.2]);
    sharesBeside(kept, 0, 975);
    expect(kept).toEqual([0.8, 0.2]);
  });
});
