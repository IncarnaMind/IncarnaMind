import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Citation, FigureInput, FigureSchedule, FigureScheduleRow } from "../../src/core/api";
import {
  childrenOf,
  lineRef,
  scheduleLines,
  selectedFigures,
  shownNumber,
  sourceOf,
} from "../../src/shared/figureSchedule";
import { readFigures } from "../../src/shared/figures";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { translate } from "../../src/shared/i18n";

const state = vi.hoisted(() => ({
  language: "en" as "en" | "zh-CN",
  reportError: vi.fn(),
  copied: vi.fn(),
}));
vi.mock("../../src/renderer/src/store", () => {
  const store = { documents: [], settings: { language: "en" }, reportError: state.reportError };
  return {
    useAppStore: Object.assign((selector: (state: typeof store) => unknown) => selector(store), {
      getState: () => store,
    }),
  };
});
vi.mock("../../src/renderer/src/layoutSlice", () => ({ currentTabOf: () => null }));
vi.mock("../../src/renderer/src/modelNames", () => ({
  useModelNames: () => () => ({ name: "Test model", id: "test-model" }),
}));
vi.mock("../../src/renderer/src/copied", () => ({
  copyText: (value: string) => {
    state.copied(value);
    return Promise.resolve();
  },
}));
vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => state.language,
  useT: () => (key: Parameters<typeof translate>[1], params: Parameters<typeof translate>[2]) =>
    translate(state.language, key, params),
}));
vi.mock("../../src/renderer/src/motion", () => ({ enterFrom: () => {}, exitToward: () => {} }));

const citation: Citation = {
  passageId: "p",
  documentId: "doc",
  documentName: "Invented accounts",
  contentHash: "v1",
  quote: "Revenue 1,200",
  pageFrom: 1,
  pageTo: 1,
  check: "found",
  checkReason: null,
  location: { kind: "page", from: 1, to: 1 },
};
const input: FigureInput = {
  name: "revenue",
  label: "Revenue 2026",
  citation,
  number: {
    chars: "1,200",
    at: 8,
    value: 1200,
    scale: 1,
    scaleWord: null,
    unit: { kind: "plain" },
    decimals: 0,
    approximate: false,
    reading: null,
  },
  cell: { sheet: "Results", ref: "C5", stored: 1200 },
  unitStatement: {
    citation: { ...citation, quote: "Amounts in GBP" },
    scale: 1,
    scaleWord: null,
    currency: "GBP",
  },
};
function row(
  id: string,
  number: number,
  changes: Partial<FigureScheduleRow> = {},
): FigureScheduleRow {
  const reading = readFigures("20.0%", { language: "en" })[0];
  if (!reading) throw new Error("Missing figure fixture");
  return {
    id,
    number,
    reading,
    locator: { kind: "text", from: { blockId: id, offset: 0 }, to: { blockId: id, offset: 5 } },
    calculated: null,
    sourceInput: input,
    source: null,
    roundedFrom: null,
    difference: 0,
    footing: [],
    sentence: null,
    shown: { state: "supported" },
    reason: null,
    sourceValue: 0.2,
    sourceShown: "20.0%",
    checkedAt: "2026-10-27T12:00:00.000Z",
    model: null,
    place: { heading: "Results", paragraph: 1 },
    ...changes,
  };
}
function schedule(rows: FigureScheduleRow[]): FigureSchedule {
  return {
    mindId: "note",
    name: "Q3 2026 results",
    basis: "basis",
    rows,
    analyses: [],
    counts: { total: 47, supported: 21, needsLook: 13, notChecked: 10, checking: 2, kept: 1 },
    checkedAt: "2026-10-27T12:00:00.000Z",
    model: { providerId: "provider", modelId: "model" },
    progress: null,
  };
}
const calculated = row("calculated", 2, {
  shown: { state: "needs-recheck", why: "edited" },
  reason: "needs-recheck",
  calculated: {
    id: "atom",
    analysisId: null,
    figure: {
      label: "Growth",
      formula: "revenue / 4",
      inputs: [input],
      value: 300,
      unit: { kind: "plain" },
      approximate: false,
      shown: "300",
      show: { language: "en", as: null, decimals: 0, scale: null },
      literals: [{ text: "4", value: 4, at: 10 }],
      engine: FORMULA_VERSION,
      written: null,
    },
  },
});

