import { beforeAll, describe, expect, test } from "vitest";
import {
  DEFAULT_ASSISTANT,
  type LayoutGroup,
  type TabItem,
  type WindowLayout,
} from "../../src/core/api";

/*
 * The assistant yields to a Citation's page (#2270): whether a Note and a page keep their even
 * split beside it, and the shares that keep the Note readable when they cannot.
 */

type Yields = typeof import("../../src/renderer/src/assistantYields");
let yields: Yields;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: new Proxy({}, { get: () => () => () => undefined }),
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    innerWidth: 1440,
  };
  yields = await import("../../src/renderer/src/assistantYields");
});

const group = (id: string, item: TabItem, width: number): LayoutGroup => ({
  id,
  tabs: [{ id: `${id}-tab`, item, preview: false, pinned: false, place: null, opened: 0 }],
  activeTabId: `${id}-tab`,
  width,
});

const note = (width = 1) => group("note", { kind: "mind", mindId: "m" }, width);
const page = (width = 1) => group("page", { kind: "document", documentId: "d" }, width);
const library = (width = 1) => group("library", { kind: "library" }, width);

const layoutOf = (...groups: LayoutGroup[]): WindowLayout => ({
  groups,
  focusedGroupId: (groups[0] as LayoutGroup).id,
  reopenable: 0,
  conversationId: null,
  assistant: DEFAULT_ASSISTANT,
});

const pairOf = (layout: WindowLayout) => {
  const pair = yields.notePagePair(layout);
  if (!pair) throw new Error("The layout shows no Note and page side by side.");
  return pair;
};

describe("the Note and the page beside it", () => {
  test("are found either way round, and never when something else sits between them", () => {
    expect(yields.notePagePair(layoutOf(note(), page()))).toEqual({ noteIndex: 0, pageIndex: 1 });
    expect(yields.notePagePair(layoutOf(page(), note()))).toEqual({ noteIndex: 1, pageIndex: 0 });
    expect(yields.notePagePair(layoutOf(note(), library()))).toBeNull();
    expect(yields.notePagePair(layoutOf(note(), library(), page()))).toBeNull();
    expect(yields.notePagePair(null)).toBeNull();
  });

  test("share the card evenly after a page opens, its dividers taken out", () => {
    const layout = layoutOf(note(0.5), page(0.5));
    const widths = yields.splitWidths(layout, pairOf(layout), 860);
    expect(widths.room).toBe(859);
    expect(widths.note).toBeCloseTo(429.5, 1);
    expect(widths.page).toBeCloseTo(429.5, 1);
    expect(yields.evenSplit(widths)).toBe(true);
  });

  test("a share the User dragged is not the even split", () => {
    const layout = layoutOf(note(0.3), page(0.7));
    expect(yields.evenSplit(yields.splitWidths(layout, pairOf(layout), 860))).toBe(false);
  });
});

describe("when the assistant must yield", () => {
  test("at a 1,440px window the open assistant leaves the Note 430px, and folding it 568px", () => {
    const layout = layoutOf(note(0.5), page(0.5));
    const open = yields.splitWidths(layout, pairOf(layout), 860);
    expect(open.note).toBeCloseTo(429.5, 1);
    expect(open.note).toBeLessThan(480);
    expect(yields.noteLacksRoom(open)).toBe(true);
    const folded = yields.splitWidths(layout, pairOf(layout), 1136);
    expect(folded.note).toBeCloseTo(567.5, 1);
    expect(yields.noteLacksRoom(folded)).toBe(false);
  });

  test("at a 1,600px window the open assistant leaves the Note 510px: nothing folds", () => {
    const layout = layoutOf(note(0.5), page(0.5));
    const widths = yields.splitWidths(layout, pairOf(layout), 1020);
    expect(widths.note).toBeCloseTo(509.5, 1);
    expect(widths.note).toBeGreaterThanOrEqual(480);
    expect(yields.noteLacksRoom(widths)).toBe(false);
  });

  test("folding the narrowest side dock leaves a card showing two groups an even split it can afford", () => {
    // A card showing two groups is at least 736px; the narrowest side dock is 280px, folded to its 44px rail.
    const folded = 736 + (280 - 44);
    expect((folded - 1) / 2).toBeGreaterThanOrEqual(480);
    expect(yields.NOTE_MIN).toBe(480);
  });
});

const sharesOf = (widths: number[] | null, room: number): [number, number] => {
  if (!widths) throw new Error("The pair kept its even split.");
  return [(widths[0] as number) * room, (widths[1] as number) * room];
};

describe("the page takes the narrower share instead", () => {
  test("gives the Note 480px and the page the rest, when the even split is too narrow for the Note", () => {
    // A 1,520px window with the assistant open.
    const layout = layoutOf(note(0.5), page(0.5));
    const [noteWidth, pageWidth] = sharesOf(
      yields.pageYieldsWidths(layout, pairOf(layout), 940),
      939,
    );
    expect(noteWidth).toBeCloseTo(480, 0);
    expect(pageWidth).toBeCloseTo(459, 0);
  });

  test("never narrows the page below the 452px its toolbar holds; the Note gets what is left", () => {
    // A 1,500px window with the assistant open: the even split is 459.5px each.
    const layout = layoutOf(note(0.5), page(0.5));
    const [noteWidth, pageWidth] = sharesOf(
      yields.pageYieldsWidths(layout, pairOf(layout), 920),
      919,
    );
    expect(pageWidth).toBeCloseTo(452, 0);
    expect(noteWidth).toBeCloseTo(467, 0);
    expect(yields.PAGE_MIN).toBe(452);
  });

  test("keeps the even split where the page's toolbar leaves the Note no more (a 1,440px window)", () => {
    const layout = layoutOf(note(0.5), page(0.5));
    expect(yields.pageYieldsWidths(layout, pairOf(layout), 860)).toBeNull();
  });

  test("keeps a split the User dragged, even a narrow Note", () => {
    const layout = layoutOf(note(0.3), page(0.7));
    expect(yields.pageYieldsWidths(layout, pairOf(layout), 860)).toBeNull();
  });

  test("does nothing where the even split is already wide enough", () => {
    const layout = layoutOf(note(0.5), page(0.5));
    expect(yields.pageYieldsWidths(layout, pairOf(layout), 1020)).toBeNull();
  });

  test("leaves the pair alone where even the page's minimum would not fit", () => {
    // Three groups: the Note and the page share half the card, too little for 480px and a 452px page.
    const layout = layoutOf(note(0.25), page(0.25), library(0.5));
    expect(yields.pageYieldsWidths(layout, pairOf(layout), 800)).toBeNull();
  });
});
