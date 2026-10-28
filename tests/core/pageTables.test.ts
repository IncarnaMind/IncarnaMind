/**
 * A page's tables (#1368), read the same way from a PDF's text layer and a scanned page's lines:
 * columns where the rows' words line up, however close; headings that wrap, sit left of their
 * figures or come in two levels; wrapped labels and cells, sections; and no table in prose set
 * in columns. The real PDFs are in tests/eval/tableSet.test.ts.
 */
import { describe, expect, test } from "vitest";
import { documentBlocks } from "../../src/core/answers/checks/verifyTables";
import { textLayerParts } from "../../src/core/documents/extract";
import { anchorsBack } from "../../src/core/documents/scan/rotation";
import { findTables, scannedRows } from "../../src/core/documents/tables";
import type { Anchor } from "../../src/shared/units";

const SIZE = 10;
const CHARACTER = 5;

const item = (str: string, x: number, y: number, eol = false) => ({
  str,
  dir: "ltr",
  transform: [SIZE, 0, 0, SIZE, x, y],
  width: str.length * CHARACTER,
  height: SIZE,
  hasEOL: eol,
});

/** A line of cells: each at its column's left edge, or ending at its right edge with "right". */
const line = (y: number, cells: readonly (readonly [string, number, "right"?])[]) =>
  cells.map(([text, at, align], index) =>
    item(
      text,
      align === "right" ? at - text.length * CHARACTER : at,
      y,
      index === cells.length - 1,
    ),
  );

const tables = (items: readonly object[]) =>
  (textLayerParts(items) ?? []).flatMap((part) =>
    part.kind === "table"
      ? [{ headings: part.grid.headings, rows: part.grid.rows.map((row) => row.cells) }]
      : [],
  );

