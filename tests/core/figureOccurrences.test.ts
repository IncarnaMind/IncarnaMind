import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { figuresInMind, figuresInSentence } from "../../src/core/answers/checks/figureOccurrences";
import { type SelectedSentence, textOf } from "../../src/core/answers/checks/sentences";
import { CALCULATED_FIGURE_NODE, CHART_NODE } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import type { ChartKind, ChartRow, ChartValue } from "../../src/shared/charts";
import { FORMULA_VERSION } from "../../src/shared/formula";

function stored(...nodes: NodeJSON[]) {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const blocks = doc.getXmlFragment("blocks");
  blocks.insert(0, nodes.map(createElement));
  return blocks;
}

function selected(element: Y.XmlElement, from = 0, to = textOf(element).length): SelectedSentence {
  const text = textOf(element);
  const id = element.getAttribute("id");
  if (typeof id !== "string") throw new Error("Missing fixture paragraph id");
  return {
    element,
    blockId: id,
    occurrence: 0,
    from,
    to,
    text: text.slice(from, to),
    context: text,
    cited: [],
  };
}

const paragraph = (id: string, ...content: NodeJSON[]): NodeJSON => ({
  type: "paragraph",
  attrs: { id },
  content,
});
const text = (value: string): NodeJSON => ({ type: "text", text: value });

test.each([
  ["Revenue £20 versus £20.", [8, 19]],
  ["收入20元，收入20元。", [2, 8]],
] as const)("keeps repeated literal occurrences distinct in %s", (value, starts) => {
  const blocks = stored(paragraph("p1", text(value)));
  const element = blocks.get(0);
  if (!(element instanceof Y.XmlElement)) throw new Error("Missing fixture paragraph");
  const sentence = selected(element);
  const figures = figuresInSentence(sentence);
  expect(figures.map((each) => each.reading.value)).toEqual([20, 20]);
  expect(
    figures.map((each) => (each.locator.kind === "text" ? each.locator.from.offset : -1)),
  ).toEqual(starts);
  expect(new Set(figures.map((each) => each.id)).size).toBe(2);
  expect(figuresInSentence(sentence)).toEqual(figures);
});

const calc = (id: string): NodeJSON =>
  calculatedFigureNode(
    {
      label: "Growth",
      formula: "",
      inputs: [],
      value: 0.25,
      unit: { kind: "percent" },
      approximate: false,
      shown: "25.0%",
      show: { language: "en", as: "percent", decimals: 1, scale: null },
      literals: [],
      engine: FORMULA_VERSION,
      written: null,
      analysis: { analysis: 1, result: "growth" },
    },
    id,
    "run-1",
  );

test("a selected later sentence keeps paragraph coordinates", () => {
  const value = "Before 5. After £20 and £20.";
  const blocks = stored(paragraph("p1", text(value)));
  const element = blocks.get(0);
  if (!(element instanceof Y.XmlElement)) throw new Error("Missing paragraph");
  const figures = figuresInSentence(selected(element, value.indexOf("After")));
  expect(figures.map((each) => each.reading.value)).toEqual([20, 20]);
  expect(figures.map((each) => each.reading.start)).toEqual([
    value.indexOf("£20"),
    value.lastIndexOf("£20"),
  ]);
});

test("shown atom text maps to one place and cannot merge with adjacent digits or atoms", () => {
  const blocks = stored(paragraph("p1", text("Values 1"), calc("f1"), calc("f2"), text(" and 2.")));
  const element = blocks.get(0);
  if (!(element instanceof Y.XmlElement)) throw new Error("Missing paragraph");
  const figures = figuresInSentence(selected(element));
  expect(figures.map((each) => each.reading.value)).toEqual([1, 0.25, 0.25, 2]);
  expect(figures.map((each) => each.id).slice(1, 3)).toEqual(["f1", "f2"]);
  expect(
    figures.slice(1, 3).map((each) => [each.reading.start, each.reading.end, each.reading.chars]),
  ).toEqual([
    [8, 9, "25.0%"],
    [9, 10, "25.0%"],
  ]);
  expect(figures.at(-1)?.reading.start).toBe(15);
});

test("the Mind collector retains leading and atom-only numeric figures", () => {
  expect(
    figuresInMind(
      stored(paragraph("p1", calc("f1"), text(" was reported.")), paragraph("p2", calc("f2"))),
    ).map((each) => each.id),
  ).toEqual(["f1", "f2"]);
});

