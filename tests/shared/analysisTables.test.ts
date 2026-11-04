import { describe, expect, test } from "vitest";
import { withAnalysisResults } from "../../src/core/analysis/markers";
import { markdownToBlocks } from "../../src/core/answers/markdown";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  type AnswerAnalysis,
  type Citation,
} from "../../src/core/api";
import { type AnalysisTable, noAnalysisOutput } from "../../src/shared/analysis";
import {
  analysisTableFor,
  analysisTablesOf,
  withAnalysisTables,
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

const runs = (...analyses: AnswerAnalysis[]) =>
  analyses.map((each) => ({ answerId: "answer-1", analysis: each }));

/** The binding a Block names, the table's or its caption marker's. */
const bindingOf = (block: NodeJSON | undefined) =>
  (block?.attrs?.[ANALYSIS_TABLE_ATTRIBUTE] ?? null) as { id: string; table: unknown } | null;

/** The tables of `blocks`, each with the caption line before it, as `withAnalysisTables` gives them. */
const captioned = (blocks: readonly NodeJSON[]) =>
  blocks.flatMap((block, at) => {
    if (block.type !== "table") return [];
    const before = blocks[at - 1]?.type === "paragraph" ? blocks[at - 1] : undefined;
    const marker = before?.content?.find((node) => node.type === ANALYSIS_TABLE_NODE);
    return [
      {
        table: bindingOf(block),
        caption: before?.content?.filter((node) => node.type === "text").map((node) => node.text),
        marker: bindingOf(marker),
      },
    ];
  });

const byRegion = (rows: (string | number)[][]) => ({
  kind: "table" as const,
  name: "by_region",
  label: "Revenue by region",
  unit: null,
  table: table(rows),
});

const rows = [
  ["North", 270.5],
  ["South", 80],
];

describe("an Analysis's table is one calculated object (#2378)", () => {
  test("a table the Analysis gave is bound to its run, under a caption ending with its marker", () => {
    const made = analysis([byRegion(rows)]);
    const blocks = withAnalysisTables([tableBlock(rows)], runs(made));
    const [shown] = captioned(blocks);
    expect(blocks).toHaveLength(2);
    expect(shown?.caption).toEqual(["Revenue by region"]);
    expect(shown?.table).toMatchObject({ table: { result: "by_region" } });
    expect(shown?.marker).toEqual(shown?.table);
    // Its cells stay text, and no heading carries a Citation of its own any more.
    expect(JSON.stringify(blocks[1])).not.toContain('"citation"');
  });

  test("a chart's own table is bound to that chart, and a table unlike any the Analysis gave is left as it is", () => {
    const made = analysis(
      [],
      [{ kind: "bar", title: "Revenue", x: "Region", y: ["Revenue"], table: table(rows) }],
    );
    const other = tableBlock([["Hand", 1]]);
    const blocks = withAnalysisTables([tableBlock(rows), other], runs(made));
    expect(captioned(blocks).map((each) => [each.caption, each.table?.table])).toEqual([
      [["Revenue"], { chart: 0 }],
      [undefined, undefined],
    ]);
    expect(blocks.at(-1)).toEqual(other);
  });

  test("a table matches as it reads in Chinese too", () => {
    const zh = [
      ["North", 2590.7],
      ["South", 80],
    ];
    const made = analysis([byRegion(zh)]);
    const text = withAnalysisResults("各地区收入：\n\n[=table 1]", [made], "zh-CN");
    const blocks = withAnalysisTables(markdownToBlocks(text), runs(made));
    expect(captioned(blocks).map((each) => each.table?.table)).toEqual([{ result: "by_region" }]);
  });

  test("a table already bound keeps its one caption", () => {
    const made = analysis([byRegion(rows)]);
    const once = withAnalysisTables([tableBlock(rows)], runs(made));
    expect(withAnalysisTables(once, runs(made))).toEqual(once);
  });
});

describe("each table goes in once (#2378)", () => {
  const made = analysis(
    [byRegion(rows)],
    [{ kind: "bar", title: "Revenue", x: "Region", y: ["Revenue"], table: table(rows) }],
  );
  made.markers.charts = [1];

  test.each(["en", "zh-CN"] as const)(
    "%s: a table marker written twice, and a chart marker whose table is there, give one table",
    (language) => {
      const text = withAnalysisResults(
        "## Totals\n\n[=table 1]\n\n## Chart\n\n[=chart 1]\n\n## Again\n\n[=table 1]",
        [made],
        language,
      );
      const tables = markdownToBlocks(text).filter((block) => block.type === "table");
      expect(tables).toHaveLength(1);
      expect(text).not.toContain("**Revenue**");
    },
  );

  test("a chart marker alone still writes its table", () => {
    const text = withAnalysisResults("[=chart 1]", [made], "en");
    expect(markdownToBlocks(text).filter((block) => block.type === "table")).toHaveLength(1);
  });
});

describe("a table two Analyses could have given (#2378)", () => {
  const result = byRegion(rows);
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

  test("is bound to neither when the Analyses read different Documents", () => {
    const first = analysis([result]);
    const second: AnswerAnalysis = { ...analysis([result]), number: 2, inputs: [secondInput] };
    expect(withAnalysisTables([tableBlock(rows)], runs(first, second))).toEqual([tableBlock(rows)]);
  });

  test("is bound when one Analysis gives it twice with the same values and inputs", () => {
    const made = analysis(
      [result],
      [{ kind: "bar", title: "Revenue", x: "Region", y: ["Revenue"], table: table(rows) }],
    );
    const blocks = withAnalysisTables([tableBlock(rows)], runs(made));
    expect(captioned(blocks).map((each) => each.table?.table)).toEqual([{ result: "by_region" }]);
  });

  test.each([
    ["another version of the same place", { ...citation, contentHash: "h2" }],
    [
      "another place of the same Document",
      {
        ...citation,
        location: { kind: "rows" as const, sheet: "Orders November", from: 1, to: 25 },
      },
    ],
    ["another Document", { ...citation, documentId: "d9", documentName: "Orders October" }],
  ])("matches no table whose own headings cite %s", (_, cited) => {
    const shown = tableBlock(rows);
    const cell = shown.content?.[0]?.content?.[0];
    if (!cell) throw new Error("No heading cell.");
    cell.content = [...(cell.content ?? []), citationNode(cited)];
    expect(analysisTableFor(shown, analysisTablesOf(runs(analysis([result]))))).toBeNull();
  });

  test("is bound to neither when they agree on the inputs and the display but not the values", () => {
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
    expect(analysisTableFor(shown, analysisTablesOf(runs(one, two)))).toBeNull();
  });

  test("matches no Analysis that read nothing cited", () => {
    const readNothing: AnswerAnalysis = { ...analysis([result]), inputs: [] };
    expect(analysisTableFor(tableBlock(rows), analysisTablesOf(runs(readNothing)))).toBeNull();
    expect(withAnalysisTables([tableBlock(rows)], runs(readNothing))).toEqual([tableBlock(rows)]);
  });
});