describe("tables on a page", () => {
  test("figures a few points apart stay in their own columns", () => {
    // Columns 6 points apart: under one font size, where a rule by the gap would join them.
    const rows = [
      ["Item", "2025", "2024"],
      ["Revenue", "21,640", "19,080"],
      ["Cost", "16,930", "15,140"],
      ["Profit", "4,710", "3,940"],
    ];
    expect(
      tables(
        rows.flatMap((row, index) =>
          line(700 - index * 14, [
            [row[0] ?? "", 72],
            [row[1] ?? "", 200, "right"],
            [row[2] ?? "", 236, "right"],
          ]),
        ),
      ),
    ).toEqual([
      {
        headings: ["Item", "2025", "2024"],
        rows: [
          ["Revenue", "21,640", "19,080"],
          ["Cost", "16,930", "15,140"],
          ["Profit", "4,710", "3,940"],
        ],
      },
    ]);
  });

  test("headings set left over figures set right, and headings over two levels, name their columns", () => {
    const leftAligned = tables([
      ...line(700, [
        ["Item", 72],
        ["Closing balance", 170],
        ["Opening balance", 300],
      ]),
      ...line(684, [
        ["Cash", 72],
        ["3,820", 290, "right"],
        ["3,145", 420, "right"],
      ]),
      ...line(670, [
        ["Receivables", 72],
        ["2,610", 290, "right"],
        ["2,290", 420, "right"],
      ]),
    ]);
    expect(leftAligned[0]?.headings).toEqual(["Item", "Closing balance", "Opening balance"]);

    const twoLevels = tables([
      ...line(714, [
        ["2025", 230],
        ["2024", 350],
      ]),
      ...line(700, [
        ["Segment", 72],
        ["Q1", 200],
        ["Q2", 260],
        ["Q1", 320],
        ["Q2", 380],
      ]),
      ...line(686, [
        ["Retail", 72],
        ["1,200", 200],
        ["1,340", 260],
        ["1,100", 320],
        ["1,150", 380],
      ]),
      ...line(672, [
        ["Wholesale", 72],
        ["800", 200],
        ["760", 260],
        ["700", 320],
        ["720", 380],
      ]),
    ]);
    expect(twoLevels[0]?.headings).toEqual(["Segment", "2025 Q1", "2025 Q2", "2024 Q1", "2024 Q2"]);
  });

  // protects=over two-level headings, a piece wider than a cell, or one set past the table's last column, makes its line no heading row: a caption beside a year, a page number at the edge; fails_when=either is read into every column's heading; no_claim=a line of one piece, which the labelled set covers.
  test("a line with a piece wider than a cell, or past the table, heads no columns", () => {
    const body = [
      ...line(700, [
        ["Segment", 72],
        ["Q1", 200],
        ["Q2", 260],
        ["Q1", 320],
        ["Q2", 380],
      ]),
      ...line(686, [
        ["Retail", 72],
        ["1,200", 200],
        ["1,340", 260],
        ["1,100", 320],
        ["1,150", 380],
      ]),
      ...line(672, [
        ["Wholesale", 72],
        ["800", 200],
        ["760", 260],
        ["700", 320],
        ["720", 380],
      ]),
    ];
    const plain = ["Segment", "Q1", "Q2", "Q1", "Q2"];
    const wide = tables([
      ...line(714, [
        ["2025", 230],
        ["Sales by segment and quarter, in thousands of euros, before tax", 330],
      ]),
      ...body,
    ]);
    expect(wide[0]?.headings).toEqual(plain);
    const pastTheTable = tables([
      ...line(714, [
        ["2025", 230],
        ["Page 3", 440],
      ]),
      ...body,
    ]);
    expect(pastTheTable[0]?.headings).toEqual(plain);
  });

  test("a heading, a label or a cell that wraps onto the next line stays one", () => {
    const read = tables([
      ...line(700, [
        ["Cell", 72],
        ["Critical current density", 200],
      ]),
      ...line(688, [["(mA cm-2)", 200]]),
      ...line(670, [
        ["Bare electrolyte", 72],
        ["0.6", 200],
      ]),
      ...line(652, [
        ["Slow and destination (<", 72],
        ["2.4", 200],
      ]),
      ...line(640, [["22 kW)", 72]]),
      ...line(622, [
        ["Thick coating", 72],
        ["> 1,200 (high", 200],
      ]),
      ...line(610, [["overpotential)", 200]]),
    ]);
    expect(read).toEqual([
      {
        headings: ["Cell", "Critical current density (mA cm-2)"],
        rows: [
          ["Bare electrolyte", "0.6"],
          ["Slow and destination (< 22 kW)", "2.4"],
          ["Thick coating", "> 1,200 (high overpotential)"],
        ],
      },
    ]);
  });

  test("a label ending in a colon is a section's row, and a caption after a gap ends the table", () => {
    const parts = textLayerParts([
      ...line(700, [
        ["Item", 72],
        ["2025", 260, "right"],
      ]),
      ...line(686, [["Current assets:", 72]]),
      ...line(672, [
        ["Cash", 72],
        ["3,820", 260, "right"],
      ]),
      ...line(658, [
        ["Receivables", 72],
        ["2,610", 260, "right"],
      ]),
      item("Table 2: liabilities", 72, 620, true),
    ]);
    expect(parts?.map((part) => part.kind)).toEqual(["table", "text"]);
    const [table] = parts ?? [];
    expect(table?.kind === "table" && table.grid.rows).toEqual([
      { cells: ["Current assets:", ""], section: true },
      { cells: ["Cash", "3,820"], section: false },
      { cells: ["Receivables", "2,610"], section: false },
    ]);
  });

  test("two columns of prose, or references set in columns, are no table", () => {
    const prose = [0, 1, 2, 3].flatMap((row) =>
      line(700 - row * 14, [
        [`The left column goes on with words ${row}`, 72],
        [`and the right column does too ${row}`, 320],
      ]),
    );
    expect(textLayerParts(prose)).toBeNull();
    const references = [
      ["12.", "Lindqvist, A. Solid State Ionics.", "18.", "Osei, R. Energy Storage Letters."],
      ["", "412 (2025) 116-129.", "", "9 (2025) 77-84."],
      ["13.", "Hart, M. Journal of Example", "19.", "Watanabe, K. Example Review"],
      ["", "Electrochemistry 58 (2024).", "", "(2024) 2201-2215."],
    ].flatMap((row, index) =>
      line(
        700 - index * 14,
        row.flatMap((text, column): [string, number][] =>
          text ? [[text, [72, 90, 320, 338][column] ?? 72]] : [],
        ),
      ),
    );
    expect(textLayerParts(references)).toBeNull();
  });

  test.each([0, 90, 180, 270] as const)(
    "a scanned page's lines make a table from their displayed boxes at %i degrees",
    (turn) => {
      const rows = [
        ["Item", "Closing"],
        ["Cash", "3,820"],
        ["Receivables", "2,610"],
      ];
      let text = "";
      const anchors: Anchor[] = [];
      rows.forEach((row, index) => {
        if (index > 0) text += "\n";
        row.forEach((cell, column) => {
          if (column > 0) text += "\t";
          const left = column === 0 ? 0.1 : 0.5;
          const top = 0.2 + index * 0.03;
          anchors.push({
            start: text.length,
            end: text.length + cell.length,
            target: `line${anchors.length + 1}`,
            quad: [left, top, left + 0.1, top, left + 0.1, top + 0.02, left, top + 0.02],
          });
          text += cell;
        });
      });
      const displayed = anchorsBack(anchors, turn);
      const [found] = findTables(scannedRows(text, displayed, turn));
      expect(found?.grid).toEqual({
        headings: ["Item", "Closing"],
        rows: [
          { cells: ["Cash", "3,820"], section: false },
          { cells: ["Receivables", "2,610"], section: false },
        ],
        numeric: [false, true],
      });
      const label = { scan: { reader: "PP-OCRv5 mobile/2", turn } } as const;
      const blocks = documentBlocks([{ page: 1, text, kind: "page", label }], new Map(), [
        { page: 1, text, label, anchors: displayed },
      ]);
      expect(blocks.map((block) => block.node.type)).toEqual(["table"]);
    },
  );
});
