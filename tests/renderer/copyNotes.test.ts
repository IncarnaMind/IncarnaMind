import { getSchema, type JSONContent } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import { CHART_NODE, CITATION_NODE, FOOTNOTE_NODE, PROPOSAL_ATTRIBUTE } from "../../src/core/api";
import {
  addFootnotes,
  citationsIn,
  copiedText,
  noteNumbers,
  wordFootnoteHtml,
} from "../../src/renderer/src/editor/copyNotes";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const schema = getSchema(noteExtensions());
const context = { language: "en" as const, documents: [{ id: "tides", contentHash: "h1" }] };

const cite = (pageFrom: number, documentId = "tides", contentHash = "h1"): JSONContent => ({
  type: CITATION_NODE,
  attrs: {
    documentId,
    documentName: "Tides",
    contentHash,
    pageFrom,
    pageTo: pageFrom,
  },
});

const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const text = (value: string): JSONContent => ({ type: "text", text: value });

const fragmentOf = (...blocks: JSONContent[]) =>
  schema.nodeFromJSON({ type: "doc", content: blocks }).content;

describe("copying Citations as text", () => {
  test("numbered markers in the text and a list of Sources after it", () => {
    const copied = copiedText(
      fragmentOf(paragraph(text("Spring tides"), cite(2)), paragraph(text("Neap tides"), cite(5))),
      schema,
      context,
    );
    expect(copied).toBe(
      "Spring tides[1]\n\nNeap tides[2]\n\nSources\n[1] Tides, p. 2\n[2] Tides, p. 5",
    );
  });

  test("a source and place cited again takes the first note's number, and is listed once", () => {
    const copied = copiedText(
      fragmentOf(
        paragraph(text("Spring"), cite(2)),
        paragraph(text("Neap"), cite(5)),
        paragraph(text("Spring again"), cite(2)),
        paragraph(text("Later"), cite(7)),
      ),
      schema,
      context,
    );
    expect(copied).toBe(
      "Spring[1]\n\nNeap[2]\n\nSpring again[1]\n\nLater[3]\n\nSources\n[1] Tides, p. 2\n[2] Tides, p. 5\n[3] Tides, p. 7",
    );
  });

  test("two Documents with one name take a number each", () => {
    const copied = copiedText(
      fragmentOf(
        paragraph(text("Spring"), cite(2)),
        paragraph(text("Spring too"), cite(2, "tides-2", "h2")),
      ),
      schema,
      { ...context, documents: [...context.documents, { id: "tides-2", contentHash: "h2" }] },
    );
    expect(copied).toBe("Spring[1]\n\nSpring too[2]\n\nSources\n[1] Tides, p. 2\n[2] Tides, p. 2");
  });

  test("two deleted Documents with one name, and two versions of one, take a number each", () => {
    const version = (contentHash: string): JSONContent => ({
      ...cite(2),
      attrs: { ...cite(2).attrs, contentHash },
    });
    const copied = copiedText(
      fragmentOf(
        paragraph(text("First"), cite(2, "gone-1")),
        paragraph(text("Second"), cite(2, "gone-2")),
        paragraph(text("Third"), version("h3")),
      ),
      schema,
      context,
    );
    expect(copied).toBe(
      "First[1]\n\nSecond[2]\n\nThird[3]\n\nSources\n[1] Tides, p. 2\n[2] Tides, p. 2\n[3] Tides, p. 2",
    );
  });

  test("in Chinese", () => {
    expect(
      copiedText(fragmentOf(paragraph(text("大潮"), cite(2))), schema, {
        ...context,
        language: "zh-CN",
      }),
    ).toBe("大潮[1]\n\n来源\n[1] Tides，第 2 页");
  });

  test("a copy with no Citation is left to the editor's own text", () => {
    expect(copiedText(fragmentOf(paragraph(text("Plain"))), schema, context)).toBe("");
  });

  test("a Citation in a footnote the User wrote takes no number", () => {
    const footnote: JSONContent = { type: FOOTNOTE_NODE, content: [text("See "), cite(9)] };
    const fragment = fragmentOf(paragraph(text("Claim"), footnote, cite(2)));
    expect(citationsIn(fragment)).toHaveLength(1);
    expect(copiedText(fragment, schema, context)).toContain("Claim^[See [Tides, p. 9]][1]");
  });
});

