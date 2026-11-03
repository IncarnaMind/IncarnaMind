import { describe, expect, test } from "vitest";
import { withAnalysisResults } from "../../src/core/analysis/markers";
import { markdownToBlocks } from "../../src/core/answers/markdown";
import type { AnswerAnalysis, Citation } from "../../src/core/api";
import { type AnalysisTable, noAnalysisOutput } from "../../src/shared/analysis";
import {
  analysisTableFor,
  analysisTablesOf,
  countCitations,
  withAnalysisTableCitations,
} from "../../src/shared/analysisTables";
import { citationNode, type NodeJSON } from "../../src/shared/blockJson";

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

  test("a table matches as it reads in Chinese too", () => {
    const rows = [
      ["North", 2590.7],
      ["South", 80],
    ];
    const made = analysis([
      {
        kind: "table",
        name: "by_region",
        label: "Revenue by region",
        unit: null,
        table: table(rows),
      },
    ]);
    const text = withAnalysisResults("各地区收入：\n\n[=table 1]", [made], "zh-CN");
    const blocks = markdownToBlocks(text);
    const cited = withAnalysisTableCitations(blocks, [made]);
    const tableBlock = cited.find((block) => block.type === "table");
    if (!tableBlock) throw new Error("No table.");
    expect(headingCitations(tableBlock)).toBe(1);
  });
});

describe("a table two Analyses could have given (#2378)", () => {
  const rows = [
    ["North", 270.5],
    ["South", 80],
  ];
  const result = {
    kind: "table" as const,
    name: "by_region",
    label: "Revenue by region",
    unit: null,
    table: table(rows),
  };
  const secondInput: AnswerAnalysis["inputs"][number] = {
    kind: "range",
    name: "other sales",
    citation: { ...citation, documentId: "d2", documentName: "Sales 2027" },
    range: "A1:B25",
    rows: 24,
    columns: 2,
    rowCount: 24,
    cut: false,
    sha256: "d".repeat(64),
  };

  test("is cited to neither when the Analyses read different Documents", () => {
    const first = analysis([result]);
    const second: AnswerAnalysis = {
      ...analysis([result]),
      number: 2,
      inputs: [secondInput],
    };
    expect(withAnalysisTableCitations([tableBlock(rows)], [first, second])[0]).toEqual(
      tableBlock(rows),
    );
  });

  test("is cited when one Analysis gives it twice with the same values and inputs", () => {
    const [cited] = withAnalysisTableCitations(
      [tableBlock(rows)],
      [
        analysis(
          [result],
          [{ kind: "bar", title: "Revenue", x: "Region", y: ["Revenue"], table: table(rows) }],
        ),
      ],
    );
    expect(cited && headingCitations(cited)).toBe(1);
  });

  test("matches no table whose own headings cite another version of the same place", () => {
    const rows = [
      ["North", 270.5],
      ["South", 80],
    ];
    const shown = tableBlock(rows);
    const cell = shown.content?.[0]?.content?.[0];
    if (!cell) throw new Error("No heading cell.");
    cell.content = [...(cell.content ?? []), citationNode({ ...citation, contentHash: "h2" })];
    expect(
      analysisTableFor(
        shown,
        analysisTablesOf([
          analysis([
            {
              kind: "table",
              name: "by_region",
              label: "Revenue by region",
              unit: null,
              table: table(rows),
            },
          ]),
        ]),
      ),
    ).toBeNull();
  });

  test("matches no table whose own headings cite another place of the same Document", () => {
    const rows = [
      ["North", 270.5],
      ["South", 80],
    ];
    const shown = tableBlock(rows);
    const cell = shown.content?.[0]?.content?.[0];
    if (!cell) throw new Error("No heading cell.");
    cell.content = [
      ...(cell.content ?? []),
      citationNode({
        ...citation,
        location: { kind: "rows", sheet: "Orders November", from: 1, to: 25 },
      }),
    ];
    expect(
      analysisTableFor(
        shown,
        analysisTablesOf([
          analysis([
            {
              kind: "table",
              name: "by_region",
              label: "Revenue by region",
              unit: null,
              table: table(rows),
            },
          ]),
        ]),
      ),
    ).toBeNull();
  });

  test("matches no table whose own headings cite another Document", () => {
    const rows = [
      ["North", 270.5],
      ["South", 80],
    ];
    const shown = tableBlock(rows);
    const cell = shown.content?.[0]?.content?.[0];
    if (!cell) throw new Error("No heading cell.");
    cell.content = [
      ...(cell.content ?? []),
      citationNode({ ...citation, documentId: "d9", documentName: "Orders October" }),
    ];
    expect(
      analysisTableFor(
        shown,
        analysisTablesOf([
          analysis([
            {
              kind: "table",
              name: "by_region",
              label: "Revenue by region",
              unit: null,
              table: table(rows),
            },
          ]),
        ]),
      ),
    ).toBeNull();
  });

  test("is cited to neither when they agree on the inputs and the display but not the values", () => {
    const shown = tableBlock([
      ["North", "8,325.44"],
      ["South", "80"],
    ]);
    const one = analysis([
      {
        ...result,
        table: table([
          ["North", 8325.444],
          ["South", 80],
        ]),
      },
    ]);
    const two = analysis([
      {
        ...result,
        table: table([
          ["North", 8325.4441],
          ["South", 80],
        ]),
      },
    ]);
    expect(analysisTableFor(shown, analysisTablesOf([one, two]))).toBeNull();
  });

  test("matches no Analysis that read nothing cited", () => {
    const readNothing: AnswerAnalysis = { ...analysis([result]), inputs: [] };
    expect(analysisTableFor(tableBlock(rows), analysisTablesOf([readNothing]))).toBeNull();
    expect(withAnalysisTableCitations([tableBlock(rows)], [readNothing])[0]).toEqual(
      tableBlock(rows),
    );
  });
});
