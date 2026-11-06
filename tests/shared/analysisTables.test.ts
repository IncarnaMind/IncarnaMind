import { describe, expect, test } from "vitest";
import { withAnalysisResults } from "../../src/core/analysis/markers";
import { markdownToBlocks } from "../../src/core/answers/markdown";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  type AnswerAnalysis,
  type Citation,
} from "../../src/core/api";
import {
  type AnalysisColumnRule,
  type AnalysisTable,
  noAnalysisOutput,
} from "../../src/shared/analysis";
import {
  type AnalysisTableMatch,
  analysisTableFor,
  analysisTableMatch,
  analysisTableShown,
  analysisTablesOf,
  captionMisnames,
  columnEarns,
  columnLine,
  holdsTableAgain,
  missingLine,
  withAnalysisTables,
} from "../../src/shared/analysisTables";
import { citationNode, type NodeJSON } from "../../src/shared/blockJson";
import { withoutChecks } from "../../src/shared/figureRuns";

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

const tableBlock = (
  rows: (string | number)[][],
  headings: readonly string[] = ["Region", "Revenue"],
): NodeJSON => ({
  type: "table",
  content: [
    { type: "tableRow", content: headings.map(cell) },
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

  test("a table that cites a Document's own lines is that Document's, never the Analysis's typed again", () => {
    const made = analysis([byRegion(rows)]);
    const typed = tableBlock(rows, ["Region", "Revenue"]);
    const [, first] = typed.content ?? [];
    const label = first?.content?.[0]?.content?.[0];
    label?.content?.push(citationNode(citation));
    expect(holdsTableAgain(typed, analysisTablesOf(runs(made))[0] as AnalysisTableMatch)).toBe(
      false,
    );
  });

  test("a table typed under other headings is never bound: its headings say what its numbers are", () => {
    const made = analysis([byRegion(rows)]);
    const typed = tableBlock(rows, ["Region", "Average revenue"]);
    expect(withAnalysisTables([typed], runs(made))).toEqual([typed]);
    expect(holdsTableAgain(typed, analysisTablesOf(runs(made))[0] as AnalysisTableMatch)).toBe(
      true,
    );
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

describe("a bound table reads as its run while the Note keeps the run's headings and rows (#2378)", () => {
  const binding = { id: "run-1", table: { result: "by_region" } };
  const kept = (given: (string | number)[][]) =>
    analysisTableMatch(
      binding,
      "Revenue by region",
      table(given),
      [citation],
      [
        {
          column: 1,
          rule: { input: "sales", key: "Region", value: "Revenue", how: "sum" },
          rows: 24,
        },
      ],
    );
  const bound = (block: NodeJSON): NodeJSON => ({
    ...block,
    attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: binding },
  });
  const shown = (block: NodeJSON, given = rows) =>
    analysisTableShown(bound(block), kept(given), "en", null);

  test("under the run's headings it is recalculated", () => {
    const read = shown(tableBlock(rows));
    expect(read.state.kind).toBe("recalculated");
    expect(read.columns.map((column) => columnLine(column, "en"))).toEqual([
      "Revenue: sum of 24 rows, by Region · recalculated",
    ]);
  });

  test("a column under a heading for another quantity keeps its line but never earns the ✓", () => {
    const gross = analysisTableShown(
      bound(tableBlock(rows)),
      analysisTableMatch(
        binding,
        "Revenue by region",
        table(rows),
        [citation],
        [
          {
            column: 1,
            rule: { input: "sales", key: "Region", value: "Gross", how: "sum" },
            rows: 24,
          },
        ],
      ),
      "en",
      null,
    );
    expect(gross.columns.map((column) => columnLine(column, "en"))).toEqual([
      "Revenue: sum of Gross over 24 rows, by Region · recalculated",
    ]);
    expect(gross.columns.map(columnEarns)).toEqual([false]);
    expect(gross.state.kind).toBe("calculated");
    expect(shown(tableBlock(rows)).columns.map(columnEarns)).toEqual([true]);
  });

  test("a caption naming another way of working it out keeps the column's line but takes the ✓ away", () => {
    const captioned = (caption: string) =>
      analysisTableShown(bound(tableBlock(rows)), kept(rows), "en", null, null, caption);
    for (const caption of [
      "Average revenue by region",
      "Highest revenue by region",
      "各地区平均收入",
      "Revenue by region (USD thousands)",
      "各地区收入（万元）",
    ]) {
      const read = captioned(caption);
      expect(read.state.kind, caption).toBe("calculated");
      expect(read.columns.map(columnEarns), caption).toEqual([false]);
      expect(read.columns.map((column) => columnLine(column, "en"))).toEqual([
        "Revenue: sum of 24 rows, by Region · recalculated",
      ]);
    }
    for (const caption of ["Revenue by region", "Total revenue by region", "各地区收入合计"])
      expect(captioned(caption).state.kind, caption).toBe("recalculated");
  });

  test("a caption that says its figures are other than the rules make them takes the ✓ away, failing closed", () => {
    const captioned = (caption: string) =>
      analysisTableShown(bound(tableBlock(rows)), kept(rows), "en", null, null, caption);
    for (const caption of [
      "Median revenue by region",
      "Revenue by region ($)",
      "Revenue by region (€)",
      "Revenue by region (%)",
      "Revenue by region ($k)",
      "Revenue by region (USD m)",
      "Revenue per order by region",
      "Revenue by region, 2025",
      "各地区收入中位数",
      "各地区收入（元）",
      "各地区收入（%）",
      "各地区收入（千美元）",
      "各地区每单收入",
      "2025年各地区收入",
      "Market share by region",
      "Revenue rate by region",
      "Revenue ratio by region",
      "Revenue proportion by region",
      "各地区收入占比",
      "各地区收入比例",
      "各地区市场份额",
      "各地区收入（万元）",
      "各地区收入，单位：千",
    ]) {
      const read = captioned(caption);
      expect(read.state.kind, caption).toBe("calculated");
      expect(read.columns.map(columnEarns), caption).toEqual([false]);
    }
    // A plain caption that names the table rightly keeps its ✓, in either language.
    for (const caption of [
      "Revenue by region",
      "Total revenue by region",
      "Revenue by region and store",
      "各地区收入",
      "各地区收入合计",
      // 千 and 万 inside a store's name are its name, not a scale.
      "万和路门店收入合计",
      "千禧街门店收入合计",
    ])
      expect(captioned(caption).state.kind, caption).toBe("recalculated");
    // A period the table itself holds is the table's own; one it doesn't is another figure.
    expect(captionMisnames("Revenue by region, 2025", "sum", "Region Revenue 2025")).toBe(false);
    expect(captionMisnames("Revenue by region, 2025", "sum", "Region Revenue")).toBe(true);
    // Average over an average column is its own word.
    expect(captionMisnames("Average revenue by region", "mean")).toBe(false);
    expect(captionMisnames("Average revenue by region", "sum")).toBe(true);
  });

  test("a heading the User renames, or a column they add, leaves it not recalculated", () => {
    const renamed = shown(tableBlock(rows, ["Region", "Average revenue"]));
    expect(renamed.state.kind).toBe("calculated");
    expect(renamed.columns.map((column) => columnLine(column, "en"))).toEqual([
      "Average revenue: from the Analysis · not recalculated",
    ]);
    const added = tableBlock(
      rows.map((row) => [...row, "90%"]),
      ["Region", "Revenue", "Share"],
    );
    expect(shown(added).state.kind).toBe("calculated");
  });

  test("a label the run gives twice pairs its rows in order, so the table as written differs from nothing", () => {
    const twice = [
      ["North", 100],
      ["North", 200],
      ["South", 80],
    ];
    const read = shown(tableBlock(twice), twice);
    expect(read.columns.flatMap((column) => column.differs)).toEqual([]);
    expect(read.state.kind).toBe("recalculated");
  });
});

describe("a column's line names what it was worked out from (#2378)", () => {
  const binding = { id: "run-1", table: { result: "by_region" } };
  const bound = (block: NodeJSON): NodeJSON => ({
    ...block,
    attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: binding },
  });
  const kept = (rule: AnalysisColumnRule, given = rows) =>
    analysisTableMatch(
      binding,
      "Revenue by region",
      table(given),
      [citation],
      [{ column: 1, rule, rows: 24 }],
    );
  const sum: AnalysisColumnRule = { input: "sales", key: "Region", value: "Revenue", how: "sum" };

  test.each([
    ["en", "Revenue: sum of 24 rows, by Region · recalculated"],
    ["zh-CN", "Revenue：按 Region 计算 24 行的合计 · 已重新计算"],
  ] as const)(
    "%s: under its own heading, the line counts the source rows and names the key",
    (language, line) => {
      const read = analysisTableShown(bound(tableBlock(rows)), kept(sum), language, null);
      expect(read.columns.map((column) => columnLine(column, language))).toEqual([line]);
    },
  );

  test.each([
    ["en", "Net: sum of Gross over 24 rows, by Region · recalculated"],
    ["zh-CN", "Net：按 Region 计算 24 行中 Gross 的合计 · 已重新计算"],
  ] as const)("%s: under another heading, the line names the input it sums", (language, line) => {
    const column = {
      column: 1,
      heading: "Net",
      rule: { ...sum, value: "Gross" },
      rows: 24,
      differs: [],
      footed: [],
    };
    expect(columnLine(column, language)).toBe(line);
  });

  test.each([
    ["en", "Revenue: from the Analysis · not recalculated"],
    ["zh-CN", "Revenue：来自数据分析 · 未重新计算"],
  ] as const)("%s: a count never reads recalculated, though its counts match", (language, line) => {
    const counted: AnalysisColumnRule = { ...sum, value: "Region", how: "count" };
    const read = analysisTableShown(bound(tableBlock(rows)), kept(counted), language, null);
    expect(read.state.kind).toBe("calculated");
    expect(read.columns.map((column) => columnLine(column, language))).toEqual([line]);
  });

  test.each([
    [
      "en",
      "1 row of the Analysis isn’t in the note",
      "2 rows of the Analysis aren’t in the note",
      "Revenue: from the Analysis · not recalculated",
    ],
    [
      "zh-CN",
      "数据分析中有 1 行不在笔记里",
      "数据分析中有 2 行不在笔记里",
      "Revenue：来自数据分析 · 未重新计算",
    ],
  ] as const)(
    "%s: rows the User deletes are named, and a table with none left is never recalculated, nor any of its columns",
    (language, one, two, unearned) => {
      const [north] = rows;
      const less = analysisTableShown(
        bound(tableBlock(north ? [north] : [])),
        kept(sum),
        language,
        null,
      );
      expect(less.state.kind).toBe("recalculated");
      expect(missingLine(less.missing, language)).toBe(one);
      const none = analysisTableShown(bound(tableBlock([])), kept(sum), language, null);
      expect(none.state.kind).toBe("calculated");
      expect(none.columns.map((column) => columnLine(column, language))).toEqual([unearned]);
      expect(missingLine(none.missing, language)).toBe(two);
    },
  );

  test("a row the User adds is footed only when it is a total, never a row the Analysis could have given", () => {
    const sumOf = rows.reduce((total, [, value]) => total + Number(value), 0);
    const footed = analysisTableShown(
      bound(tableBlock([...rows, ["Total", sumOf]])),
      kept(sum),
      "en",
      null,
    );
    expect(footed.columns[0]?.footed.map((each) => each.label)).toEqual(["Total"]);
    const detail = analysisTableShown(
      bound(tableBlock([...rows, ["East", sumOf]])),
      kept(sum),
      "en",
      null,
    );
    expect(detail.columns[0]?.footed).toEqual([]);
    expect(detail.columns[0]?.differs.map((each) => each.label)).toEqual(["East"]);
  });

  test("a clipboard's column rules are never read: a pasted table's columns are worked out again when its Analysis runs", () => {
    const record = {
      tables: [{ key: { result: "by_region" }, columns: [{ column: 1, rule: sum, rows: 24 }] }],
      values: [],
    };
    const [read] = withoutChecks([record]) as { tables: { columns: { rule: unknown }[] }[] }[];
    expect(read?.tables[0]?.columns.map((column) => column.rule)).toEqual([null]);
  });
});