describe("copying Citations as Word footnotes", () => {
  const copied = () => {
    const { document } = parseHTML("<!doctype html><html><body></body></html>");
    const root = document.createElement("div");
    root.innerHTML =
      '<p>Spring tides<span data-type="citation"></span></p><p>Neap tides<span data-type="citation"></span></p>';
    const citations = citationsIn(
      fragmentOf(paragraph(text("a"), cite(2)), paragraph(text("b"), cite(5))),
    );
    addFootnotes(root, citations, context);
    return wordFootnoteHtml(root.innerHTML);
  };

  test("each marker is Word's own footnote number, with the visible [n] in a block Word skips", () => {
    const html = copied();
    for (const number of [1, 2]) {
      expect(html).toContain(
        `<span style="mso-special-character:footnote"><![if !supportFootnotes]><span class="MsoFootnoteReference">[${number}]</span><![endif]></span>`,
      );
    }
    // Both ends of each footnote: the reference in the text and the mark opening its note.
    expect(html.match(/mso-special-character:footnote/g)).toHaveLength(4);
    expect(html.match(/<!\[if !supportFootnotes\]>/g)).toHaveLength(4);
    expect(html.match(/<!\[endif\]>/g)).toHaveLength(4);
    expect(html).toContain("mso-footnote-id:ftn1");
    expect(html).toContain("mso-footnote-id:ftn2");
  });

  test("a source and place cited again repeats the first note's number and adds no note", () => {
    const { document } = parseHTML("<!doctype html><html><body></body></html>");
    const root = document.createElement("div");
    root.innerHTML =
      '<p>One<span data-type="citation"></span></p><p>Two<span data-type="citation"></span></p><p>Three<span data-type="citation"></span></p>';
    addFootnotes(
      root,
      citationsIn(
        fragmentOf(
          paragraph(text("a"), cite(2)),
          paragraph(text("b"), cite(5)),
          paragraph(text("c"), cite(2)),
        ),
      ),
      context,
    );
    const html = wordFootnoteHtml(root.innerHTML);
    expect(html.match(/mso-element:footnote"/g)).toHaveLength(2);
    expect(html.match(/mso-footnote-id:ftn1/g)).toHaveLength(2);
    expect(html.match(/mso-footnote-id:ftn2/g)).toHaveLength(2);
    expect(html).not.toContain("mso-footnote-id:ftn3");
    // The third marker is the first note's number, raised, linked to it, with "[n]" for other apps.
    expect(html).toContain(
      '<sup class="MsoFootnoteReference"><a href="#_ftn1"><![if !supportFootnotes]>[<![endif]>1<![if !supportFootnotes]>]<![endif]></a></sup>',
    );
    expect(html.match(/data-type="citation"/g)).toHaveLength(3);
  });

  test("the footnote list and its Sources stay, and no fixed mark is left as a comment", () => {
    const html = copied();
    expect(html).toContain("mso-element:footnote-list");
    expect(html).toContain("Tides, p. 2");
    expect(html).toContain("Tides, p. 5");
    expect(html).not.toContain("<!--");
  });
});

const cell = (type: "tableCell" | "tableHeader", ...blocks: JSONContent[]): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1 },
  content: blocks,
});
const row = (...cells: JSONContent[]): JSONContent => ({ type: "tableRow", content: cells });
const table = (id: string, ...rows: JSONContent[]): JSONContent => ({
  type: "table",
  attrs: { id },
  content: rows,
});
const words = (value: string) => (value === "" ? paragraph() : paragraph(text(value)));
const tableWithHeadings = (id: string, ...rows: string[][]): JSONContent =>
  table(
    id,
    ...rows.map((each, index) =>
      row(...each.map((value) => cell(index === 0 ? "tableHeader" : "tableCell", words(value)))),
    ),
  );

