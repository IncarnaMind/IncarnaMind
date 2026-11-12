import { describe, expect, test } from "vitest";
import type { ObjectRef } from "../../src/renderer/src/objects";
import {
  choose,
  clear,
  extend,
  keepOnly,
  NOTHING_SELECTED,
  refKey,
  refOfKey,
  type SelectionState,
  selectAll,
  toggle,
} from "../../src/renderer/src/selectionModel";

/*
 * One way to select (docs/agents/interaction.md, rule 6): what each gesture
 * does to the selection, which is the same in the sidebar and the Library.
 */

const doc = (id: string): ObjectRef => ({ kind: "document", id });
const mind = (id: string): ObjectRef => ({ kind: "mind", id });
const order = ["a", "b", "c", "d", "e"].map(doc);
const ids = (state: SelectionState) => state.items.map((each) => each.id);

describe("a click", () => {
  test("selects just that one, and makes it the anchor", () => {
    const state = choose(
      toggle(choose(NOTHING_SELECTED, "library", doc("a")), "library", doc("c")),
      "library",
      doc("b"),
    );
    expect(ids(state)).toEqual(["b"]);
    expect(state.anchor).toEqual(doc("b"));
    expect(state.surface).toBe("library");
  });

  test("on the one already alone leaves the state as it was", () => {
    const state = choose(NOTHING_SELECTED, "sidebar", doc("a"));
    expect(choose(state, "sidebar", doc("a"))).toBe(state);
  });
});

describe("a click on the one left selected after a ⌘-click", () => {
  test("makes it the anchor again", () => {
    const left = toggle(
      toggle(choose(NOTHING_SELECTED, "library", doc("a")), "library", doc("c")),
      "library",
      doc("a"),
    );
    expect(ids(left)).toEqual(["c"]);
    expect(left.anchor).toEqual(doc("a"));
    expect(choose(left, "library", doc("c")).anchor).toEqual(doc("c"));
  });
});

describe("⌘-click or Ctrl-click", () => {
  test("adds one, then removes it", () => {
    const one = choose(NOTHING_SELECTED, "library", doc("a"));
    const two = toggle(one, "library", doc("c"));
    expect(ids(two)).toEqual(["a", "c"]);
    expect(two.anchor).toEqual(doc("c"));
    const back = toggle(two, "library", doc("a"));
    expect(ids(back)).toEqual(["c"]);
  });

  test("removing the last one leaves nothing", () => {
    const one = choose(NOTHING_SELECTED, "library", doc("a"));
    expect(toggle(one, "library", doc("a"))).toBe(NOTHING_SELECTED);
  });

  test("starts from nothing on the other surface", () => {
    const sidebar = toggle(choose(NOTHING_SELECTED, "sidebar", doc("a")), "sidebar", doc("b"));
    const library = toggle(sidebar, "library", doc("c"));
    expect(ids(library)).toEqual(["c"]);
    expect(library.surface).toBe("library");
  });

  test("mixes kinds in the sidebar", () => {
    const state = toggle(choose(NOTHING_SELECTED, "sidebar", mind("m")), "sidebar", doc("a"));
    expect(state.items).toEqual([mind("m"), doc("a")]);
    expect(state.keys.has(refKey(mind("m")))).toBe(true);
  });
});

describe("Shift-click or Shift+arrow", () => {
  const from = choose(NOTHING_SELECTED, "library", doc("b"));

  test("selects everything from the anchor to it, either way", () => {
    expect(ids(extend(from, "library", doc("d"), order))).toEqual(["b", "c", "d"]);
    expect(ids(extend(from, "library", doc("a"), order))).toEqual(["a", "b"]);
  });

  test("keeps the anchor, so the range shrinks again", () => {
    const wide = extend(from, "library", doc("e"), order);
    const narrow = extend(wide, "library", doc("c"), order);
    expect(ids(narrow)).toEqual(["b", "c"]);
    expect(narrow.anchor).toEqual(doc("b"));
  });

  test("replaces what ⌘-click added outside the range", () => {
    const state = toggle(from, "library", doc("e"));
    expect(ids(extend(state, "library", doc("c"), order))).toEqual(["c", "d", "e"]);
  });

  test("without an anchor, or with one out of view, is a click", () => {
    expect(ids(extend(NOTHING_SELECTED, "library", doc("c"), order))).toEqual(["c"]);
    const gone = choose(NOTHING_SELECTED, "library", doc("zzz"));
    expect(ids(extend(gone, "library", doc("c"), order))).toEqual(["c"]);
  });

  test("from the other surface's anchor is a click", () => {
    const sidebar = choose(NOTHING_SELECTED, "sidebar", doc("a"));
    expect(ids(extend(sidebar, "library", doc("c"), order))).toEqual(["c"]);
  });
});

