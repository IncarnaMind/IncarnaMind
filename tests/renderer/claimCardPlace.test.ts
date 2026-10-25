import { describe, expect, test } from "vitest";
import { movedClearOfBadge } from "../../src/renderer/src/editor/claimCardPlace";

// The page's check badge and a sentence's card, as the app lays them out at 900 px (#1686).
const BADGE = { left: 829, top: 544, right: 876, bottom: 572 };
const CARD = { width: 360, height: 200 };

const apart = (x: number, y: number, badge = BADGE, card = CARD) =>
  x + card.width <= badge.left ||
  x >= badge.right ||
  y + card.height <= badge.top ||
  y >= badge.bottom;

describe("a check card near the page's check badge (#1686)", () => {
  test("one that doesn't cover the badge stays where it is", () => {
    expect(movedClearOfBadge({ ...CARD, x: 519, y: 100 }, 98, BADGE)).toBeNull();
  });

  test("one over the badge goes above its mark, clear of it", () => {
    const moved = movedClearOfBadge({ ...CARD, x: 519, y: 382 }, 364, BADGE);
    expect(moved).toEqual({ y: 156 });
    expect(apart(519, moved?.y ?? 0)).toBe(true);
  });

  test("with no room above the mark, it goes left of the badge", () => {
    const tall = { ...CARD, height: 295 };
    const moved = movedClearOfBadge({ ...tall, x: 519, y: 286 }, 282, BADGE);
    expect(moved).toEqual({ x: 461 });
    expect(apart(moved?.x ?? 0, 286, BADGE, tall)).toBe(true);
  });

  test("with no room above or left, it moves up clear of the badge, over its mark", () => {
    const tall = { ...CARD, height: 295 };
    const narrow = { ...BADGE, left: 300, right: 876 };
    const moved = movedClearOfBadge({ ...tall, x: 519, y: 286 }, 282, narrow);
    expect(moved).toEqual({ y: 241 });
    expect(apart(519, moved?.y ?? 0, narrow, tall)).toBe(true);
  });

  test("with nowhere to go, it stays where it is", () => {
    const huge = { ...CARD, height: 700 };
    expect(movedClearOfBadge({ ...huge, x: 0, y: 0 }, 40, { ...BADGE, left: 0, right: 900 })).toBe(
      null,
    );
  });
});
