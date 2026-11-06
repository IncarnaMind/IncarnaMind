import {
  Editor,
  getSchema,
  getTextBetween,
  getTextSerializersFromSchema,
  type JSONContent,
} from "@tiptap/core";
import { DOMSerializer, DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { parseHTML } from "linkedom";
import { describe, expect, onTestFinished, test } from "vitest";
import { CHART_NODE, CITATION_NODE, type Citation } from "../../src/core";
import { chartOfTable as coreChartOfTable } from "../../src/core/tools/minds/charts";
import {
  changeChart,
  chartOfSelection,
  chartOfTable,
  insertChart,
  switchedChartIn,
  tableUpdate,
  toggledSeries,
  withKind,
} from "../../src/renderer/src/editor/chartCommands";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import type { AnalysisTableMatch } from "../../src/shared/analysisTables";
import { type ChartAttributes, type ChartData, readChart } from "../../src/shared/charts";

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const citation = (page: number): JSONContent => ({
  type: CITATION_NODE,
  attrs: {
    passageId: "p",
    documentId: "acme",
    documentName: "Acme",
    pageFrom: page,
    pageTo: page,
    quote: `Revenue on page ${page}`,
    check: "found",
  },
});
const cell = (type: "tableHeader" | "tableCell", ...content: JSONContent[]): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1 },
  content: [paragraph(...content)],
});

/** Revenue by quarter: a heading row, then a figure and its Citation in each cell but the last. */
const QUARTERS: JSONContent = {
  type: "table",
  attrs: { id: "table-1" },
  content: [
    {
      type: "tableRow",
      content: [
        cell("tableHeader", text("Quarter")),
        cell("tableHeader", text("2024")),
        cell("tableHeader", text("2025")),
      ],
    },
    {
      type: "tableRow",
      content: [
        cell("tableCell", text("Q1")),
        cell("tableCell", text("289.4 "), citation(1)),
        cell("tableCell", text("341.5 "), citation(2)),
      ],
    },
    {
      type: "tableRow",
      content: [
        cell("tableCell", text("Q2")),
        cell("tableCell", text("301.2 "), citation(1)),
        cell("tableCell", text("362.0")),
      ],
    },
  ],
};

const wordsRow = (header: boolean, ...values: string[]): JSONContent => ({
  type: "tableRow",
  content: values.map((value) =>
    cell(header ? "tableHeader" : "tableCell", ...(value === "" ? [] : [text(value)])),
  ),
});

const YEARS_BY_METRICS: JSONContent = {
  type: "table",
  attrs: { id: "table-2" },
  content: [
    wordsRow(true, "Metric", "2023", "2024", "2025"),
    wordsRow(false, "Revenue", "289.4", "301.2", "330.6"),
    wordsRow(false, "Net income", "41.2", "45.0", "52.3"),
  ],
};

const WORKING_TABLE: JSONContent = {
  type: "table",
  attrs: { id: "table-3" },
  content: [
    wordsRow(true, "Step", "Formula", "Result"),
    wordsRow(false, "Revenue growth", "(377.9 − 330.6) ÷ 330.6", "14.3%"),
    wordsRow(false, "Net margin", "41.2 ÷ 377.9", "10.9%"),
  ],
};

function editorWith(blocks: JSONContent[]): Editor {
  const editor = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: { type: "doc", content: blocks },
  });
  onTestFinished(() => editor.destroy());
  return editor;
}

/** Puts the cursor in the first cell whose text starts with `start`. */
function cursorIn(editor: Editor, start: string): void {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent.startsWith(start)) at = pos + 1;
    return at < 0;
  });
  editor.commands.setTextSelection(at);
}

/** The top-level Blocks' types, an Answer's as "answer[…]" with its own. */
function outline(editor: Editor): string[] {
  const types: string[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name !== "answer") types.push(node.type.name);
    else {
      const inner: string[] = [];
      node.forEach((child) => {
        inner.push(child.type.name);
      });
      types.push(`answer[${inner.join(",")}]`);
    }
  });
  return types;
}

/** The chart in the editor, and where it is. */
function chartAt(editor: Editor): { chart: ChartAttributes; pos: number } {
  let found: { chart: ChartAttributes; pos: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.type.name === CHART_NODE) found = { chart: readChart(node.attrs), pos };
    return !found;
  });
  if (!found) throw new Error("No chart in the editor.");
  return found;
}

