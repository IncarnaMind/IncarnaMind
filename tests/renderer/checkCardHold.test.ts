import { describe, expect, it } from "vitest";
import { CARD_MARGIN, firstHeight } from "../../src/renderer/src/editor/checkCardHold";

describe("the height an empty check card takes from what lands first", () => {
  const badge = { top: 700, bottom: 728 };

  it("takes all the content when it fits above the badge", () => {
    const card = { top: 600, bottom: 692 };
    expect(firstHeight({ natural: 90, rest: 26, card, chrome: 70, badge })).toBe(90);
  });

  it("stops at the window's margin when the content is taller than the room above", () => {
    const card = { top: -300, bottom: 692 };
    expect(firstHeight({ natural: 900, rest: 26, card, chrome: 70, badge })).toBe(
      692 - CARD_MARGIN - 70,
    );
  });

  it("stays as it was below its badge, whatever lands", () => {
    const under = { top: 60, bottom: 88 };
    const grown = { top: -170, bottom: 200 };
    expect(firstHeight({ natural: 300, rest: 26, card: grown, chrome: 70, badge: under })).toBe(26);
    expect(firstHeight({ natural: 20, rest: 26, card: grown, chrome: 70, badge: under })).toBe(26);
  });

  it("opening down from a badge at the Note's top right, takes all that fits above the window's foot", () => {
    const top = { top: 60, bottom: 88 };
    const card = { top: 96, bottom: 188 };
    expect(firstHeight({ natural: 300, rest: 26, card, chrome: 70, badge: top, downTo: 900 })).toBe(
      300,
    );
    expect(firstHeight({ natural: 900, rest: 26, card, chrome: 70, badge: top, downTo: 900 })).toBe(
      900 - CARD_MARGIN - 96 - 70,
    );
  });

  it("never asks for less than nothing", () => {
    const card = { top: 0, bottom: 40 };
    expect(firstHeight({ natural: 200, rest: 26, card, chrome: 70, badge })).toBe(0);
  });
});