test("parent filters and stable status order preserve exact IDs and do not mutate export data", () => {
  const source = schedule([
    row("a", 1),
    calculated,
    row("b", 3, { shown: { state: "not-checked", reason: "unread" } }),
  ]);
  const before = structuredClone(source);
  expect(
    scheduleLines(source, "all", true, new Set(["calculated"])).map((line) => line.id),
  ).toEqual(["calculated", "calculated:input:0", "b", "a"]);
  expect(scheduleLines(source, "supported", false, new Set()).map((line) => line.id)).toEqual([
    "a",
  ]);
  expect(source).toEqual(before);
});

test("bulk parent IDs exclude input selections and omitted Source rows on both axes", () => {
  const total = row("total", 3, {
    footing: (["row", "column"] as const).map((axis) => ({
      id: "total",
      axis,
      role: "total",
      componentIds: ["first"],
      excludedIds: [],
      sum: 1200,
      difference: 2,
      agrees: false,
    })),
    sourceFooting: (["row", "column"] as const).map((axis) => ({
      axis,
      componentIds: ["first"],
      inputs: [input],
      sum: 1250,
      agrees: true,
    })),
  });
  const source = schedule([row("first", 1), calculated, total]);
  const children = childrenOf(total, source.rows);
  expect(children.map((line) => [line.axis, !!line.omitted])).toEqual([
    ["row", false],
    ["row", true],
    ["column", false],
    ["column", true],
  ]);
  if (!children[0]) throw new Error("Missing child fixture");
  const selected = new Set([
    lineRef("note", children[0]).id,
    lineRef("note", { id: "total", parent: total }).id,
  ]);
  expect(selectedFigures(source, selected)).toEqual(["total"]);
  expect(
    sourceOf({ id: "child", parent: total, component: row("unbound", 4, { sourceInput: null }) }),
  ).toBeNull();
});

let root: Root | null = null;
let container: HTMLElement;
let selection: typeof import("../../src/renderer/src/selection");
interface ViewProps {
  schedule: FigureSchedule | null;
  onFocusFigure(row: FigureScheduleRow | null): void;
  onOpenSource(source: Citation): void;
  onExport(): void;
  onStop?(): void;
  onKeep(ids: string[]): void;
  onCheckAgain(ids: string[]): void;
  onChangeToSource(ids: string[]): void;
  onAddCitation(id: string): void;
  onChooseCitation(id: string): void;
  onTotalRole(id: string, axis: "row" | "column", total: boolean): void;
}
let View: ComponentType<ViewProps>;
let actions: Omit<ViewProps, "schedule">;
beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  for (const [name, value] of Object.entries({
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    MutationObserver: window.MutationObserver,
    getComputedStyle: () => ({ direction: "ltr" }),
    CSS: { escape: (value: string) => value },
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  window.HTMLElement.prototype.hidePopover = () => {};
  let active: Element | null = null;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  window.HTMLElement.prototype.focus = function () {
    active = this;
    this.dispatchEvent(new window.Event("focusin", { bubbles: true }));
  };
  state.language = "en";
  state.copied.mockClear();
  state.reportError.mockClear();
  const modulePath = "../../src/renderer/src/components/figures/FigureScheduleView.tsx";
  const module: { FigureScheduleView: ComponentType<ViewProps> } = await import(modulePath);
  View = module.FigureScheduleView;
  selection = await import("../../src/renderer/src/selection");
  selection.useSelection.getState().clear();
  actions = {
    onFocusFigure: vi.fn(),
    onOpenSource: vi.fn(),
    onExport: vi.fn(),
    onStop: vi.fn(),
    onKeep: vi.fn(),
    onCheckAgain: vi.fn(),
    onChangeToSource: vi.fn(),
    onAddCitation: vi.fn(),
    onChooseCitation: vi.fn(),
    onTotalRole: vi.fn(),
  };
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});
async function render(value: FigureSchedule | null) {
  await act(() => root?.render(createElement(View, { ...actions, schedule: value })));
}
async function click(target: Element | null, extra: Record<string, boolean> = {}) {
  if (!target) throw new Error("Missing click target");
  const event = new window.Event("click", { bubbles: true });
  for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value });
  await act(() => {
    if (target instanceof HTMLElement && target.matches("button")) target.focus();
    target.dispatchEvent(event);
  });
}
function button(text: string) {
  return (
    [...container.querySelectorAll("button")].find((each) => each.textContent === text) ?? null
  );
}
async function press(target: Element | null, key: string, extra: Record<string, boolean> = {}) {
  if (!target) throw new Error("Missing key target");
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries({ key, ...extra }))
    Object.defineProperty(event, name, { value });
  await act(() => {
    target.dispatchEvent(event);
  });
}

