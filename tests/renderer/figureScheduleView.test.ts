import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Citation, FigureInput, FigureSchedule, FigureScheduleRow } from "../../src/core/api";
import { figureScheduleBook } from "../../src/core/exports/figureScheduleBook";
import type { CommandContext } from "../../src/renderer/src/commands/registry";
import {
  childrenOf,
  differenceText,
  footingNotes,
  lineRef,
  lineShows,
  scheduleLines,
  selectedFigures,
  sourceOf,
  sourceValueText,
  writtenLike,
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
// The menus' keys reach the Tasks, which listen to the core as they load.
vi.mock("../../src/renderer/src/core", () => ({ core: { on: () => () => {} } }));
vi.mock("../../src/renderer/src/modelNames", () => ({
  useModelNames: () => () => ({ name: "Test model", id: "test-model" }),
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
    cited: false,
    signOff: null,
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
  const children = childrenOf(total, source);
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
let notices: typeof import("../../src/renderer/src/notices");
/** As FigureScheduleView takes them; the view itself is imported at run time, as a .tsx file. */
interface ViewProps {
  schedule: FigureSchedule | null;
  onFocusFigure(row: FigureScheduleRow | null): void;
  onShowFigure(row: FigureScheduleRow): void;
  onOpenSource(source: Citation): void;
  onExport(): void;
  onStop?(): void;
  onKeep(ids: string[]): void;
  onCheckAgain(ids: string[]): void;
  onSignOff(ids: string[], off: boolean): void;
  onChangeToSource(ids: string[]): void;
  onAddCitation(id: string): void;
  onChooseCitation(id: string): void;
  onTotalRole(id: string, axes: ("row" | "column")[], total: boolean): void;
}
let View: ComponentType<ViewProps>;
let actions: Omit<ViewProps, "schedule">;
beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const globals: Record<string, unknown> = {
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
    requestAnimationFrame: (run: () => void) => {
      run();
      return 0;
    },
    ClipboardItem: class {
      constructor(readonly parts: Record<string, Blob>) {}
    },
    navigator: {
      clipboard: {
        write: async (items: { parts: Record<string, Blob> }[]) => {
          const text = await items[0]?.parts["text/plain"]?.text();
          const html = await items[0]?.parts["text/html"]?.text();
          state.copied(text, html);
        },
      },
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
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
  notices = await import("../../src/renderer/src/notices");
  selection.useSelection.getState().clear();
  notices.useNotices.getState().dismissConfirmation();
  actions = {
    onFocusFigure: vi.fn(),
    onShowFigure: vi.fn(),
    onOpenSource: vi.fn(),
    onExport: vi.fn(),
    onStop: vi.fn(),
    onKeep: vi.fn(),
    onCheckAgain: vi.fn(),
    onSignOff: vi.fn(),
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
function button(text: string, within: ParentNode = container) {
  return (
    [...within.querySelectorAll("button")].find(
      (each) => each.textContent?.replace(/(?:↵|Space|⌘C)$/, "").trim() === text,
    ) ?? null
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
const mainOf = (id: string) => container.querySelector(`[data-figure-id="${id}"] [data-tree-row]`);
const menuOf = (id: string) => container.querySelector(`[data-figure-id="${id}"] [role="menu"]`);

test.each(["en", "zh-CN"] as const)(
  "%s shows loading, the note's name and time, counts in the one vocabulary, empty and no matches",
  async (language) => {
    state.language = language;
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate(language, key, params);
    await render(null);
    expect(container.textContent).toContain(t("figures.loading"));
    await render(schedule([]));
    expect(container.textContent).toContain(t("figures.empty"));
    await render(schedule([row("a", 1)]));
    expect(container.querySelector(".figure-name")?.textContent).toBe("Q3 2026 results");
    expect(container.querySelector('[data-testid="figure-when"]')?.textContent).toMatch(
      language === "en" ? /^Checked / : /^已核对 /,
    );
    expect(container.querySelector('[data-testid="figure-counts"]')?.textContent).toBe(
      [
        t("figures.count", { count: 47 }),
        t("figures.supported", { count: 21 }),
        t("figures.look", { count: 13 }),
        t("figures.notChecked", { count: 12 }),
        t("figures.yourView", { count: 1 }),
      ].join(" · "),
    );
    await click(button(t("figures.filter.look")));
    expect(container.textContent).toContain(t("figures.noMatches"));
    await click(button(t("figures.showAll")));
    expect(container.querySelector('[data-figure-id="a"]')).not.toBeNull();
    await click(button(t("figures.export")));
    expect(actions.onExport).toHaveBeenCalledWith();
  },
);

test("a run in progress disables export and offers Stop; figures left unchecked offer Check the rest", async () => {
  const source = schedule([
    row("checked", 1),
    calculated,
    row("unread", 3, { shown: { state: "not-checked", reason: "unread" } }),
  ]);
  await render({ ...source, progress: { done: 0, total: 2 } });
  expect(container.textContent).toContain("Checking 0 of 2 figures…");
  expect(button("Export schedule…")?.hasAttribute("disabled")).toBe(true);
  await click(button("Stop"));
  expect(actions.onStop).toHaveBeenCalledWith();
  await render(source);
  expect(container.querySelector('[data-testid="figure-when"]')?.textContent).toContain(
    "45 of 47 figures checked",
  );
  await click(button("Check the rest"));
  expect(actions.onCheckAgain).toHaveBeenLastCalledWith(["calculated", "unread"]);
});

test("a row shows its source value and difference in the note's own terms", () => {
  const pounds = (text: string) => {
    const figure = readFigures(text, { language: "en", midLine: true })[0];
    if (!figure) throw new Error(`No figure in ${text}`);
    return figure;
  };
  const number = (text: string) => {
    const figure = pounds(text);
    return {
      ...input.number,
      chars: figure.chars,
      value: figure.value,
      scale: figure.scale,
      scaleWord: figure.scaleWord,
      unit: figure.unit,
      decimals: figure.decimals,
    };
  };
  const at = (shown: string, source: string, changes: Partial<FigureScheduleRow> = {}) => {
    const reading = pounds(shown);
    const sourceNumber = number(source);
    return row("r", 1, {
      reading,
      sourceInput: { ...input, number: sourceNumber, unitStatement: null },
      sourceValue: sourceNumber.value,
      sourceShown: source,
      difference: reading.value - sourceNumber.value,
      ...changes,
    });
  };
  const rounded = at("£4,980m", "£4,979.6m", { roundedFrom: 4_979_600_000 });
  expect(sourceValueText(rounded)).toBe("£4,979.6m");
  expect(differenceText(rounded, "en")).toBe("Rounded from £4,979.6m");
  expect(differenceText(rounded, "zh-CN")).toBe("由 £4,979.6m 舍入");
  const off = at("£402m", "£392m", { shown: { state: "contradicted" } });
  expect(differenceText(off, "en")).toBe("+£10m");
  expect(differenceText(at("£5.7bn", "£5,704m", { roundedFrom: 5_704_000_000 }), "en")).toBe(
    "Rounded from £5.704bn",
  );
  expect(differenceText(at("38.6%", "38.4%"), "en")).toBe("+0.2 percentage points");
  expect(differenceText(at("3.1×", "3.3×"), "en")).toBe("−0.2×");
  expect(differenceText(at("£20", "£20"), "en")).toBeNull();
  expect(writtenLike(pounds("1.2亿元"), 125_000_000, 2)).toBe("1.25亿元");
  // A source's sign is its own, written as the note writes a negative.
  expect(sourceValueText(at("£130m", "−£131m"))).toBe("−£131m");
  expect(sourceValueText(at("-£130m", "-£131m"))).toBe("-£131m");
  expect(sourceValueText(at("−£130m", "£131m"))).toBe("£131m");
});

test("a total that agrees with its source but doesn't add up names both facts and the row the table leaves out", async () => {
  const reading = readFigures("£4,980m", { language: "en" })[0];
  const other = {
    ...input,
    label: "Other",
    number: { ...input.number, chars: "130", value: 130_000_000, scale: 1_000_000 },
  };
  if (!reading) throw new Error("Missing reading");
  const total = row("total", 3, {
    reading,
    reason: "doesnt-add-up",
    shown: { state: "unsupported" },
    sourceValue: 4_980_000_000,
    difference: 0,
    footing: [
      {
        id: "total",
        axis: "row",
        role: "total",
        componentIds: ["first"],
        excludedIds: [],
        sum: 4_850_000_000,
        difference: -130_000_000,
        agrees: false,
      },
    ],
    sourceFooting: [
      { axis: "row", componentIds: ["first"], inputs: [other], sum: 4_980_000_000, agrees: true },
    ],
    place: {
      heading: "Segments",
      paragraph: 3,
      table: { row: 3, column: 1, rowLabel: "Total", columnLabel: "" },
    },
  });
  expect(footingNotes(total)).toEqual([
    { axis: "row", agrees: true, sum: "£4,850m", omitted: ["Other £130m"], sourceSum: null },
  ]);
  await render(schedule([row("first", 1), total]));
  const why = container.querySelector('[data-figure-id="total"] .figure-why');
  expect(why?.textContent).toContain("Agrees with the source");
  expect(why?.textContent).toContain("The rows above add to £4,850m");
  expect(why?.textContent).toContain(
    "The source also has a row “Other £130m”, which this table leaves out.",
  );
  expect(container.querySelector('[data-figure-id="total"] .figure-place')?.textContent).toBe(
    "Segments › table, Total row",
  );
  expect(button("Treat as a total", menuOf("total") ?? container)).toBeNull();
  await click(button("Not a total", menuOf("total") ?? container));
  expect(actions.onTotalRole).toHaveBeenLastCalledWith("total", ["row"], false);
  expect(button("Not a total", menuOf("first") ?? container)).toBeNull();
});

test("one selected figure is outlined; the menu acts on every selected figure and says how many", async () => {
  const unread = (id: string, number: number) =>
    row(id, number, { shown: { state: "not-checked", reason: "unread" } });
  await render(schedule([unread("a", 1), unread("b", 2), row("c", 3)]));
  await click(mainOf("a"));
  expect(actions.onFocusFigure).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
  await click(mainOf("b"), { ctrlKey: true });
  expect(selection.useSelection.getState().items).toHaveLength(2);
  expect(actions.onFocusFigure).toHaveBeenLastCalledWith(null);
  const menu = menuOf("b");
  await click(button("Keep 2 figures as my view", menu ?? container));
  expect(actions.onKeep).toHaveBeenLastCalledWith(["a", "b"]);
  await click(button("Check 2 figures again", menu ?? container));
  expect(actions.onCheckAgain).toHaveBeenLastCalledWith(["a", "b"]);
  expect(button("Check again", menuOf("c") ?? container)).toBeNull();
});

test("a render that changes nothing doesn't outline the figure in the note again", async () => {
  const shown = schedule([row("a", 1), row("b", 2)]);
  await render(shown);
  await click(mainOf("a"));
  expect(actions.onFocusFigure).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
  vi.mocked(actions.onFocusFigure).mockClear();
  await render(shown);
  expect(actions.onFocusFigure).not.toHaveBeenCalled();
});

test("a selection of mixed figures shows each item for, counts and acts on the figures it applies to", async () => {
  const unread = row("unread", 1, { shown: { state: "not-checked", reason: "unread" } });
  const kept = row("kept", 2, { shown: { state: "kept" } });
  await render(schedule([unread, kept, row("supported", 3)]));
  await click(mainOf("supported"));
  await click(mainOf("unread"), { ctrlKey: true });
  // The menu of a Supported row still checks the selected figure that isn't checked.
  await click(button("Check again", menuOf("supported") ?? container));
  expect(actions.onCheckAgain).toHaveBeenLastCalledWith(["unread"]);
  await click(button("Keep 2 figures as my view", menuOf("supported") ?? container));
  expect(actions.onKeep).toHaveBeenLastCalledWith(["unread", "supported"]);
  await click(mainOf("kept"));
  await click(mainOf("unread"), { ctrlKey: true });
  // A kept row's menu still keeps the selected figure that isn't kept.
  await click(button("Keep as my view", menuOf("kept") ?? container));
  expect(actions.onKeep).toHaveBeenLastCalledWith(["unread"]);
});

test("a contradicted figure offers Change to its source value; a supported uncited one Add as Citation", async () => {
  const off = row("off", 1, {
    shown: { state: "contradicted" },
    reason: "contradicted",
    difference: 0.01,
  });
  await render(schedule([off, row("cited", 2)]));
  await click(button("Change to 20%", menuOf("off") ?? container));
  expect(actions.onChangeToSource).toHaveBeenLastCalledWith(["off"]);
  await click(button("Add as Citation", menuOf("cited") ?? container));
  expect(actions.onAddCitation).toHaveBeenLastCalledWith("cited");
  await render(schedule([row("cited", 2, { cited: true })]));
  expect(button("Add as Citation", menuOf("cited") ?? container)).toBeNull();
});

test("Escape closes the row's menu first, then clears the selection and the outline, keeping focus on the row", async () => {
  await render(schedule([row("a", 1)]));
  const main = mainOf("a");
  await click(main);
  const menu = menuOf("a");
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

test("the keyboard moves, opens, outlines, unfolds a calculated figure's inputs and copies rows", async () => {
  await render(schedule([row("a", 1), calculated]));
  const first = mainOf("a");
  await click(first);
  await press(first, "Enter");
  expect(actions.onOpenSource).toHaveBeenLastCalledWith(citation);
  await press(first, " ");
  expect(actions.onShowFigure).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
  await press(first, "ArrowDown");
  const parent = mainOf("calculated");
  expect(document.activeElement).toBe(parent);
  expect(container.querySelector('[data-figure-id="calculated"] .figure-equals')).not.toBeNull();
  expect(container.querySelector('[data-figure-id="calculated"] .figure-source')?.textContent).toBe(
    "Calculated · Revenue 2026 ÷ 4",
  );
  await press(parent, "ArrowRight");
  const child = mainOf("calculated:input:0");
  expect(child?.textContent).toBe("Revenue 2026");
  expect(
    container.querySelector('[data-figure-id="calculated:input:0"] .figure-status')?.textContent,
  ).toContain("Supported");
  await press(parent, "ArrowDown");
  await press(child, "Enter");
  expect(actions.onOpenSource).toHaveBeenLastCalledWith(citation);
  await press(child, "ArrowLeft");
  expect(document.activeElement).toBe(parent);
  await press(parent, "a", { ctrlKey: true });
  expect(selection.useSelection.getState().items).toHaveLength(3);
  await press(parent, "c", { ctrlKey: true });
  await act(async () => {});
  const [text, html] = state.copied.mock.lastCall ?? [];
  expect(text).toMatch(
    /^#\tFigure\tSource value\tSource\tDifference\tStatus\tChecked by\n1\t20.0%\t20%\tInvented accounts, p. 1\t\tSupported\t\n/,
  );
  expect(text).toContain("\tRevenue 2026\t1,200\t");
  expect(html).toContain("<th>Source value</th>");
});

test("a row's Copy copies the rows its menu acts on: that row, unless the selection holds it", async () => {
  await render(schedule([row("a", 1), row("b", 2)]));
  await click(mainOf("a"));
  await click(button("Copy", menuOf("b") ?? container));
  await act(async () => {});
  expect(state.copied.mock.lastCall?.[0]).toMatch(/\n2\t20.0%\t/);
  expect(state.copied.mock.lastCall?.[0]).not.toMatch(/\n1\t/);
  await click(mainOf("b"), { ctrlKey: true });
  await click(button("Copy", menuOf("b") ?? container));
  await act(async () => {});
  expect(state.copied.mock.lastCall?.[0]).toMatch(/\n1\t20.0%\t[^\n]*\n2\t20.0%\t/);
});

test("a line copies as it reads: an input whose quote isn't found, and a column total's parts by their column", () => {
  const lost = { ...input, citation: { ...citation, check: "not-found" as const } };
  const parent = row("calculated", 2, {
    calculated: calculated.calculated && {
      ...calculated.calculated,
      figure: { ...calculated.calculated.figure, inputs: [lost] },
    },
  });
  expect(lineShows({ id: "kid", parent, input: lost }, "en").status).toEqual({
    glyph: "look",
    word: "figures.filter.look",
    why: "claim.why.quoteNotFound",
  });
  const part = row("q3", 1, {
    place: {
      heading: null,
      paragraph: 1,
      table: { row: 1, column: 2, rowLabel: "Revenue", columnLabel: "Q3" },
    },
  });
  const total = row("total", 3);
  expect(lineShows({ id: "kid", parent: total, component: part, axis: "column" }, "en").name).toBe(
    "Q3",
  );
  expect(lineShows({ id: "kid", parent: total, component: part, axis: "row" }, "en").name).toBe(
    "Revenue",
  );
});

test.each(["en", "zh-CN"] as const)(
  "%s: a what-if's line names its change, and its changed input shows the value it was given, never as found (#2347)",
  (language) => {
    const growth: FigureInput = {
      ...input,
      name: "Assumptions_B4",
      label: "Revenue growth (Growth)",
      number: { ...input.number, chars: "5.0%", value: 0.05, unit: { kind: "percent" } },
      cell: { sheet: "Assumptions", ref: "B4", stored: 0.05 },
      unitStatement: null,
    };
    const base = calculated.calculated?.figure;
    if (!base) throw new Error("Missing calculated fixture");
    const step = {
      sheet: "DCF",
      ref: "E5",
      label: "EBITDA 2027",
      formula: "E4*Margin",
      value: 254.7,
    };
    const whatIf = row("what-if", 3, {
      sourceInput: null,
      sourceValue: 240.4,
      sourceShown: "240.4",
      calculated: {
        id: "what-if",
        analysisId: null,
        figure: {
          ...base,
          formula: "",
          inputs: [growth, input],
          workbook: {
            cell: {
              ...step,
              input: { ...input, cell: { sheet: "DCF", ref: "E5", stored: 254.7 } },
            },
            steps: [],
            formulaCells: 5,
            moreInputs: 0,
            saved: 254.7,
            savedShown: "254.7",
            change: { input: "Assumptions_B4", value: 0.03, shown: "3.0%" },
            kept: [],
            engine: 1,
          },
        },
      },
    });
    expect(lineShows({ id: "what-if", parent: whatIf }, language).formula).toBe(
      language === "en"
        ? "What-if: DCF!E5 = E4*Margin, with Revenue growth (Growth) at 3.0% (5.0% in the workbook)"
        : "假设情形：DCF!E5 = E4*Margin，其中“Revenue growth (Growth)”取 3.0%（工作簿中为 5.0%）",
    );
    // A what-if is no Document's number: it has no source value, in the schedule or its export.
    expect(lineShows({ id: "what-if", parent: whatIf }, language).value).toBeNull();
    expect(lineShows({ id: "kid", parent: whatIf, input: growth }, language)).toMatchObject({
      value: "3.0%",
      status: { glyph: "not-checked", word: "figures.workbook.whatIfInput", why: null },
    });
    expect(lineShows({ id: "kid", parent: whatIf, input }, language)).toMatchObject({
      value: "1,200",
      status: { glyph: "supported" },
    });
    const sheet = figureScheduleBook(schedule([whatIf]), { language, modelName: () => "" })
      .sheets[0];
    const texts = (id: string) =>
      sheet?.rows
        .find((each) => each.id === id)
        ?.cells.flatMap((cell) => (cell.value.kind === "text" ? [cell.value.text] : []));
    expect(
      sheet?.rows
        .find((each) => each.id === "what-if")
        ?.cells.find((cell) => cell.column === "sourceValue")?.value,
    ).toEqual({ kind: "empty" });
    expect(texts("what-if")?.[1]).toContain(
      language === "en" ? "What-if: DCF!E5" : "假设情形：DCF!E5",
    );
    expect(texts("what-if:input:0")).toContain(translate(language, "figures.workbook.whatIfInput"));
  },
);

test("⌘K offers the menu's actions on the figures chosen in the schedule, saying how many", async () => {
  const { figureScheduleCommands } = await import("../../src/renderer/src/commands/figures");
  const { figureScheduleHandle } = await import(
    "../../src/renderer/src/components/figures/figureScheduleHandle"
  );
  const unread = (id: string, number: number) =>
    row(id, number, { shown: { state: "not-checked", reason: "unread" } });
  const shown = schedule([unread("a", 1), unread("b", 2), row("c", 3)]);
  const keep = vi.fn();
  const checkAgain = vi.fn();
  figureScheduleHandle.current = { schedule: shown, keep, checkAgain, signOff: vi.fn() };
  const refOf = (id: string) => {
    const each = shown.rows.find((candidate) => candidate.id === id);
    if (!each) throw new Error(`No row ${id}`);
    return lineRef("note", { id, parent: each });
  };
  const ctx: CommandContext = {
    selection: [refOf("a"), refOf("b")],
    focus: null,
    surface: "palette",
  };
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate("en", key, params);
  const [check, kept] = ["figures.checkChosen", "figures.keepChosen"].map((id) => {
    const command = figureScheduleCommands.find((each) => each.id === id);
    if (!command) throw new Error(`No command ${id}`);
    return command;
  });
  const label = (command: typeof check) =>
    typeof command?.label === "function" ? command.label(ctx, t) : command?.label;
  expect(label(check)).toBe("Check 2 figures again");
  expect(label(kept)).toBe("Keep 2 figures as my view");
  expect(check?.when?.(ctx)).toBe(true);
  check?.run(ctx);
  expect(checkAgain).toHaveBeenLastCalledWith(["a", "b"]);
  kept?.run(ctx);
  expect(keep).toHaveBeenLastCalledWith(["a", "b"]);
  expect(check?.when?.({ ...ctx, selection: [refOf("c")] })).toBe(false);
  figureScheduleHandle.current = null;
  expect(kept?.when?.(ctx)).toBe(false);
});

test("a figure not checked yet has nothing to open: Enter says so", async () => {
  await render(schedule([row("unread", 1, { shown: { state: "not-checked", reason: "unread" } })]));
  await press(mainOf("unread"), "Enter");
  expect(actions.onOpenSource).not.toHaveBeenCalled();
  expect(notices.useNotices.getState().confirmation?.message).toBe("figures.notCheckedNotice");
});