describe("⌘A", () => {
  test("selects everything in view, in its order", () => {
    const state = selectAll(NOTHING_SELECTED, "sidebar", order);
    expect(ids(state)).toEqual(["a", "b", "c", "d", "e"]);
    expect(state.surface).toBe("sidebar");
  });

  test("keeps an anchor that is in view, else starts at the first", () => {
    const some = choose(NOTHING_SELECTED, "library", doc("c"));
    expect(selectAll(some, "library", order).anchor).toEqual(doc("c"));
    expect(selectAll(NOTHING_SELECTED, "library", order).anchor).toEqual(doc("a"));
  });

  test("with nothing in view selects nothing", () => {
    expect(selectAll(NOTHING_SELECTED, "library", [])).toBe(NOTHING_SELECTED);
  });
});

describe("Esc", () => {
  const some = toggle(choose(NOTHING_SELECTED, "library", doc("a")), "library", doc("b"));

  test("clears the selection", () => {
    expect(clear(some)).toBe(NOTHING_SELECTED);
    expect(clear(some, "library")).toBe(NOTHING_SELECTED);
  });

  test("on the other surface leaves this one's alone", () => {
    expect(clear(some, "sidebar")).toBe(some);
  });
});

describe("a deleted item", () => {
  const some = extend(choose(NOTHING_SELECTED, "library", doc("a")), "library", doc("c"), order);

  test("leaves the selection, and a lost anchor with it", () => {
    const left = keepOnly(some, (ref) => ref.id !== "a");
    expect(ids(left)).toEqual(["b", "c"]);
    expect(left.anchor).toBeNull();
  });

  test("changes nothing while everything still exists", () => {
    expect(keepOnly(some, () => true)).toBe(some);
  });

  test("leaves nothing selected when all are gone", () => {
    expect(keepOnly(some, () => false)).toBe(NOTHING_SELECTED);
  });
});

describe("what the User picked", () => {
  const current = choose(NOTHING_SELECTED, "sidebar", mind("shown"));

  // protects=⌘K counts as a selection only rows the User picked, not the row a click opened or the sidebar lit for what is shown (#1741); fails_when=a click, or following what is shown, counts as picked; no_claim=what each gesture selects.
  test("a click, or the row lit for what is shown, is only the current row", () => {
    expect(current.picked).toBe(false);
    expect(NOTHING_SELECTED.picked).toBe(false);
  });

  test("⌘-click, Shift-click and ⌘A pick, even just the current row", () => {
    expect(toggle(current, "sidebar", mind("other")).picked).toBe(true);
    expect(extend(current, "sidebar", mind("shown"), [mind("shown")]).picked).toBe(true);
    expect(ids(extend(current, "sidebar", mind("shown"), [mind("shown")]))).toEqual(["shown"]);
    expect(selectAll(NOTHING_SELECTED, "library", order).picked).toBe(true);
  });

  test("stays picked as deleted ones leave, and ends with a click or Esc", () => {
    const picked = toggle(toggle(NOTHING_SELECTED, "library", doc("a")), "library", doc("b"));
    expect(keepOnly(picked, (ref) => ref.id !== "a").picked).toBe(true);
    expect(choose(picked, "library", doc("a")).picked).toBe(false);
    const one = extend(NOTHING_SELECTED, "library", doc("a"), order);
    expect(choose(one, "library", doc("a")).picked).toBe(false);
    expect(clear(picked).picked).toBe(false);
  });
});

describe("keys", () => {
  test("round-trip through their text, ids with colons included", () => {
    expect(refOfKey(refKey(doc("a:b")))).toEqual(doc("a:b"));
    expect(refOfKey("nothing")).toBeNull();
  });
});
