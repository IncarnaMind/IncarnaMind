import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Document, RunEstimate } from "../../src/core/api";
import {
  ASK_ABOVE_CALLS,
  ASK_ABOVE_COST,
  ASK_ABOVE_DOCUMENTS,
  asksFirst,
  TICKED_AT_START_MAX,
} from "../../src/renderer/src/compareScope";

type Comparisons = typeof import("../../src/renderer/src/comparisons");
type Selection = typeof import("../../src/renderer/src/selection");
type Store = typeof import("../../src/renderer/src/store");

let comparisons: Comparisons;
let selection: Selection;
let store: Store;

beforeAll(async () => {
  // The store reaches the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
  };
  comparisons = await import("../../src/renderer/src/comparisons");
  selection = await import("../../src/renderer/src/selection");
  store = await import("../../src/renderer/src/store");
});

const documentsOf = (count: number): Document[] =>
  Array.from({ length: count }, (_, index) => ({ id: `doc-${index}` }) as Document);

function aLibraryOf(count: number) {
  store.useAppStore.setState({
    documents: documentsOf(count),
    library: { groups: [], assignments: [] } as never,
    settings: null,
    minds: [{ id: "mind" } as never],
  });
}

const checkedOf = (mindId: string) => comparisons.useComparisons.getState().sheets[mindId]?.checked;
const sheetOf = (mindId: string) => comparisons.useComparisons.getState().sheets[mindId];

beforeEach(() => {
  comparisons.useComparisons.setState({ sheets: {}, problems: {} });
  selection.useSelection.getState().clear();
});

describe("Compare Documents starts with a safe set ticked", () => {
  test("a few Documents come ticked, so a small Library compares at once", async () => {
    aLibraryOf(TICKED_AT_START_MAX);
    await comparisons.startCompareDocuments("mind", null);
    expect(sheetOf("mind")?.source).toBe("all");
    expect(checkedOf("mind")).toHaveLength(TICKED_AT_START_MAX);
  });

  test("a Library of 86 Documents starts with none ticked", async () => {
    aLibraryOf(86);
    await comparisons.startCompareDocuments("mind", null);
    expect(checkedOf("mind")).toEqual([]);
  });

  test("the Documents selected in the Library are the scope and all ticked, however many", async () => {
    aLibraryOf(86);
    for (const id of ["doc-3", "doc-7", "doc-40", "doc-41", "doc-42", "doc-43", "doc-44"]) {
      selection.useSelection.getState().toggle("library", { kind: "document", id });
    }
    await comparisons.startCompareDocuments("mind", null);
    expect(sheetOf("mind")?.source).toBe("selected");
    expect(checkedOf("mind")).toHaveLength(7);
  });

  test("a selection in the sidebar, or of Minds, is not the Library's", async () => {
    aLibraryOf(86);
    selection.useSelection.getState().toggle("sidebar", { kind: "document", id: "doc-3" });
    await comparisons.startCompareDocuments("mind", null);
    expect(sheetOf("mind")?.source).toBe("all");
    expect(checkedOf("mind")).toEqual([]);
  });

  test("choosing All Documents ticks none of a large Library, and the Library's selection ticks all of it", async () => {
    aLibraryOf(86);
    await comparisons.startCompareDocuments("mind", null);
    comparisons.updateCompareSheet("mind", { checked: ["doc-1", "doc-2"] });

    comparisons.chooseCompareSource("mind", "all");
    expect(checkedOf("mind")).toEqual([]);

    selection.useSelection.getState().toggle("library", { kind: "document", id: "doc-9" });
    selection.useSelection.getState().toggle("library", { kind: "document", id: "doc-10" });
    comparisons.chooseCompareSource("mind", "selected");
    expect(sheetOf("mind")?.source).toBe("selected");
    expect(checkedOf("mind")).toEqual(["doc-9", "doc-10"]);
  });
});

describe("A large run asks first", () => {
  const perToken = (
    amount: number | null,
    currency: "USD" | "CNY" = "USD",
    calls = 3,
  ): RunEstimate => ({
    billing: "per-token",
    calls,
    tokens: 1_000,
    cost: amount === null ? null : { amount, currency },
    spentTowardCap: null,
    setAsideTowardCap: null,
    cap: null,
  });

  test("more than about 20 Documents asks, on any model, and fewer don't", () => {
    expect(asksFirst(ASK_ABOVE_DOCUMENTS, null)).toBe(false);
    expect(asksFirst(ASK_ABOVE_DOCUMENTS + 1, null)).toBe(true);
    expect(asksFirst(ASK_ABOVE_DOCUMENTS + 1, { billing: "plan" })).toBe(true);
    expect(asksFirst(ASK_ABOVE_DOCUMENTS + 1, { billing: "free" })).toBe(true);
  });

  test("a cost above the limit asks, in either currency, and one below it doesn't", () => {
    expect(asksFirst(3, perToken(1.61))).toBe(true);
    expect(asksFirst(3, perToken(ASK_ABOVE_COST.USD))).toBe(false);
    expect(asksFirst(3, perToken(ASK_ABOVE_COST.USD + 0.01))).toBe(true);
    expect(asksFirst(3, perToken(ASK_ABOVE_COST.CNY, "CNY"))).toBe(false);
    expect(asksFirst(3, perToken(ASK_ABOVE_COST.CNY + 0.1, "CNY"))).toBe(true);
    expect(asksFirst(3, perToken(0.0095))).toBe(false);
  });

  test("a plan and this computer ask only by the number of Documents", () => {
    expect(asksFirst(3, { billing: "plan" })).toBe(false);
    expect(asksFirst(3, { billing: "free" })).toBe(false);
    expect(asksFirst(3, null)).toBe(false);
  });

  test("a model with no known price asks by its model calls instead", () => {
    expect(asksFirst(3, perToken(null, "USD", ASK_ABOVE_CALLS))).toBe(false);
    expect(asksFirst(3, perToken(null, "USD", ASK_ABOVE_CALLS + 1))).toBe(true);
  });
});
