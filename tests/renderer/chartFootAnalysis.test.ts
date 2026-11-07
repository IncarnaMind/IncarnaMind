import { DOMParser } from "linkedom";
import { act, type ComponentType, type RefObject, createElement as reactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type ChartAttributes,
  type ChartSources,
  chartSources,
  readChart,
} from "../../src/shared/charts";
import { translate } from "../../src/shared/i18n";

/*
 * The foot under a chart of an Analysis's values says they were calculated by the Analysis, never
 * "each quoted" from the rows it read (#2378), as the User reads it.
 */

const state = vi.hoisted(() => ({ language: "en" as "en" | "zh-CN" }));
vi.mock("../../src/renderer/src/store", () => {
  const store = { status: { kind: "ready" }, documents: [] };
  return {
    useAppStore: Object.assign((select: (value: typeof store) => unknown) => select(store), {
      getState: () => store,
    }),
  };
});
vi.mock("../../src/renderer/src/i18n", () => ({
  useLanguage: () => state.language,
  useT: () => (key: Parameters<typeof translate>[1], values: Parameters<typeof translate>[2]) =>
    translate(state.language, key, values),
}));

/** The rows the Analysis read, which each of its values cites as an Input. */
const ROWS = {
  passageId: "p",
  documentId: "orders",
  documentName: "Orders",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "rows", sheet: "Orders", from: 1, to: 41 },
  quote: "region\tamount",
  check: "found",
};

/** A bar chart of `totals`, each value the Analysis's own, as a chart of its table draws them. */
const chartOf = (totals: number[]): ChartAttributes =>
  readChart({
    kind: "bar",
    title: "Total amount by region",
    drawn: null,
    source: { kind: "table", blockId: "table-1" },
    data: {
      labelHeading: "Region",
      series: ["Total amount"],
      rows: totals.map((total, index) => ({
        label: `Region ${index + 1}`,
        values: [
          {
            shown: String(total),
            value: total,
            fromAnalysis: true,
            inputs: [ROWS],
            from: { kind: "cell", row: index + 1, column: 1 },
          },
        ],
      })),
      cutFrom: null,
      cutRows: [],
    },
  });

let root: Root | null = null;
let container: HTMLElement;
beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  for (const [name, value] of Object.entries({
    document,
    window,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(name, value);
  container = globalThis.document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

interface FootProps {
  legend: never[];
  sources: ChartSources;
  check: null;
  notFound: number;
  rows: number;
  cutFrom: null;
  onUpdate: null;
  onFindUncited(): void;
  findRef: RefObject<HTMLButtonElement | null>;
}

async function foot(chart: ChartAttributes): Promise<string> {
  const path = "../../src/renderer/src/editor/ChartFoot.tsx";
  const module: { ChartFoot: ComponentType<FootProps> } = await import(path);
  const props: FootProps = {
    legend: [],
    sources: chartSources(chart),
    check: null,
    notFound: 0,
    rows: chart.data.rows.length,
    cutFrom: null,
    onUpdate: null,
    onFindUncited: () => {},
    findRef: { current: null },
  };
  root ??= createRoot(container);
  await act(() => root?.render(reactElement(module.ChartFoot, props)));
  return container.textContent ?? "";
}

test.each([
  ["en", "1 value, calculated by the Analysis", "4 values, each calculated by the Analysis"],
  ["zh-CN", "1 个数值，由数据分析计算得出", "4 个数值，均由数据分析计算得出"],
] as const)(
  "%s: a chart's foot says its values were calculated by the Analysis",
  async (language, one, four) => {
    state.language = language;
    // The whole line: never "each quoted from" the rows they were worked out from beside it.
    expect(await foot(chartOf([8325]))).toBe(one);
    expect(await foot(chartOf([8325, 9450, 7210, 6105]))).toBe(four);
  },
);