describe("copying a table as text", () => {
  const sales = tableWithHeadings("t1", ["Year", "Revenue"], ["2023", "289.4"], ["2024", "301.2"]);

  test("is one row to a line, its cells apart by tabs, and the table once", () => {
    const copied = copiedText(fragmentOf(sales), schema, context);
    expect(copied).toBe("Year\tRevenue\n2023\t289.4\n2024\t301.2");
  });

  test("keeps the text before it and after it", () => {
    const copied = copiedText(
      fragmentOf(paragraph(text("Revenue by year")), sales, paragraph(text("In $ million"))),
      schema,
      context,
    );
    expect(copied).toBe(
      "Revenue by year\n\nYear\tRevenue\n2023\t289.4\n2024\t301.2\n\nIn $ million",
    );
  });

  test("in Chinese", () => {
    const copied = copiedText(
      fragmentOf(
        tableWithHeadings("t1", ["指标", "2024年", "2025年"], ["营业收入", "1.5亿元", "1.8亿元"]),
      ),
      schema,
      { ...context, language: "zh-CN" },
    );
    expect(copied).toBe("指标\t2024年\t2025年\n营业收入\t1.5亿元\t1.8亿元");
  });

  test("keeps an empty cell in its column", () => {
    const copied = copiedText(
      fragmentOf(tableWithHeadings("t1", ["A", "B", "C"], ["1", "", "3"], ["", "", ""])),
      schema,
      context,
    );
    expect(copied).toBe("A\tB\tC\n1\t\t3\n\t\t");
  });

  test("keeps a cell's line breaks inside the cell, as spaces", () => {
    const broken = table(
      "t1",
      row(cell("tableHeader", words("Note")), cell("tableHeader", words("Value"))),
      row(
        cell(
          "tableCell",
          paragraph(text("First line"), { type: "hardBreak" }, text("second line")),
        ),
        cell("tableCell", words("1")),
      ),
      row(
        cell("tableCell", words("Two"), words("paragraphs")),
        cell("tableCell", paragraph(text("a\tb"))),
      ),
    );
    const copied = copiedText(fragmentOf(broken), schema, context);
    expect(copied).toBe("Note\tValue\nFirst line second line\t1\nTwo paragraphs\ta b");
    expect(copied.split("\n")).toHaveLength(3);
  });

  test("copies cells selected in a table as their rows, apart by tabs", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        tableWithHeadings(
          "t1",
          ["Year", "Revenue", "Cost"],
          ["2023", "289.4", "100"],
          ["2024", "301.2", "110"],
        ),
      ],
    });
    const cellAt = (words: string) => {
      let found = -1;
      doc.descendants((node, pos) => {
        if (found < 0 && node.type.name === "tableCell" && node.textContent === words) found = pos;
        return found < 0;
      });
      return found;
    };
    const selected = CellSelection.create(doc, cellAt("2023"), cellAt("301.2")).content();
    expect(selected.content.firstChild?.type.name).toBe("tableRow");
    expect(copiedText(selected.content, schema, context)).toBe("2023\t289.4\n2024\t301.2");
  });

  test("leaves the slots a merged cell covers empty, so the columns keep their places", () => {
    const merged = table(
      "t1",
      row(
        cell("tableHeader", words("Region")),
        cell("tableHeader", words("2024")),
        cell("tableHeader", words("2025")),
      ),
      row(
        { ...cell("tableCell", words("North")), attrs: { colspan: 1, rowspan: 2 } },
        { ...cell("tableCell", words("Total")), attrs: { colspan: 2, rowspan: 1 } },
      ),
      row(cell("tableCell", words("7")), cell("tableCell", words("8"))),
    );
    expect(copiedText(fragmentOf(merged), schema, context)).toBe(
      "Region\t2024\t2025\nNorth\tTotal\t\n\t7\t8",
    );
  });

  test("writes a Citation in a cell as its marker, with the Sources after the table", () => {
    const cited = table(
      "t1",
      row(cell("tableHeader", words("Year")), cell("tableHeader", words("Revenue"))),
      row(cell("tableCell", words("2023")), cell("tableCell", paragraph(text("289.4"), cite(2)))),
    );
    expect(copiedText(fragmentOf(cited), schema, context)).toBe(
      "Year\tRevenue\n2023\t289.4[1]\n\nSources\n[1] Tides, p. 2",
    );
  });

  test("leaves out a chart of the table when the table is in the copy, so the table is not there twice", () => {
    const copied = copiedText(fragmentOf(sales, chartOf("t1")), schema, context);
    expect(copied).toBe("Year\tRevenue\n2023\t289.4\n2024\t301.2");
  });

  test("keeps a chart of another table, which the copy doesn't hold, and a chart on its own", () => {
    expect(copiedText(fragmentOf(sales, chartOf("t2")), schema, context)).toBe(
      "Year\tRevenue\n2023\t289.4\n2024\t301.2\n\nRevenue\nYear\tRevenue\n2023\t289.4",
    );
    expect(copiedText(fragmentOf(chartOf("t1")), schema, context)).toBe("");
  });

  test("a copy with no table and no Citation is left to the editor's own text", () => {
    expect(copiedText(fragmentOf(paragraph(text("Plain")), chartOf("t1")), schema, context)).toBe(
      "",
    );
  });
});

function chartOf(tableId: string): JSONContent {
  return {
    type: CHART_NODE,
    attrs: {
      kind: "bar",
      title: "Revenue",
      drawn: null,
      source: { kind: "table", blockId: tableId },
      data: {
        labelHeading: "Year",
        series: ["Revenue"],
        rows: [
          {
            label: "2023",
            values: [
              {
                shown: "289.4",
                value: 289.4,
                unit: null,
                scale: null,
                citation: null,
                from: { kind: "cell", row: 1, column: 1 },
              },
            ],
          },
        ],
        cutFrom: null,
        cutRows: [],
      },
    },
  };
}

describe("the numbers a copy writes", () => {
  test("a Citation a change still waiting adds is a note of its own, so later numbers stay", () => {
    const pending = {
      ...cite(2),
      attrs: {
        ...cite(2).attrs,
        [PROPOSAL_ATTRIBUTE]: { id: "p1", request: "r", kind: "insert" },
      },
    };
    expect(noteNumbers(citationsIn(fragmentOf(pending, cite(2), cite(5))), context)).toEqual([
      1, 2, 3,
    ]);
  });
});
