import { afterEach, describe, expect, test } from "vitest";
import { placeHere, showPlace } from "../../src/renderer/src/commands/here";

interface Row {
  contains(node: unknown): boolean;
}

/** A ⋯ button standing in for the DOM's: in `row` if given, on screen unless `hidden`. */
function button(object: string, row?: Row, hidden = false): HTMLElement {
  return {
    dataset: { objectMenu: object },
    isConnected: true,
    getClientRects: () => (hidden ? [] : [{}]),
    closest: () => row ?? null,
  } as unknown as HTMLElement;
}

const rowAround = (...inside: object[]): Row => ({
  contains: (node) => inside.includes(node as object),
});

const mind = { kind: "mind", id: "m1" } as const;
const gone: Array<() => void> = [];
const show = (element: HTMLElement, name: string) => {
  gone.push(showPlace(element, () => ({ "mind.rename": () => name })));
};

afterEach(() => {
  for (const stop of gone.splice(0)) stop();
});

const renamedIn = (focus: Element | null) => placeHere(mind, focus)?.["mind.rename"]?.();

describe("the place ⌘K acts through", () => {
  test("the row the focus was in, whichever was mounted last", () => {
    const sidebarFocus = {} as Element;
    const sidebar = rowAround(sidebarFocus);
    show(button("mind:m1", sidebar), "sidebar");
    show(button("mind:m1"), "page");
    show(button("mind:m1", rowAround()), "other row");
    expect(renamedIn(sidebarFocus)).toBe("sidebar");
  });

  test("with the focus in the page, its page rather than a row remounted after it", () => {
    show(button("mind:m1"), "page");
    show(button("mind:m1", rowAround()), "sidebar row, remounted");
    expect(renamedIn({} as Element)).toBe("page");
    expect(renamedIn(null)).toBe("page");
  });

  test("with no page, the row mounted last that is on screen", () => {
    show(button("mind:m1", rowAround()), "first");
    show(button("mind:m1", rowAround()), "second");
    show(button("mind:m1", rowAround(), true), "scrolled out of sight");
    expect(renamedIn(null)).toBe("second");
  });

  test("another object's places, and places that are gone, are not used", () => {
    show(button("mind:m2"), "other Mind");
    showPlace(button("mind:m1"), () => ({ "mind.rename": () => "page" }))();
    expect(renamedIn(null)).toBeUndefined();
  });
});