describe("Chart from table", () => {
  test("inserts a bar chart of the table after it, selected, its values with their cells and Citations", () => {
    const editor = editorWith([
      { type: "heading", attrs: { level: 2 }, content: [text("Quarter by quarter")] },
      QUARTERS,
      paragraph(text("After")),
    ]);
    cursorIn(editor, "Q2");
    const chart = chartOfTable(editor.state, "en");
    expect(chart).not.toBeNull();
    expect(insertChart(editor, chart as ChartAttributes)).toBe(true);

    expect(outline(editor)).toEqual(["heading", "table", CHART_NODE, "paragraph"]);
    const { chart: inserted, pos } = chartAt(editor);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(pos);
    // Named after the heading above it, until the User names it.
    expect(inserted.title).toBe("Quarter by quarter");
    expect(inserted.source).toEqual({ kind: "table", blockId: "table-1" });
    expect(inserted.data.series).toEqual(["2024", "2025"]);
    const q1 = inserted.data.rows[0]?.values[1];
    expect(q1).toMatchObject({
      shown: "341.5",
      value: 341.5,
      from: { kind: "cell", row: 1, column: 2 },
    });
    expect(q1?.citation).toMatchObject({ documentName: "Acme", pageFrom: 2, check: "found" });
    // The Citation is kept as a Citation keeps itself: no editor-only attributes.
    expect(Object.keys(q1?.citation ?? {})).not.toContain("proposal");
    expect(inserted.data.rows[1]?.values[1]?.citation).toBeNull();
  });

  test("a table of years by metrics gets its years on the x axis, and the metrics as its series", () => {
    const editor = editorWith([YEARS_BY_METRICS, paragraph()]);
    cursorIn(editor, "Revenue");
    const chart = chartOfTable(editor.state, "en") as ChartAttributes;
    expect(chart.source).toEqual({ kind: "table", blockId: "table-2", switched: true });
    expect(chart.data.rows.map((row) => row.label)).toEqual(["2023", "2024", "2025"]);
    expect(chart.data.series).toEqual(["Revenue", "Net income"]);
    insertChart(editor, chart);
    expect(chartAt(editor).chart.source).toEqual(chart.source);
  });

  test("isn't offered for a calculation's working table", () => {
    const editor = editorWith([WORKING_TABLE, paragraph()]);
    cursorIn(editor, "Revenue growth");
    expect(chartOfTable(editor.state, "en")).toBeNull();
  });

  test("a table in an Answer gets its chart after the Answer", () => {
    const editor = editorWith([
      { type: "question", attrs: { id: "q" }, content: [text("Revenue?")] },
      { type: "answer", attrs: { questionId: "q", status: "done" }, content: [QUARTERS] },
      paragraph(),
    ]);
    cursorIn(editor, "Q1");
    insertChart(editor, chartOfTable(editor.state, "en") as ChartAttributes);
    expect(outline(editor)).toEqual(["question", "answer[table]", CHART_NODE, "paragraph"]);
  });

  test("isn't offered outside a table, nor for a table with no column of numbers", () => {
    const editor = editorWith([
      paragraph(text("Text")),
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [cell("tableHeader", text("Claim")), cell("tableHeader", text("Where"))],
          },
          {
            type: "tableRow",
            content: [cell("tableCell", text("Spring")), cell("tableCell", text("Docs"))],
          },
        ],
      },
    ]);
    cursorIn(editor, "Text");
    expect(chartOfTable(editor.state, "en")).toBeNull();
    cursorIn(editor, "Spring");
    expect(chartOfTable(editor.state, "en")).toBeNull();
  });
});