test("dates, years, heading numbers and nonparagraph content are not amounts", () => {
  const blocks = stored(
    { type: "heading", attrs: { id: "h1", level: 1 }, content: [text("2. Revenue £99")] },
    paragraph("p1", text("1. In 2025, revenue was £20 on 2025-03-01.")),
    paragraph("p2", text("2. 净利润为30元。")),
    { type: "codeBlock", attrs: { id: "code" }, content: [text("amount = 800")] },
  );
  expect(figuresInMind(blocks).map((each) => each.reading.value)).toEqual([20, 30]);
});

test("currency ambiguity stays available rather than being silently settled", () => {
  const figures = figuresInMind(stored(paragraph("p1", text("Revenue was ¥100."))));
  expect(figures).toHaveLength(1);
  expect(figures[0]?.reading.ambiguous.some((each) => each.kind === "currency")).toBe(true);
});

const cell = (id: string, value: string, header = false, spans = {}): NodeJSON => ({
  type: header ? "tableHeader" : "tableCell",
  attrs: { colspan: 1, rowspan: 1, ...spans },
  content: [paragraph(id, text(value))],
});
const row = (...content: NodeJSON[]): NodeJSON => ({ type: "tableRow", content });

test("merged table headers project exact row/column labels and preserve unit ambiguity", () => {
  const blocks = stored({
    type: "table",
    attrs: { id: "t1" },
    content: [
      row(
        cell("h1", "项目", true, { rowspan: 2 }),
        cell("h2", "金额（万元）", true, { colspan: 2 }),
      ),
      row(cell("h3", "2024", true), cell("h4", "2025", true)),
      row(cell("a", "收入"), cell("b", "10"), cell("c", "20")),
      row(cell("d", "合计"), cell("e", "10"), cell("f", "20")),
    ],
  });
  const figures = figuresInMind(blocks);
  expect(figures.map((each) => each.reading.value)).toEqual([10, 20, 10, 20]);
  expect(figures.map((each) => [each.table?.row, each.table?.column])).toEqual([
    [2, 1],
    [2, 2],
    [3, 1],
    [3, 2],
  ]);
  expect(figures[0]?.table).toMatchObject({
    blockId: "t1",
    rowLabel: "收入",
    columnLabel: "金额（万元）\n2024",
    header: false,
  });
  expect(
    figures[0]?.reading.ambiguous.some(
      (each) => each.kind === "scale" && each.readings.some((reading) => reading.scale === 10_000),
    ),
  ).toBe(true);
});

test("a row unit cell reaches its numeric cell through the existing reader", () => {
  const figures = figuresInMind(
    stored({
      type: "table",
      attrs: { id: "t1" },
      content: [
        row(cell("h1", "项目", true), cell("h2", "数值", true), cell("h3", "单位", true)),
        row(cell("a", "收入"), cell("b", "12"), cell("c", "万元")),
      ],
    }),
  );
  expect(figures).toHaveLength(1);
  expect(figures[0]?.table).toMatchObject({ row: 1, column: 1, rowLabel: "收入" });
  expect(
    figures[0]?.reading.ambiguous.some(
      (each) => each.kind === "scale" && each.readings.some((reading) => reading.scale === 10_000),
    ),
  ).toBe(true);
});

test("a row that only names a group heads the rows below it in their context", () => {
  const figures = figuresInMind(
    stored({
      type: "table",
      attrs: { id: "t1" },
      content: [
        row(cell("h1", "Item", true), cell("h2", "2024", true), cell("h3", "2025", true)),
        row(cell("a", "Revenue:"), cell("b", ""), cell("c", "")),
        row(cell("d", "Total"), cell("e", "100"), cell("f", "120")),
        row(cell("g", "Cost:"), cell("h", ""), cell("i", "")),
        row(cell("j", "Total"), cell("k", "70"), cell("l", "78")),
      ],
    }),
  );
  expect(figures.map((each) => each.context.split("\n").slice(0, 2))).toEqual([
    ["2024", "Revenue:"],
    ["2025", "Revenue:"],
    ["2024", "Cost:"],
    ["2025", "Cost:"],
  ]);
  expect(figures[0]?.table).toMatchObject({ rowLabel: "Total" });
  expect(figures.map((each) => each.label)).toEqual([
    "Total · 2024",
    "Total · 2025",
    "Total · 2024",
    "Total · 2025",
  ]);
});

const value = (number: number | null): ChartValue => ({
  shown: number === null ? "missing" : String(number),
  value: number,
  unit: { kind: "plain" },
  scale: 1,
  citation: null,
  from: { kind: "text", line: 0 },
});
const chart = (
  kind: ChartKind,
  rows: ChartRow[],
  drawn: number[] | null = null,
  cutRows: ChartRow[] = [],
): NodeJSON => ({
  type: CHART_NODE,
  attrs: {
    id: "chart-1",
    kind,
    title: "Forecast 2026",
    drawn,
    source: { kind: "figures" },
    data: { labelHeading: "Year", series: ["2024", "2025", "2026"], rows, cutRows, cutFrom: null },
  },
});

