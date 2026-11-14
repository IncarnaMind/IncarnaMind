import { describe, expect, it } from "vitest";
import { CARD_MARGIN, firstHeight } from "../../src/renderer/src/editor/checkCardHold";

describe("the height an empty check card takes from what lands first", () => {
  const badge = { top: 700, bottom: 728 };

  it("takes all the content when it fits above the badge", () => {
    const card = { top: 600, bottom: 692 };
    expect(firstHeight({ natural: 90, card, chrome: 70, badge })).toBe(90);
  });

  it("stops at the window's margin when the content is taller than the room above", () => {
    const card = { top: -300, bottom: 692 };
    expect(firstHeight({ natural: 900, card, chrome: 70, badge })).toBe(692 - CARD_MARGIN - 70);
  });

  it("takes only the badge's bottom edge below it, never the badge itself", () => {
    const under = { top: 60, bottom: 88 };
    const grown = { top: -170, bottom: 200 };
    expect(firstHeight({ natural: 300, card: grown, chrome: 70, badge: under })).toBe(
      200 - 88 - 70,
    );
    expect(firstHeight({ natural: 20, card: grown, chrome: 70, badge: under })).toBe(20);
  });

  it("never asks for less than nothing", () => {
    const card = { top: 0, bottom: 40 };
    expect(firstHeight({ natural: 200, card, chrome: 70, badge })).toBe(0);
  });
});