describe("Chart from selected figures", () => {
  test("charts the figure in each selected line, with the line's Citation", () => {
    const editor = editorWith([
      paragraph(text("Q1 2025: $341.5 million "), citation(2)),
      {
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph(text("Q2 2025: $362.0 million"))] }],
      },
      paragraph(text("No figure here.")),
    ]);
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    const chart = chartOfSelection(editor.state, "en") as ChartAttributes;
    expect(chart.source).toEqual({ kind: "figures" });
    expect(chart.data.rows.map((row) => [row.label, row.values[0]?.shown])).toEqual([
      ["Q1 2025", "$341.5 million"],
      ["Q2 2025", "$362.0 million"],
    ]);
    expect(chart.data.rows[0]?.values[0]?.citation?.pageFrom).toBe(2);
    insertChart(editor, chart);
    expect(outline(editor)).toEqual(["paragraph", "bulletList", "paragraph", CHART_NODE]);
  });

  test("isn't offered with nothing selected, or no figure in what is", () => {
    const editor = editorWith([paragraph(text("No figure here."))]);
    expect(chartOfSelection(editor.state, "en")).toBeNull();
    editor.commands.setTextSelection({ from: 1, to: 10 });
    expect(chartOfSelection(editor.state, "en")).toBeNull();
  });
});