test("charts enumerate real drawn values without category/header/cut-row numbers", () => {
  const figures = figuresInMind(
    stored(
      chart(
        "bar",
        [
          { label: "2024", values: [value(10), value(20), value(99)] },
          { label: "2025", values: [value(30), value(40), value(98)] },
        ],
        [1],
        [{ label: "2023", values: [value(80), value(90), value(97)] }],
      ),
    ),
  );
  expect(figures.map((each) => each.reading.value)).toEqual([20, 40]);
  expect(figures.map((each) => each.locator)).toEqual([
    { kind: "chart", blockId: "chart-1", row: 0, series: 1 },
    { kind: "chart", blockId: "chart-1", row: 1, series: 1 },
  ]);
});

test("scatter includes both actual coordinates of a plotted pair and no unpaired/excess series", () => {
  const figures = figuresInMind(
    stored(
      chart(
        "scatter",
        [
          { label: "A", values: [value(2024), value(20), value(999)] },
          { label: "B", values: [value(2025), value(null), value(998)] },
          { label: "C", values: [value(null), value(30), value(997)] },
        ],
        [0, 1, 2],
      ),
    ),
  );
  expect(figures.map((each) => each.reading.value)).toEqual([2024, 20]);
  expect(figures.map((each) => each.locator)).toEqual([
    { kind: "chart", blockId: "chart-1", row: 0, series: 0 },
    { kind: "chart", blockId: "chart-1", row: 0, series: 1 },
  ]);
});

test("pie values follow actual positive plotted points in its one drawn series", () => {
  const figures = figuresInMind(
    stored(
      chart(
        "pie",
        [
          { label: "A", values: [value(99), value(0)] },
          { label: "B", values: [value(88), value(10)] },
          { label: "C", values: [value(77), value(-1)] },
        ],
        [0, 1],
      ),
    ),
  );
  expect(figures.map((each) => each.reading.value)).toEqual([10]);
});

test("Mind order interleaves paragraphs and chart data", () => {
  expect(
    figuresInMind(
      stored(
        paragraph("p1", text("Revenue £5.")),
        chart("bar", [{ label: "A", values: [value(10)] }], [0]),
        paragraph("p2", text("Margin 20%.")),
      ),
    ).map((each) => each.reading.value),
  ).toEqual([5, 10, 0.2]);
});

test("boolean and malformed calculated nodes do not invent numeric readings", () => {
  const boolean = calc("bool");
  if (!boolean.attrs || typeof boolean.attrs.figure !== "object" || boolean.attrs.figure === null)
    throw new Error("Missing fixture receipt");
  boolean.attrs.figure = {
    ...boolean.attrs.figure,
    value: true,
    shown: "Yes",
    unit: { kind: "yes-no" },
    show: { language: "en", as: "yes-no", decimals: null, scale: null },
  };
  expect(
    figuresInMind(
      stored(
        paragraph("p1", boolean, {
          type: CALCULATED_FIGURE_NODE,
          attrs: { id: "bad", figure: {} },
        }),
      ),
    ),
  ).toEqual([]);
});

test.each([
  { language: "en", prose: "Revenue was £4,979.6m.", caption: "Revenue by segment (£m)" },
  { language: "zh-CN", prose: "营业收入为49.80亿元。", caption: "分部收入（单位：人民币百万元）" },
])(
  "a table cell's figure reads as the $language note around it writes numbers, leaving only its heading's scale to settle",
  ({ prose, caption }) => {
    const cell = (id: string, value: string, header = false): NodeJSON => ({
      type: header ? "tableHeader" : "tableCell",
      content: [paragraph(id, text(value))],
    });
    const blocks = stored(paragraph("prose", text(prose)), paragraph("caption", text(caption)), {
      type: "table",
      attrs: { id: "table" },
      content: [
        { type: "tableRow", content: [cell("h0", "Segment", true), cell("h1", "Q3", true)] },
        { type: "tableRow", content: [cell("c0", "Groceries"), cell("c1", "2,160")] },
      ],
    });
    const figure = figuresInMind(blocks).find((each) => each.reading.chars === "2,160");
    expect(figure?.reading.value).toBe(2160);
    expect(figure?.reading.ambiguous.map((each) => each.kind)).toEqual(["scale"]);
  },
);