test.each(["en", "zh-CN"] as const)(
  "%s distinguishes loading, empty and no filter matches and uses supplied counts",
  async (language) => {
    state.language = language;
    await render(null);
    expect(container.textContent).toContain(translate(language, "figures.loading"));
    await render(schedule([]));
    expect(container.textContent).toContain(translate(language, "figures.empty"));
    await render(schedule([row("a", 1)]));
    expect(container.textContent).toContain("47");
    expect(container.textContent).toContain("Test model");
    await click(button(translate(language, "figures.filter.look")));
    expect(container.textContent).toContain(translate(language, "figures.noMatches"));
    await click(button(translate(language, "figures.export")));
    expect(actions.onExport).toHaveBeenCalledWith();
  },
);

test("zero-progress disables export, Stop and remaining checks use parent IDs", async () => {
  const source = schedule([
    calculated,
    row("unread", 3, { shown: { state: "not-checked", reason: "unread" } }),
  ]);
  await render({ ...source, progress: { done: 0, total: 2 } });
  expect(button("Export workbook")?.hasAttribute("disabled")).toBe(true);
  await click(button("Stop"));
  expect(actions.onStop).toHaveBeenCalledWith();
  await render(source);
  await click(button("Check remaining"));
  expect(actions.onCheckAgain).toHaveBeenLastCalledWith(["calculated", "unread"]);
});

test("actual shared selection excludes retained inputs from bulk actions, survives filtering, and Escape clears hidden selection", async () => {
  await render(schedule([row("a", 1), calculated]));
  await click(container.querySelector('[data-figure-id="calculated"] .figure-expand'));
  await click(container.querySelector('[data-figure-id="a"] [data-tree-row]'));
  await click(container.querySelector('[data-figure-id="calculated:input:0"] [data-tree-row]'), {
    ctrlKey: true,
  });
  expect(selection.useSelection.getState().items).toHaveLength(2);
  await click(button("Keep 1 as my view"));
  expect(actions.onKeep).toHaveBeenLastCalledWith(["a"]);
  await click(button("Supported"));
  const event = new window.Event("keydown", { bubbles: true });
  Object.defineProperty(event, "key", { value: "Escape" });
  await act(() => {
    container.querySelector("section")?.dispatchEvent(event);
  });
  expect(selection.useSelection.getState().items).toEqual([]);
  expect(actions.onFocusFigure).toHaveBeenLastCalledWith(null);
});

test("expanded calculated inputs show exact raw cells and unit quotes without inventing a current Supported verdict", async () => {
  await render(schedule([calculated]));
  await click(container.querySelector(".figure-expand"));
  const child = container.querySelector('[data-figure-id="calculated:input:0"]');
  expect(child?.textContent).toContain("1,200");
  expect(child?.textContent).toContain("Results!C5");
  expect(child?.textContent).toContain("Amounts in GBP");
  expect(child?.querySelector(".figure-status")?.textContent).toContain("Needs re-check");
  expect(child?.querySelector(".figure-status")?.textContent).not.toContain("Supported");
  expect(container.textContent).toContain("Numbers written in the formula: 4");
  await click(child?.querySelector(".figure-source > button") ?? null);
  expect(actions.onOpenSource).toHaveBeenLastCalledWith(citation);
});

test("filtering keeps the first visible row keyboard reachable when Note row one is hidden", async () => {
  await render(
    schedule([
      row("hidden", 1, { shown: { state: "unsupported" }, reason: "unsupported" }),
      row("visible", 2),
    ]),
  );
  await click(button("Supported"));
  expect(
    container.querySelector('[data-figure-id="visible"] [data-tree-row]')?.getAttribute("tabindex"),
  ).toBe("0");
});

