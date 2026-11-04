import { describe, expect, test } from "vitest";
import { mapsOnto, waitsForUser } from "../../src/core/edits/applies";

describe("An edit the User asked for (#880)", () => {
  test("new text maps onto the selection when at least half of it is found there", () => {
    expect(mapsOnto(50, 100)).toBe(true);
    expect(mapsOnto(49, 100)).toBe(false);
    expect(mapsOnto(0, 0)).toBe(true);
  });

  // protects=an edit waits for the User when more than half of the selection would go, however much of its new text is found there, as a reply that keeps one sentence of five is (#2356); a translation never does; fails_when=a cut of more than half applies at once, or one of half waits; no_claim=none beyond protects.
  test("waits for the User when more than half of the selection would go", () => {
    const edit = { action: "instruction" as const, selected: 100 };
    expect(waitsForUser({ ...edit, removed: 50, added: 0 })).toBe(false);
    expect(waitsForUser({ ...edit, removed: 51, added: 0 })).toBe(true);
    expect(waitsForUser({ ...edit, removed: 90, added: 40 })).toBe(false);
    expect(waitsForUser({ ...edit, removed: 100, added: 20 })).toBe(true);
    expect(waitsForUser({ ...edit, action: "translate", removed: 100, added: 0 })).toBe(false);
    expect(waitsForUser({ ...edit, selected: 0, removed: 0, added: 0 })).toBe(false);
  });
});
