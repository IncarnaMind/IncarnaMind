import { beforeAll, beforeEach, expect, test } from "vitest";
import {
  giveFocusBack,
  type Remembered,
  rememberFocus,
} from "../../src/renderer/src/components/useFocusReturn";

/** A node of the page, as little of one as giving the focus back reads. */
class FakeElement {
  isConnected = true;
  focused = 0;
  holds = new Set<unknown>();
  hidden = new Set<string>();

  contains(node: unknown): boolean {
    return this.holds.has(node);
  }

  hasAttribute(name: string): boolean {
    return this.hidden.has(name);
  }

  focus(): void {
    this.focused += 1;
    page.activeElement = this;
  }
}

class FakeField extends FakeElement {
  selectionStart: number | null = 2;
  selectionEnd: number | null = 5;
  readonly ranges: [number, number][] = [];

  setSelectionRange(start: number, end: number): void {
    this.ranges.push([start, end]);
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

const page = { activeElement: null as unknown, body: new FakeElement() };

/** The node a fake stands in for, which it isn't. */
const node = <T>(fake: FakeElement): T => fake as unknown as T;

/** What an overlay took the focus from, as the helper remembers it. */
const asRemembered = (
  element: FakeElement,
  caret: readonly [number, number] | null = null,
): Remembered => ({ element: node<HTMLElement>(element), caret });

beforeAll(() => {
  Object.assign(globalThis, {
    document: page,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeField,
    HTMLTextAreaElement: FakeField,
  });
});

beforeEach(() => {
  page.activeElement = page.body;
});

test("focus goes back where it was, with the caret it had", () => {
  const field = new FakeField();
  page.activeElement = field;
  const where = rememberFocus();
  expect(where?.element).toBe(field);
  expect(where?.caret).toEqual([2, 5]);

  // Chromium gave the focus back but left the caret at the start, and the keys go nowhere.
  field.selectionStart = 0;
  field.selectionEnd = 0;
  giveFocusBack(where, null);
  expect(page.activeElement).toBe(field);
  expect(field.ranges).toEqual([[2, 5]]);
});

test("a place something else has given the focus since keeps it", () => {
  const field = new FakeField();
  const row = new FakeElement();
  const fromField = asRemembered(field, [2, 5]);

  page.activeElement = row;
  giveFocusBack(fromField, null);
  expect(row.focused).toBe(0);
  expect(page.activeElement).toBe(row);
  expect(field.ranges).toEqual([]);
});

test("a focus still inside the closing overlay goes back where it was", () => {
  const field = new FakeField();
  const overlay = new FakeElement();
  const item = new FakeElement();
  overlay.holds.add(item);
  page.activeElement = item;
  giveFocusBack(asRemembered(field, [2, 5]), node<Element>(overlay));
  expect(page.activeElement).toBe(field);
});

test("a menu that opened with nothing to go back to goes to its button", () => {
  const button = new FakeElement();
  giveFocusBack(null, null, node<HTMLElement>(button));
  expect(page.activeElement).toBe(button);
});

test("an aria-hidden element is never given the focus", () => {
  const button = new FakeElement();
  button.hidden.add("aria-hidden");
  giveFocusBack(null, null, node<HTMLElement>(button));
  expect(button.focused).toBe(0);
  expect(page.activeElement).toBe(page.body);

  const field = new FakeField();
  field.hidden.add("aria-hidden");
  const fallback = new FakeElement();
  giveFocusBack(asRemembered(field, [2, 5]), null, node<HTMLElement>(fallback));
  expect(page.activeElement).toBe(fallback);
});

test("an element that has gone is not given the focus", () => {
  const field = new FakeField();
  field.isConnected = false;
  const fallback = new FakeElement();
  giveFocusBack(asRemembered(field, [2, 5]), null, node<HTMLElement>(fallback));
  expect(page.activeElement).toBe(fallback);
  expect(field.ranges).toEqual([]);
});

test("the page itself is not a place to give the focus", () => {
  const fallback = new FakeElement();
  giveFocusBack(asRemembered(page.body), null, node<HTMLElement>(fallback));
  expect(page.activeElement).toBe(fallback);
});

test("a field with no selection takes the focus without one", () => {
  const field = new FakeField();
  field.selectionStart = null;
  field.selectionEnd = null;
  page.activeElement = field;
  expect(rememberFocus()?.caret).toBeNull();

  page.activeElement = page.body;
  giveFocusBack(asRemembered(field), null);
  expect(page.activeElement).toBe(field);
  expect(field.ranges).toEqual([]);
});

test("something that takes no caret is only given the focus", () => {
  const row = new FakeElement();
  page.activeElement = row;
  expect(rememberFocus()?.caret).toBeNull();
  page.activeElement = page.body;
  giveFocusBack(asRemembered(row), null);
  expect(page.activeElement).toBe(row);
  expect(row.focused).toBe(1);
});

test("what has the focus is nothing to remember when it isn't an element of the page", () => {
  page.activeElement = { name: "not an element" };
  expect(rememberFocus()).toBeNull();
});