test("Escape closes the inner shared menu before clearing selection and retains row focus", async () => {
  await render(schedule([row("a", 1)]));
  const main = container.querySelector('[data-figure-id="a"] [data-tree-row]');
  await click(main);
  const menu = container.querySelector('[role="menu"]');
  if (!menu) throw new Error("Missing menu fixture");
  const hide = vi.fn();
  Object.defineProperty(menu, "hidePopover", { value: hide });
  await press(menu, "Escape");
  expect(hide).toHaveBeenCalledOnce();
  expect(selection.useSelection.getState().items).toHaveLength(1);
  await press(main, "Escape");
  expect(selection.useSelection.getState().items).toHaveLength(0);
  expect(document.activeElement).toBe(main);
  expect(actions.onFocusFigure).toHaveBeenLastCalledWith(null);
});

test("shared row navigation extends selection, opens sources and copies parent and retained inputs", async () => {
  await render(schedule([row("a", 1), calculated]));
  await click(container.querySelector('[data-figure-id="calculated"] .figure-expand'));
  const first = container.querySelector('[data-figure-id="a"] [data-tree-row]');
  await click(first);
  await press(first, "ArrowDown", { shiftKey: true });
  expect(selection.useSelection.getState().items).toHaveLength(2);
  const main = container.querySelector('[data-figure-id="calculated"] [data-tree-row]');
  await press(main, "End");
  const child = container.querySelector('[data-figure-id="calculated:input:0"] [data-tree-row]');
  expect(document.activeElement).toBe(child);
  await press(child, "Enter");
  expect(actions.onOpenSource).toHaveBeenLastCalledWith(citation);
  await press(child, "a", { ctrlKey: true });
  expect(selection.useSelection.getState().items).toHaveLength(3);
  await press(child, "c", { ctrlKey: true });
  expect(state.copied).toHaveBeenCalledWith(expect.stringContaining("Revenue 2026\t1,200"));
});

test("both-axis Source footing proofs display only supplied sums and omitted inputs", async () => {
  const total = row("total", 1, {
    reason: "doesnt-add-up",
    shown: { state: "unsupported" },
    footing: (["row", "column"] as const).map((axis) => ({
      id: "total",
      axis,
      role: "total",
      componentIds: [],
      excludedIds: [],
      sum: 1200,
      difference: 2,
      agrees: false,
    })),
    sourceFooting: (["row", "column"] as const).map((axis) => ({
      axis,
      componentIds: [],
      inputs: [input],
      sum: 1250,
      agrees: true,
    })),
    place: {
      heading: null,
      paragraph: 1,
      table: { row: 1, column: 1, rowLabel: "Total", columnLabel: "2026" },
    },
  });
  await render(schedule([total]));
  expect(container.querySelectorAll(".figure-footing")).toHaveLength(2);
  expect(container.querySelector('[data-figure-id="total"]')?.children).toHaveLength(7);
  const explanation = container.querySelector(".figure-explanation");
  if (!explanation) throw new Error("Missing footing explanation");
  expect(explanation.getAttribute("colSpan")).toBe("7");
  expect(container.querySelectorAll(".figure-omitted-proof")).toHaveLength(2);
  expect(container.textContent).toContain("Doesn’t add up");
  expect(button("Treat as row total")).toBeNull();
  expect(actions.onTotalRole).not.toHaveBeenCalled();
  await click(button("Not a row total"));
  expect(actions.onTotalRole).toHaveBeenLastCalledWith("total", "row", false);
  await render(schedule([row("text", 1)]));
  expect(button("Treat as row total")).toBeNull();
});

test("raw values keep units and all meaningful digits, without clamping a small difference", () => {
  expect(shownNumber(0.19999999999999998, "en", { kind: "percent" })).toBe("19.999999999999998%");
  expect(shownNumber(0.002, "en", { kind: "points" })).toBe("0.2 percentage points");
  expect(shownNumber(0.002, "zh-CN", { kind: "points" })).toBe("0.2个百分点");
  expect(shownNumber(null, "en")).toBe("—");
  expect(shownNumber(Number.NaN, "en")).toBe("—");
});
