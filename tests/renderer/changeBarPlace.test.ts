import { describe, expect, test } from "vitest";
import {
  BESIDE_ROOM_PX,
  type ChangeBarBox,
  changeBarPlace,
} from "../../src/renderer/src/editor/changeBarPlace";

const page: ChangeBarBox = { left: 0, top: 0, right: 1100, bottom: 800 };
const line = 26;
const card = { width: 170, height: 24 };
/** One line of 16px text: its ink's box, 19px tall, inside a 26px line box. */
const oneLine = (right: number): ChangeBarBox => ({ left: 300, top: 200, right, bottom: 219 });
/** The line under it, where its ink starts. */
const nextLine: ChangeBarBox = { left: 300, top: 229.5, right: 700, bottom: 248.5 };
/** What the card draws at a place, for comparing with a change's box. */
const cardBox = (place: { x: number; y: number; maxWidth: number }, height = card.height) => ({
  left: place.x,
  top: place.y,
  right: place.x + Math.min(card.width, place.maxWidth),
  bottom: place.y + height,
});

const overlap = (a: ChangeBarBox, b: ChangeBarBox) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe("Where a change's card goes", () => {
  test("beside the change when about 300px are free past the text on its lines", () => {
    const change = oneLine(700);
    const place = changeBarPlace(change, change.right, page, card, line);
    expect(place.kind).toBe("beside");
    expect(place.x).toBeGreaterThanOrEqual(change.right);
    expect(overlap(cardBox(place), change)).toBe(false);
    expect(overlap(cardBox(place), nextLine)).toBe(false);
    expect(cardBox(place).right).toBeLessThanOrEqual(page.right);
  });

  test("docked when less than about 300px are free, or a change partway along a line leaves more text after it", () => {
    const change = oneLine(page.right - BESIDE_ROOM_PX + 100);
    const place = changeBarPlace(change, change.right, page, card, line);
    expect(place.kind).toBe("dock");
    expect(place.y + card.height).toBeLessThanOrEqual(page.bottom);
    expect(place.x).toBeGreaterThanOrEqual(page.left);
    expect(cardBox(place).right).toBeLessThanOrEqual(page.right);
    const words = oneLine(500);
    expect(changeBarPlace(words, 900, page, card, line).kind).toBe("dock");
  });

  test("docked when the card, with its why line, is taller than the change's lines", () => {
    const change = oneLine(700);
    const tall = { width: 260, height: 44 };
    expect(changeBarPlace(change, change.right, page, tall, line).kind).toBe("dock");
    const threeLines = { ...change, bottom: 200 + 71 };
    expect(changeBarPlace(threeLines, change.right, page, tall, line).kind).toBe("beside");
  });

  test("docked when the change is too near the page's foot for the card beside it", () => {
    const short: ChangeBarBox = { left: 0, top: 0, right: 1100, bottom: 220 };
    expect(changeBarPlace(oneLine(700), 700, short, card, line).kind).toBe("dock");
  });

  test("dock and beside swap at about 300px of room: 299, 300 and 301", () => {
    const change = oneLine(700);
    const withRoom = (room: number) => ({ ...change, right: page.right - 8 - room });
    expect(changeBarPlace(withRoom(299), withRoom(299).right, page, card, line).kind).toBe("dock");
    expect(changeBarPlace(withRoom(300), withRoom(300).right, page, card, line).kind).toBe(
      "beside",
    );
    expect(changeBarPlace(withRoom(301), withRoom(301).right, page, card, line).kind).toBe(
      "beside",
    );
  });

  test("docked clear of the check badge and the Ask pill at the page's foot", () => {
    const change = oneLine(page.right - 100);
    const docked = changeBarPlace(change, change.right, page, card, line, {
      right: 900,
      bottom: 700,
    });
    expect(docked.kind).toBe("dock");
    expect(cardBox(docked).right).toBeLessThanOrEqual(900);
    expect(cardBox(docked).bottom).toBeLessThanOrEqual(700);
  });

  test("never at the window's corner or over the page's edge, however narrow the page", () => {
    const narrow: ChangeBarBox = { left: 256, top: 44, right: 656, bottom: 588 };
    const place = changeBarPlace({ ...oneLine(600), left: 300 }, 600, narrow, card, line);
    expect(place.kind).toBe("dock");
    expect(place.x).toBeGreaterThanOrEqual(narrow.left);
    expect(cardBox(place).right).toBeLessThanOrEqual(narrow.right);
    expect(place.y).toBeGreaterThanOrEqual(narrow.top);
  });
});
