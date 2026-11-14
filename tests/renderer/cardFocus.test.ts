import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  enterCard,
  goingElsewhere,
  isSpaceKey,
  keepFocusInside,
  returnAtEnds,
  type TabPress,
  wrappedFocus,
} from "../../src/renderer/src/editor/cardFocus";

const page = parseHTML(
  '<!doctype html><html><body><div id="card"><button id="first">1</button><button id="second">2</button><button id="last">3</button></div><button id="outside">out</button></body></html>',
);
const element = (id: string) => page.document.getElementById(id) as unknown as HTMLElement;
const card = element("card");
const first = element("first");
const second = element("second");
const last = element("last");
const outside = element("outside");
let active: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("document", page.document);
  vi.stubGlobal("Node", page.Node);
  vi.stubGlobal("HTMLElement", page.HTMLElement);
  Object.defineProperty(page.document, "activeElement", {
    configurable: true,
    get: () => active,
  });
  for (const each of [first, second, last]) each.checkVisibility = () => true;
  active = first;
  vi.spyOn(first, "focus");
  vi.spyOn(second, "focus");
  vi.spyOn(last, "focus");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function press(over: Partial<TabPress> = {}) {
  let prevented = false;
  const event: TabPress = {
    key: "Tab",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: second,
    preventDefault: () => {
      prevented = true;
    },
    ...over,
  };
  return { event, prevented: () => prevented };
}

describe("Tab inside a sentence's check card (#1762)", () => {
  test("wraps from the last action to the first, and back", () => {
    active = last;
    const forward = press({ target: last });
    keepFocusInside(forward.event, card);
    expect(forward.prevented()).toBe(true);
    expect(first.focus).toHaveBeenCalledTimes(1);

    active = first;
    const backward = press({ target: first, shiftKey: true });
    keepFocusInside(backward.event, card);
    expect(backward.prevented()).toBe(true);
    expect(last.focus).toHaveBeenCalledTimes(1);
  });

  test("a Tab in the middle, and one on a card with no action, is the browser's", () => {
    const middle = press();
    keepFocusInside(middle.event, card);
    expect(middle.prevented()).toBe(false);

    active = last;
    for (const each of [first, second, last]) each.checkVisibility = () => false;
    const none = press({ target: last });
    keepFocusInside(none.event, card);
    expect(none.prevented()).toBe(false);
  });

  test("a modified Tab stays the keymap's, for switching tabs", () => {
    active = last;
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const modified = press({ target: last, ...over });
      keepFocusInside(modified.event, card);
      expect(modified.prevented()).toBe(false);
    }
    expect(first.focus).not.toHaveBeenCalled();
  });

  test("a key press outside the card is left alone", () => {
    active = last;
    const elsewhere = press({ target: outside });
    keepFocusInside(elsewhere.event, card);
    expect(elsewhere.prevented()).toBe(false);
    expect(first.focus).not.toHaveBeenCalled();
  });
});

describe("the wrap decision (#1762)", () => {
  test("moves on through the actions in the middle", () => {
    expect(wrappedFocus(0, 3, false)).toBeNull();
    expect(wrappedFocus(1, 3, false)).toBeNull();
    expect(wrappedFocus(1, 3, true)).toBeNull();
    expect(wrappedFocus(2, 3, true)).toBeNull();
  });

  test("wraps from the last action to the first, and back", () => {
    expect(wrappedFocus(2, 3, false)).toBe(0);
    expect(wrappedFocus(0, 3, true)).toBe(2);
  });

  test("a card with one action keeps it", () => {
    expect(wrappedFocus(0, 1, false)).toBe(0);
    expect(wrappedFocus(0, 1, true)).toBe(0);
  });

  test("a card with no action moves nowhere", () => {
    expect(wrappedFocus(-1, 0, false)).toBeNull();
    expect(wrappedFocus(-1, 0, true)).toBeNull();
  });

  test("the focus on the card itself goes to its first or last action", () => {
    expect(wrappedFocus(-1, 3, false)).toBe(0);
    expect(wrappedFocus(-1, 3, true)).toBe(2);
  });
});

describe("a card shown on keyboard focus (#3102)", () => {
  const control = { focus: vi.fn() };
  beforeEach(() => control.focus.mockClear());

  test("Tab from the last control, and Shift+Tab from the first, go back to the control", () => {
    const forward = press({ target: last });
    returnAtEnds(forward.event, card, control);
    expect(forward.prevented()).toBe(true);
    const backward = press({ target: first, shiftKey: true });
    returnAtEnds(backward.event, card, control);
    expect(backward.prevented()).toBe(true);
    expect(control.focus).toHaveBeenCalledTimes(2);
  });

  test("a Tab between the controls is the browser's, and none wraps", () => {
    const middle = press({ target: second });
    returnAtEnds(middle.event, card, control);
    const firstBack = press({ target: first });
    returnAtEnds(firstBack.event, card, control);
    const lastForward = press({ target: last, shiftKey: true });
    returnAtEnds(lastForward.event, card, control);
    expect(middle.prevented() || firstBack.prevented() || lastForward.prevented()).toBe(false);
    expect(control.focus).not.toHaveBeenCalled();
  });

  test("a modified Tab, another key and a card with no control are left alone", () => {
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { key: "Enter" }]) {
      const other = press({ target: last, ...over });
      returnAtEnds(other.event, card, control);
      expect(other.prevented()).toBe(false);
    }
    const none = press({ target: last });
    returnAtEnds(none.event, card, null);
    expect(none.prevented()).toBe(false);
    expect(control.focus).not.toHaveBeenCalled();
  });

  test("Space goes into the card's first control, and says whether it landed", () => {
    first.focus = vi.fn(() => {
      active = first;
    });
    active = outside;
    expect(enterCard(card)).toBe(true);
    first.focus = vi.fn();
    active = outside;
    expect(enterCard(card)).toBe(false);
    expect(enterCard(null)).toBe(false);
  });

  test("Space is the key into a card only alone and not while an input method composes", () => {
    const key = {
      key: " ",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      keyCode: 32,
    };
    expect(isSpaceKey(key)).toBe(true);
    expect(isSpaceKey({ ...key, nativeEvent: { isComposing: false } })).toBe(true);
    expect(isSpaceKey({ ...key, nativeEvent: { isComposing: true } })).toBe(false);
    expect(isSpaceKey({ ...key, keyCode: 229 })).toBe(false);
    for (const over of [
      { shiftKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
    ]) {
      expect(isSpaceKey({ ...key, ...over })).toBe(false);
    }
    expect(isSpaceKey({ ...key, key: "Enter" })).toBe(false);
  });

  test("the focus going to the card or back to its control stays; anywhere else goes", () => {
    expect(goingElsewhere(second, card, outside)).toBe(false);
    expect(goingElsewhere(outside, card, outside)).toBe(false);
    expect(goingElsewhere(outside, card, null)).toBe(true);
    expect(goingElsewhere(null, card, outside)).toBe(false);
  });
});
