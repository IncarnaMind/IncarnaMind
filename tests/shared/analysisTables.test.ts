import { describe, expect, test } from "vitest";
import type { AnswerAnalysis, Citation } from "../../src/core/api";
import { type AnalysisTable, noAnalysisOutput } from "../../src/shared/analysis";
import { countCitations, withAnalysisTableCitations } from "../../src/shared/analysisTables";
import type { NodeJSON } from "../../src/shared/blockJson";

const citation: Citation = {
  passageId: "p1",
  documentId: "d1",
  documentName: "Sales 2026",
  contentHash: "hash",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "rows", sheet: "Weekly", from: 1, to: 25 },
  quote: "Region\tRevenue",
  check: "found",
  checkReason: null,
};

const table = (rows: (string | number)[][]): AnalysisTable => ({
  columns: ["Region", "Revenue"],
  rows,
  rowCount: rows.length,
  columnCount: 2,
});

/** A paragraph Block in a table cell, as `markdownToBlocks` writes it. */
const cell = (text: string): NodeJSON => ({
  type: "tableHeader",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
});

const dataCell = (text: string): NodeJSON => ({ ...cell(text), type: "tableCell" });

const tableBlock = (rows: (string | number)[][]): NodeJSON => ({
  type: "table",
  content: [
    { type: "tableRow", content: [cell("Region"), cell("Revenue")] },
    ...rows.map((row) => ({
      type: "tableRow",
      content: row.map((value) => dataCell(String(value))),
    })),
  ],
});

const analysis = (
  results: AnswerAnalysis["output"]["results"],
  charts: AnswerAnalysis["output"]["charts"] = [],
): AnswerAnalysis => ({
  number: 1,
  title: "Revenue by region",
  language: "python",
  code: "result('by_region', …)",
  inputs: [
    {
      kind: "range",
      name: "sales",
      citation,
      range: "A1:B25",
      rows: 24,
      columns: 2,
      rowCount: 24,
      cut: false,
      sha256: "a".repeat(64),
    },
  ],
  versions: null,
  codeSha256: "b".repeat(64),
  outputSha256: "c".repeat(64),
  end: { kind: "done" },
  output: { ...noAnalysisOutput(), results, charts },
  ms: 1,
  ranAt: "2026-11-01T00:00:00.000Z",
  markers: { figures: [], tables: [{ result: "by_region", marker: 1 }], charts: [] },
});

const headingCitations = (block: NodeJSON): number =>
  countCitations((block.content?.[0]?.content ?? []).slice(1));

describe("an Analysis's table with its Citations (#2378)", () => {
  test("a table the Analysis gave has each numeric column citing the rows it read", () => {
    const rows = [
      ["North", 270.5],
      ["South", 80],
    ];
    const [cited] = withAnalysisTableCitations(
      [tableBlock(rows)],
      [
        analysis([
          {
            kind: "table",
            name: "by_region",
            label: "Revenue by region",
            unit: null,
            table: table(rows),
          },
        ]),
      ],
    );
    if (!cited) throw new Error("No table.");
    expect(headingCitations(cited)).toBe(1);
    const heading = cited.content?.[0]?.content?.[1]?.content?.[0]?.content ?? [];
    expect(heading.at(-1)).toEqual(
      expect.objectContaining({
        type: "citation",
        attrs: expect.objectContaining({ location: citation.location }),
      }),
    );
  });

  test("a chart's own table cites too, and a table unlike any the Analysis gave keeps none", () => {
    const rows = [
      ["North", 270.5],
      ["South", 80],
    ];
    const charted = withAnalysisTableCitations(
      [tableBlock(rows), tableBlock([["Hand", 1]])],
      [
        analysis(
          [],
          [{ kind: "bar", title: "Revenue", x: "Region", y: ["Revenue"], table: table(rows) }],
        ),
      ],
    );
    expect(charted[0] && headingCitations(charted[0])).toBe(1);
    expect(charted[1] && headingCitations(charted[1])).toBe(0);
  });
});
