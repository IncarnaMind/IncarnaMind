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

  // protects=beside the column the Note's group keeps 570px, taken first from the groups that have room above 400px, and the shares still fill the room; fails_when=the Note stays narrow, a Document goes under 400px, or the groups no longer fill the tab area
  it("gives the Note its room from the other groups, as far as they are wider than 400px", () => {
    const px = (shares: number[], room: number) => shares.map((share) => Math.round(share * room));
    expect(px(sharesBeside([0.5, 0.5], 0, 975), 975)).toEqual([570, 405]);
    expect(px(sharesBeside([0.5, 0.5], 1, 975), 975)).toEqual([405, 570]);
    expect(sharesBeside([0.8, 0.2], 0, 975)).toEqual([0.8, 0.2]);
    const three = sharesBeside([1 / 3, 1 / 3, 1 / 3], 1, 1400);
    expect(px(three, 1400)).toEqual([415, 570, 415]);
    expect(three.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 6);
    expect(sharesBeside([0.5, 0.5], -1, 975)).toEqual([0.5, 0.5]);
  });
});