describe("changing a chart in place", () => {
  const made = () => {
    const editor = editorWith([QUARTERS, paragraph()]);
    cursorIn(editor, "Q1");
    insertChart(editor, chartOfTable(editor.state, "en") as ChartAttributes);
    return editor;
  };

  test("its kind, its columns, and its title, each a change of its own", () => {
    const editor = made();
    let { chart, pos } = chartAt(editor);
    changeChart(editor, pos, withKind(chart, "line"));
    expect(chartAt(editor).chart.kind).toBe("line");

    // A column off, and on again in its place in the table.
    ({ chart, pos } = chartAt(editor));
    changeChart(editor, pos, { drawn: toggledSeries(chart, 0) });
    expect(chartAt(editor).chart.drawn).toEqual([1]);
    ({ chart, pos } = chartAt(editor));
    changeChart(editor, pos, { drawn: toggledSeries(chart, 0) });
    expect(chartAt(editor).chart.drawn).toEqual([0, 1]);

    // A pie draws the one chosen.
    ({ chart, pos } = chartAt(editor));
    changeChart(editor, pos, withKind(chart, "pie"));
    ({ chart, pos } = chartAt(editor));
    expect(toggledSeries(chart, 0)).toEqual([0]);

    changeChart(editor, pos, { title: "Revenue, $ million" });
    expect(chartAt(editor).chart.title).toBe("Revenue, $ million");
  });

  test("a scatter chart takes two columns, keeping the first chosen", () => {
    const editor = made();
    const { chart } = chartAt(editor);
    expect(withKind({ ...chart, drawn: [1] }, "scatter")).toEqual({
      kind: "scatter",
      drawn: [0, 1],
    });
    expect(toggledSeries({ ...chart, kind: "scatter", drawn: [0, 1] }, 1)).toEqual([0]);
  });

  test("switches its rows and columns, and doesn't take its table to have changed", () => {
    const editor = made();
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    const { chart, pos } = chartAt(editor);
    const switched = switchedChartIn(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(switched).not.toBeNull();
    changeChart(editor, pos, switched ?? {});

    const after = chartAt(editor).chart;
    expect(after.source).toEqual({ kind: "table", blockId: "table-1", switched: true });
    expect(after.data.series).toEqual(["Q1", "Q2"]);
    expect(after.data.rows.map((row) => row.label)).toEqual(["2024", "2025"]);
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();

    let at = -1;
    editor.state.doc.descendants((child, place) => {
      if (at < 0 && child.isText && child.text === "362.0") at = place;
      return at < 0;
    });
    editor.view.dispatch(editor.state.tr.insertText("365.0", at, at + 5));
    const update = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(update?.rows.map((row) => row.label)).toEqual(["2024", "2025"]);
    expect(update?.rows[1]?.values[1]?.shown).toBe("365.0");

    const back = switchedChartIn(editor.state.doc, node()?.attrs ?? {}, "en");
    changeChart(editor, chartAt(editor).pos, back ?? {});
    expect(chartAt(editor).chart.source).toEqual({ kind: "table", blockId: "table-1" });
    expect(chartAt(editor).chart.data.rows).toEqual(chart.data.rows);
    expect(
      tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")?.rows[1]?.values[1]?.shown,
    ).toBe("365.0");
  });

  test("switched there and back, a row with no number is where it was, and the table hasn't changed", () => {
    const editor = editorWith([
      {
        type: "table",
        attrs: { id: "table-4" },
        content: [
          wordsRow(true, "Metric", "2023", "2024", "2025"),
          wordsRow(false, "Revenue", "289.4", "301.2", "330.6"),
          wordsRow(false, "Operating costs:", "", "", ""),
          wordsRow(false, "Rent", "12.0", "12.5", "13.1"),
        ],
      },
      paragraph(),
    ]);
    cursorIn(editor, "Revenue");
    insertChart(editor, chartOfTable(editor.state, "en") as ChartAttributes);
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    expect(chartAt(editor).chart.data.series).toEqual(["Revenue", "Rent"]);

    changeChart(
      editor,
      chartAt(editor).pos,
      switchedChartIn(editor.state.doc, node()?.attrs ?? {}, "en") ?? {},
    );
    expect(chartAt(editor).chart.data.rows.map((row) => row.label)).toEqual([
      "Revenue",
      "Operating costs:",
      "Rent",
    ]);
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();

    changeChart(
      editor,
      chartAt(editor).pos,
      switchedChartIn(editor.state.doc, node()?.attrs ?? {}, "en") ?? {},
    );
    expect(chartAt(editor).chart.data.series).toEqual(["Revenue", "Rent"]);
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();
  });

  test("keeps an Analysis's own value and Citations when its table's words are unchanged (#2378)", () => {
    const editor = editorWith([
      {
        type: "table",
        attrs: { id: "table-1" },
        content: [
          wordsRow(true, "Region", "Amount"),
          wordsRow(false, "Central", "8,325.44"),
          wordsRow(false, "North", "9,450"),
        ],
      },
      paragraph(),
    ]);
    cursorIn(editor, "Central");
    insertChart(editor, chartOfTable(editor.state, "en") as ChartAttributes);
    const source = (page: number) => ({
      passageId: "passage",
      documentId: "acme",
      documentName: "Acme",
      contentHash: "hash",
      pageFrom: page,
      pageTo: page,
      location: { kind: "page" as const, from: page, to: page },
      quote: `Revenue on page ${page}`,
      check: "found" as const,
      checkReason: null,
    });
    const citations = [source(1), source(2)];
    const fresh = chartAt(editor).chart.data;
    const numbers = [8325.444, 9450];
    const data: ChartData = {
      ...fresh,
      rows: fresh.rows.map((row, index) => ({
        ...row,
        values: row.values.map((value) =>
          value
            ? {
                ...value,
                value: numbers[index] ?? value.value,
                inputs: citations,
                fromAnalysis: true as const,
              }
            : null,
        ),
      })),
    };
    changeChart(editor, chartAt(editor).pos, { data });
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();

    let at = -1;
    editor.state.doc.descendants((child, place) => {
      if (at < 0 && child.isText && child.text === "8,325.44") at = place;
      return at < 0;
    });
    editor.view.dispatch(editor.state.tr.insertText("8,500", at, at + 8));
    const update = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(update?.rows[0]?.values[0]?.shown).toBe("8,500");
    expect(update?.rows[0]?.values[0]?.citation).toBeNull();
  });

  const match = (
    citations: Citation[],
    value: (row: number, column: number) => number | null,
  ): AnalysisTableMatch => ({
    binding: { id: "run", table: { result: "totals" } },
    label: "",
    table: { columns: [], rows: [], rowCount: 0, columnCount: 0 },
    columns: [],
    grids: [],
    numeric: [1],
    citations,
    value,
  });
  const drawByTheCore = (editor: Editor, analysis: AnalysisTableMatch) => {
    let tableAt = -1;
    editor.state.doc.descendants((node, pos) => {
      if (tableAt < 0 && node.type.name === "table") tableAt = pos;
      return tableAt < 0;
    });
    const table = editor.state.doc.nodeAt(tableAt)?.toJSON();
    if (!table) throw new Error("Missing table");
    const made = coreChartOfTable(
      table,
      "table-1",
      { kind: "bar", title: "" },
      "en",
      null,
      analysis,
    );
    if (!("chart" in made)) throw new Error("The core drew no chart.");
    insertChart(editor, readChart((made.chart.attrs ?? {}) as Record<string, unknown>));
  };
  const source = (documentId: string) => ({
    passageId: documentId,
    documentId,
    documentName: documentId,
    contentHash: "hash",
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "page" as const, from: 1, to: 1 },
    quote: "Revenue",
    check: "found" as const,
    checkReason: null,
  });

  test("keeps a core-drawn Analysis value and its inputs when a row goes (#2378)", () => {
    const editor = editorWith([
      {
        type: "table",
        attrs: { id: "table-1" },
        content: [
          wordsRow(true, "Region", "Amount"),
          wordsRow(false, "Central", "8,325.44"),
          wordsRow(false, "North", "9,450.12"),
          wordsRow(false, "South", "8,700.5"),
        ],
      },
      paragraph(),
    ]);
    cursorIn(editor, "Central");
    const inputs = [source("orders"), source("regions")];
    drawByTheCore(
      editor,
      match(inputs, (row, column) =>
        column === 1 ? ([8325.444, 9450.123, 8700.5][row] ?? null) : null,
      ),
    );
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    // The chart the core drew is up to date at once.
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();

    let at = -1;
    let size = 0;
    editor.state.doc.descendants((child, pos) => {
      if (at < 0 && child.type.name === "tableRow" && child.textContent.startsWith("Central")) {
        at = pos;
        size = child.nodeSize;
      }
      return at < 0;
    });
    editor.view.dispatch(editor.state.tr.delete(at, at + size));
    const update = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(update?.rows.map((row) => row.label)).toEqual(["North", "South"]);
    expect(update?.rows.map((row) => row.values[0]?.value)).toEqual([9450.123, 8700.5]);
    expect(update?.rows[0]?.values[0]?.inputs).toEqual(inputs);
  });

  test("knows two rows of one label apart by their order and series (#2378)", () => {
    const editor = editorWith([
      {
        type: "table",
        attrs: { id: "table-1" },
        content: [
          wordsRow(true, "Region", "Year", "Amount"),
          wordsRow(false, "Central", "2023", "8,325.44"),
          wordsRow(false, "Central", "2024", "9,450.12"),
          wordsRow(false, "North", "2023", "8,700.5"),
        ],
      },
      paragraph(),
    ]);
    cursorIn(editor, "Central");
    const inputs = [source("orders"), source("regions")];
    drawByTheCore(
      editor,
      match(inputs, (row, column) =>
        column === 2 ? ([8325.444, 9450.123, 8700.5][row] ?? null) : null,
      ),
    );
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    // Neither Central row overwrote the other: the chart the core drew is up to date.
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();

    // Removing the second Central leaves the first with its own value.
    let at = -1;
    let size = 0;
    editor.state.doc.descendants((child, pos) => {
      if (at < 0 && child.type.name === "tableRow" && child.textContent.includes("2024")) {
        at = pos;
        size = child.nodeSize;
      }
      return at < 0;
    });
    editor.view.dispatch(editor.state.tr.delete(at, at + size));
    const update = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    const amount = update?.rows[0]?.values[0];
    expect(amount?.value).toBe(8325.444);
    expect(amount?.inputs).toEqual(inputs);
  });

  const deleteColumn = (editor: Editor, column: number) => {
    const cells: { from: number; to: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== "tableRow") return true;
      let offset = pos + 1;
      node.forEach((child, _offset, index) => {
        if (index === column) cells.push({ from: offset, to: offset + child.nodeSize });
        offset += child.nodeSize;
      });
      return false;
    });
    const tr = editor.state.tr;
    for (const cell of cells.reverse()) tr.delete(cell.from, cell.to);
    editor.view.dispatch(tr);
  };

  test("keeps each Analysis value when the first of two rows of one label goes (#2378)", () => {
    const editor = editorWith([
      {
        type: "table",
        attrs: { id: "table-1" },
        content: [
          wordsRow(true, "Region", "Amount"),
          wordsRow(false, "Central", "8,325.44"),
          wordsRow(false, "Central", "9,450.12"),
          wordsRow(false, "North", "8,700.5"),
        ],
      },
      paragraph(),
    ]);
    cursorIn(editor, "Central");
    const inputs = [source("orders"), source("regions")];
    drawByTheCore(
      editor,
      match(inputs, (row, column) =>
        column === 1 ? ([8325.444, 9450.123, 8700.5][row] ?? null) : null,
      ),
    );
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();

    // The first Central row goes: the second keeps its own Analysis value.
    let at = -1;
    let size = 0;
    let seen = 0;
    editor.state.doc.descendants((child, pos) => {
      if (at >= 0 || child.type.name !== "tableRow") return at < 0;
      if (!child.textContent.startsWith("Central")) return true;
      seen += 1;
      if (seen === 1) {
        at = pos;
        size = child.nodeSize;
      }
      return false;
    });
    editor.view.dispatch(editor.state.tr.delete(at, at + size));
    const update = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(update?.rows.map((row) => row.label)).toEqual(["Central", "North"]);
    expect(update?.rows.map((row) => row.values[0]?.value)).toEqual([9450.123, 8700.5]);
    expect(update?.rows[0]?.values[0]?.inputs).toEqual(inputs);
  });

  test("keeps the Analysis values when a column before them goes (#2378)", () => {
    const editor = editorWith([
      {
        type: "table",
        attrs: { id: "table-1" },
        content: [
          wordsRow(true, "Region", "Units", "Amount"),
          wordsRow(false, "Central", "10", "8,325.44"),
          wordsRow(false, "North", "20", "9,450.12"),
        ],
      },
      paragraph(),
    ]);
    cursorIn(editor, "Central");
    const inputs = [source("orders"), source("regions")];
    drawByTheCore(
      editor,
      match(inputs, (row, column) => (column === 2 ? ([8325.444, 9450.123][row] ?? null) : null)),
    );
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();

    // Units was the first series; Amount moves from the second to the first.
    deleteColumn(editor, 1);
    const update = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(update?.rows.map((row) => row.values[0]?.value)).toEqual([8325.444, 9450.123]);
    expect(update?.rows[0]?.values[0]?.inputs).toEqual(inputs);
  });

  test("leaves a copied row its display, never another row's Analysis value (#2378)", () => {
    const editor = editorWith([
      {
        type: "table",
        attrs: { id: "table-1" },
        content: [
          wordsRow(true, "Region", "Amount"),
          wordsRow(false, "Central", "8,325.44"),
          wordsRow(false, "North", "9,450.12"),
        ],
      },
      paragraph(),
    ]);
    cursorIn(editor, "Central");
    const inputs = [source("orders"), source("regions")];
    drawByTheCore(
      editor,
      match(inputs, (row, column) => (column === 1 ? ([8325.444, 9450.123][row] ?? null) : null)),
    );
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();

    // The User copies the Central row: the copy has no Analysis value of its own.
    let at = -1;
    editor.state.doc.descendants((child, pos) => {
      if (at < 0 && child.type.name === "tableRow" && child.textContent.startsWith("Central"))
        at = pos;
      return at < 0;
    });
    const row = editor.state.doc.nodeAt(at);
    if (!row) throw new Error("Missing row");
    editor.view.dispatch(editor.state.tr.insert(at + row.nodeSize, row.copy(row.content)));
    const update = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(update?.rows.map((each) => each.label)).toEqual(["Central", "Central", "North"]);
    expect(update?.rows[0]?.values[0]?.value).toBe(8325.444);
    // The copy keeps its display and no Citation: the Analysis gave one Central value, not two.
    expect(update?.rows[1]?.values[0]?.value).toBe(8325.44);
    expect(update?.rows[1]?.values[0]?.inputs).toBeUndefined();
    expect(update?.rows[1]?.values[0]?.citation).toBeNull();
  });

  test("reads the cell's own Citation fresh, keeping the Analysis's inputs (#2378)", () => {
    const withOwn = {
      type: "tableRow",
      content: [
        cell("tableCell", text("Central")),
        cell("tableCell", text("8,325.44"), citation(1)),
      ],
    };
    const editor = editorWith([
      {
        type: "table",
        attrs: { id: "table-1" },
        content: [
          wordsRow(true, "Region", "Amount"),
          withOwn,
          wordsRow(false, "North", "9,450.12"),
        ],
      },
      paragraph(),
    ]);
    cursorIn(editor, "Central");
    const inputs = [source("orders"), source("regions")];
    drawByTheCore(
      editor,
      match(inputs, (row, column) => (column === 1 ? ([8325.444, 9450.123][row] ?? null) : null)),
    );
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    // The cell had its Citation when the chart was drawn: it is not out of date at once.
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();

    // A Citation added to the North cell: the Update carries the Analysis's inputs and this one.
    let at = -1;
    editor.state.doc.descendants((child, pos) => {
      if (at < 0 && child.isText && child.text === "9,450.12") at = pos + child.nodeSize;
      return at < 0;
    });
    editor.commands.insertContentAt(at, citation(3));
    const added = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(added?.rows[1]?.values[0]?.citation?.pageFrom).toBe(3);
    expect(added?.rows[1]?.values[0]?.inputs).toEqual(inputs);
    if (!added) throw new Error("The added Citation wasn't read.");
    changeChart(editor, chartAt(editor).pos, { data: added });

    // Removed again: the chart cites the Analysis's inputs only, never the old Citation.
    let size = 1;
    editor.state.doc.descendants((child, pos) => {
      if (child.type.name === CITATION_NODE) {
        at = pos;
        size = child.nodeSize;
      }
      return true;
    });
    editor.view.dispatch(editor.state.tr.delete(at, at + size));
    const removed = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(removed).not.toBeNull();
    expect(removed?.rows[1]?.values[0]?.citation).toBeNull();
    expect(removed?.rows[1]?.values[0]?.inputs).toEqual(inputs);
  });

  test("keeps each Analysis value with its own row when an earlier row goes", () => {
    const editor = editorWith([
      {
        type: "table",
        attrs: { id: "table-1" },
        content: [
          wordsRow(true, "Region", "Amount"),
          wordsRow(false, "Central", "8,325.44"),
          wordsRow(false, "North", "9,450.12"),
          wordsRow(false, "South", "8,700.5"),
        ],
      },
      paragraph(),
    ]);
    cursorIn(editor, "Central");
    insertChart(editor, chartOfTable(editor.state, "en") as ChartAttributes);
    const source = (documentId: string) => ({
      passageId: documentId,
      documentId,
      documentName: documentId,
      contentHash: "hash",
      pageFrom: 1,
      pageTo: 1,
      location: { kind: "page" as const, from: 1, to: 1 },
      quote: "Revenue",
      check: "found" as const,
      checkReason: null,
    });
    const citations = [source("orders"), source("regions")];
    const fresh = chartAt(editor).chart.data;
    const numbers = [8325.444, 9450.123, 8700.5];
    changeChart(editor, chartAt(editor).pos, {
      data: {
        ...fresh,
        rows: fresh.rows.map((row, index) => ({
          ...row,
          values: row.values.map((value) =>
            value
              ? {
                  ...value,
                  value: numbers[index] ?? value.value,
                  inputs: citations,
                  fromAnalysis: true as const,
                }
              : null,
          ),
        })),
      },
    });
    let at = -1;
    let size = 0;
    editor.state.doc.descendants((child, pos) => {
      if (at < 0 && child.type.name === "tableRow" && child.textContent.startsWith("Central")) {
        at = pos;
        size = child.nodeSize;
      }
      return at < 0;
    });
    editor.view.dispatch(editor.state.tr.delete(at, at + size));
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    const update = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(update?.rows.map((row) => row.label)).toEqual(["North", "South"]);
    expect(update?.rows.map((row) => row.values[0]?.value)).toEqual([9450.123, 8700.5]);
    expect(update?.rows[0]?.values[0]?.inputs?.map((each) => each.documentId)).toEqual([
      "orders",
      "regions",
    ]);
  });

  test("knows when its table changed since, and what it would draw now", () => {
    const editor = made();
    const node = () => editor.state.doc.nodeAt(chartAt(editor).pos);
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();

    // A figure in the table is corrected.
    let at = -1;
    editor.state.doc.descendants((child, pos) => {
      if (at < 0 && child.isText && child.text === "362.0") at = pos;
      return at < 0;
    });
    editor.view.dispatch(editor.state.tr.insertText("365.0", at, at + 5));
    const update = tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en");
    expect(update?.rows[1]?.values[1]?.shown).toBe("365.0");

    changeChart(editor, chartAt(editor).pos, { data: update ?? undefined });
    expect(chartAt(editor).chart.data.rows[1]?.values[1]?.value).toBe(365);
    expect(tableUpdate(editor.state.doc, node()?.attrs ?? {}, "en")).toBeNull();
  });
});

describe("a chart copied", () => {
  test("as HTML keeps everything it holds, and reads as its title and a table elsewhere", () => {
    const editor = editorWith([QUARTERS, paragraph()]);
    cursorIn(editor, "Q1");
    insertChart(editor, chartOfTable(editor.state, "en") as ChartAttributes);
    const { pos } = chartAt(editor);
    const node = editor.state.doc.nodeAt(pos);
    if (!node) throw new Error("No chart.");

    const { document } = parseHTML("<!doctype html><html><body></body></html>");
    const schema = getSchema(noteExtensions());
    const dom = DOMSerializer.fromSchema(schema).serializeNode(node, {
      document,
    }) as unknown as HTMLElement;
    expect(dom.querySelector("table")?.textContent).toContain("Q1289.4341.5");

    document.body.append(dom);
    const parsed = ProseMirrorDOMParser.fromSchema(schema).parse(document.body as unknown as Node);
    const copy = parsed.firstChild;
    expect(copy?.type.name).toBe(CHART_NODE);
    expect(readChart(copy?.attrs ?? {})).toEqual(readChart(node.attrs));
  });

  test("as text cites every input of an Analysis's chart", () => {
    const editor = editorWith([
      {
        type: "table",
        attrs: { id: "table-1" },
        content: [
          wordsRow(true, "Region", "Amount"),
          wordsRow(false, "Central", "8,325.44"),
          wordsRow(false, "North", "9,450.12"),
        ],
      },
      paragraph(),
    ]);
    cursorIn(editor, "Central");
    const source = (documentId: string) => ({
      passageId: documentId,
      documentId,
      documentName: documentId,
      contentHash: "hash",
      pageFrom: 1,
      pageTo: 1,
      location: { kind: "page" as const, from: 1, to: 1 },
      quote: "Revenue",
      check: "found" as const,
      checkReason: null,
    });
    const made = coreChartOfTable(
      editor.state.doc
        .nodeAt(
          (() => {
            let at = -1;
            editor.state.doc.descendants((node, pos) => {
              if (at < 0 && node.type.name === "table") at = pos;
              return at < 0;
            });
            return at;
          })(),
        )
        ?.toJSON() ?? { type: "table" },
      "table-1",
      { kind: "bar", title: "" },
      "en",
      null,
      {
        binding: { id: "run", table: { result: "totals" } },
        label: "",
        table: { columns: [], rows: [], rowCount: 0, columnCount: 0 },
        columns: [],
        grids: [],
        numeric: [1],
        citations: [source("orders"), source("regions")],
        value: (row, column) => (column === 1 ? ([8325.444, 9450.123][row] ?? null) : null),
      },
    );
    if (!("chart" in made)) throw new Error("The core drew no chart.");
    insertChart(editor, readChart((made.chart.attrs ?? {}) as Record<string, unknown>));
    const { pos } = chartAt(editor);
    const node = editor.state.doc.nodeAt(pos);
    const copied = getTextBetween(
      editor.state.doc,
      { from: pos, to: pos + (node?.nodeSize ?? 0) },
      { textSerializers: getTextSerializersFromSchema(editor.schema) },
    );
    expect(copied).toContain("8,325.44 [orders, p. 1]; [regions, p. 1]");
  });

  test("as text is its title and its values, each with its source", () => {
    const editor = editorWith([QUARTERS, paragraph()]);
    cursorIn(editor, "Q1");
    insertChart(editor, chartOfTable(editor.state, "en") as ChartAttributes);
    const { pos } = chartAt(editor);
    const node = editor.state.doc.nodeAt(pos);
    // What the clipboard's text is, as Tiptap writes it from each node's `renderText`.
    const copied = getTextBetween(
      editor.state.doc,
      { from: pos, to: pos + (node?.nodeSize ?? 0) },
      { textSerializers: getTextSerializersFromSchema(editor.schema) },
    );
    expect(copied).toBe(
      [
        "Quarter\t2024\t2025",
        "Q1\t289.4 [Acme, p. 1]\t341.5 [Acme, p. 2]",
        "Q2\t301.2 [Acme, p. 1]\t362.0",
      ].join("\n"),
    );
  });
});
