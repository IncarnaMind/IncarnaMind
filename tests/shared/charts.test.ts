import { describe, expect, test } from "vitest";
import type { Citation, CitationAttributes } from "../../src/core";
import type { AnalysisTableMatch } from "../../src/shared/analysisTables";
import type { NodeJSON } from "../../src/shared/blockJson";
import {
  CATEGORY_COUNT,
  type ChartAttributes,
  canSwitch,
  chartCells,
  chartFromFigures,
  chartFromTable,
  chartPoints,
  chartSources,
  chosenSeries,
  drawnSeries,
  footCitations,
  gridOfTable,
  isNumericSeries,
  listedRows,
  MAX_CHART_VALUES,
  readChart,
  readChartData,
  redrawnData,
  type SourceCell,
  type SourceGrid,
  seriesName,
  sourceLineOf,
  switchedChart,
  switchedData,
  switchMixesUnits,
  unitGroups,
  unitlessRows,
  valueCitations,
  withAnalysisValues,
} from "../../src/shared/charts";

const cited = (page: number, quote = `Revenue on page ${page}`): CitationAttributes => ({
  passageId: "passage",
  documentId: "acme",
  documentName: "Acme Annual Report 2025",
  contentHash: "hash",
  pageFrom: page,
  pageTo: page,
  location: { kind: "page", from: page, to: page },
  quote,
  check: "found",
  checkReason: null,
});

const head = (text: string): SourceCell => ({ text, citation: null, header: true });
const cell = (text: string, citation: CitationAttributes | null = null): SourceCell => ({
  text,
  citation,
  header: false,
});

/** Revenue by quarter, two years, each figure cited but one. */
const QUARTERS: SourceGrid = [
  [head("Quarter"), head("2024"), head("2025")],
  [cell("Q1"), cell("289.4", cited(22)), cell("341.5", cited(22))],
  [cell("Q2"), cell("301.2", cited(22)), cell("362.0", cited(22))],
  [cell("Q3"), cell("309.8", cited(23)), cell("377.9", cited(23))],
  [cell("Q4"), cell("330.6", cited(23)), cell("401.2")],
];

const fromTable = (grid: SourceGrid, language = "en") =>
  chartFromTable(grid, { blockId: "table-1", title: "Revenue by quarter", language });

describe("a chart from a table", () => {
  test("takes the first column as its labels and each other column of numbers as a series", () => {
    const chart = fromTable(QUARTERS) as ChartAttributes;
    expect(chart.kind).toBe("bar");
    expect(chart.title).toBe("Revenue by quarter");
    expect(chart.source).toEqual({ kind: "table", blockId: "table-1" });
    expect(chart.data.labelHeading).toBe("Quarter");
    expect(chart.data.series).toEqual(["2024", "2025"]);
    expect(chart.data.rows.map((row) => row.label)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(chart.data.rows.map((row) => row.values.map((value) => value?.value))).toEqual([
      [289.4, 341.5],
      [301.2, 362],
      [309.8, 377.9],
      [330.6, 401.2],
    ]);
    expect(chart.data.cutFrom).toBeNull();
  });

  test("keeps each value's cell and the Citation in it, and marks a cell with none", () => {
    const chart = fromTable(QUARTERS) as ChartAttributes;
    const q3 = chart.data.rows[2]?.values[1];
    expect(q3?.shown).toBe("377.9");
    expect(q3?.from).toEqual({ kind: "cell", row: 3, column: 2 });
    expect(q3?.citation?.pageFrom).toBe(23);
    expect(q3?.citation?.quote).toBe("Revenue on page 23");
    const q4 = chart.data.rows[3]?.values[1];
    expect(q4?.from).toEqual({ kind: "cell", row: 4, column: 2 });
    expect(q4?.citation).toBeNull();
  });

  test("reads figures as written, in English and Chinese: scales, currencies, percents and brackets", () => {
    const chart = fromTable([
      [head("指标"), head("金额"), head("占比")],
      [cell("营业收入"), cell("1.5亿元", cited(4)), cell("41.2%")],
      [cell("净利润"), cell("(1,250)"), cell("约 3.5%")],
      [cell("其他"), cell("3,000万元"), cell("n/a")],
    ]) as ChartAttributes;
    const values = chart.data.rows.map((row) => row.values.map((value) => value?.value ?? null));
    expect(values[0]?.[0]).toBe(150_000_000);
    expect(values[0]?.[1]).toBeCloseTo(0.412);
    expect(values[1]?.[0]).toBe(-1250);
    expect(values[2]?.[0]).toBe(30_000_000);
    // Words, not a number: kept as written, not drawn.
    expect(chart.data.rows[2]?.values[1]?.shown).toBe("n/a");
    expect(values[2]?.[1]).toBeNull();
    expect(chart.data.rows[0]?.values[1]?.unit).toEqual({ kind: "percent" });
    const dollars = fromTable([
      [head("Item"), head("Amount")],
      [cell("Revenue"), cell("$1,482.6 million")],
      [cell("Cost"), cell("$1.2bn")],
    ]) as ChartAttributes;
    expect(dollars.data.rows.map((row) => row.values[0]?.value)).toEqual([
      1_482_600_000, 1_200_000_000,
    ]);
  });

  test("leaves out a column with no number, and treats a first row of words as its headings", () => {
    const chart = fromTable([
      [cell("Site"), cell("Rise (mm/yr)"), cell("Notes")],
      [cell("Harbour"), cell("4.1"), cell("Gauge on the pier")],
      [cell("Estuary"), cell("3.2"), cell("Since 1990")],
    ]) as ChartAttributes;
    expect(chart.data.labelHeading).toBe("Site");
    expect(chart.data.series).toEqual(["Rise (mm/yr)"]);
    expect(chart.data.rows[1]?.values[0]?.from).toEqual({ kind: "cell", row: 2, column: 1 });
  });

  test("with no heading row, every row is drawn and the series have no name", () => {
    const chart = fromTable([
      [cell("Harbour"), cell("4.1")],
      [cell("Estuary"), cell("3.2")],
    ]) as ChartAttributes;
    expect(chart.data.series).toEqual([""]);
    expect(chart.data.rows.map((row) => row.label)).toEqual(["Harbour", "Estuary"]);
  });

  test("a cell spanning down gives its label to each row, and its value only to the first", () => {
    const merged: SourceCell = { ...cell("North"), continued: true };
    const span: SourceCell = { ...cell("12"), continued: true };
    const chart = fromTable([
      [head("Region"), head("Sales")],
      [cell("North"), cell("12")],
      [merged, span],
    ]) as ChartAttributes;
    expect(chart.data.rows.map((row) => row.label)).toEqual(["North", "North"]);
    expect(chart.data.rows[1]?.values[0]).toBeNull();
  });

  test("is null when no column holds a number", () => {
    expect(
      fromTable([
        [head("Claim"), head("Where")],
        [cell("Spring tides"), cell("Documents")],
      ]),
    ).toBeNull();
  });

  test(`is cut at ${MAX_CHART_VALUES} values, and says how many rows the table had`, () => {
    const rows = Array.from({ length: 300 }, (_, index) => [
      cell(`Day ${index + 1}`),
      cell(String(index), cited(1)),
      cell(String(index * 2)),
    ]);
    const chart = fromTable([[head("Day"), head("A"), head("B")], ...rows]) as ChartAttributes;
    expect(chart.data.rows).toHaveLength(MAX_CHART_VALUES / 2);
    expect(chart.data.cutFrom).toBe(300);
    expect(chartPoints(chart).length).toBeLessThanOrEqual(MAX_CHART_VALUES);
    // The rest are kept to list, each with its cell and Citation, though never drawn (#503).
    expect(chart.data.cutRows).toHaveLength(50);
    expect(listedRows(chart.data)).toHaveLength(300);
    expect(listedRows(chart.data).at(-1)?.values[0]?.from).toEqual({
      kind: "cell",
      row: 300,
      column: 1,
    });
    expect(chartSources(chart).values).toBe(MAX_CHART_VALUES);
    // Stored and read back, they stay; with no cut, any are dropped.
    const stored = JSON.parse(JSON.stringify(chart)) as Record<string, unknown>;
    expect(readChart(stored).data.cutRows).toHaveLength(50);
    expect(
      readChartData({ ...chart.data, cutFrom: null, cutRows: chart.data.cutRows }).cutRows,
    ).toEqual([]);
  });
});

describe("a chart from cited figures", () => {
  test("charts each line's first figure, labelled with its words, with the line's Citation", () => {
    const chart = chartFromFigures(
      [
        { text: "Q1 2025: $341.5 million", citation: cited(22) },
        { text: "Q2 2025 – $362.0 million", citation: cited(22) },
        { text: "Nothing to count here.", citation: null },
        { text: "三季度营业收入 3.88亿元", citation: null },
      ],
      { title: "Revenue", language: "en" },
    ) as ChartAttributes;
    expect(chart.source).toEqual({ kind: "figures" });
    expect(chart.data.rows.map((row) => row.label)).toEqual([
      "Q1 2025",
      "Q2 2025",
      "三季度营业收入",
    ]);
    expect(chart.data.rows.map((row) => row.values[0]?.shown)).toEqual([
      "$341.5 million",
      "$362.0 million",
      "3.88亿元",
    ]);
    expect(chart.data.rows[0]?.values[0]?.citation?.pageFrom).toBe(22);
    expect(chart.data.rows[2]?.values[0]?.from).toEqual({ kind: "text", line: 3 });
    expect(chart.data.rows[2]?.values[0]?.citation).toBeNull();
  });

  test("is null when no line has a figure", () => {
    expect(
      chartFromFigures([{ text: "Spring tides happen at new moon.", citation: null }], {
        title: "",
        language: "en",
      }),
    ).toBeNull();
  });
});

describe("what a chart draws", () => {
  const chart = fromTable(QUARTERS) as ChartAttributes;

  test("its cells are the columns chosen, row by row, whatever is drawn of them", () => {
    const scatter: ChartAttributes = { ...chart, kind: "scatter" };
    const cells = chartCells(scatter);
    expect(cells.map((cell) => `${cell.row}:${cell.series}`).slice(0, 4)).toEqual([
      "0:0",
      "0:1",
      "1:0",
      "1:1",
    ]);
    expect(cells).toHaveLength(8);
  });

  test("a pie's are its one column's, the last chosen (#503)", () => {
    const pie: ChartAttributes = { ...chart, kind: "pie" };
    expect(chosenSeries(pie)).toEqual([1]);
    expect(chosenSeries({ ...pie, drawn: [0] })).toEqual([0]);
    expect(chartCells(pie).map((cell) => `${cell.row}:${cell.series}`)).toEqual([
      "0:1",
      "1:1",
      "2:1",
      "3:1",
    ]);
    // Back to bars, both columns are still chosen.
    expect(chosenSeries({ ...pie, kind: "bar" })).toEqual([0, 1]);
  });

  test("bars and lines draw the columns chosen, a pie the last, a scatter chart the first two", () => {
    expect(drawnSeries(chart)).toEqual([0, 1]);
    expect(drawnSeries({ ...chart, drawn: [1] })).toEqual([1]);
    expect(drawnSeries({ ...chart, kind: "pie" })).toEqual([1]);
    expect(drawnSeries({ ...chart, kind: "scatter" })).toEqual([0, 1]);
    expect(chartPoints({ ...chart, kind: "scatter" }).map((point) => point.row)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  test("its sources: the places quoted from, one Document, and the value with none", () => {
    const sources = chartSources(chart);
    expect(sources.values).toBe(8);
    expect(sources.uncited).toBe(1);
    expect(sources.documents).toBe(1);
    expect(sources.places.map((place) => [place.citation.pageFrom, place.count])).toEqual([
      [22, 4],
      [23, 3],
    ]);
  });

  test("a value an Analysis worked out is the Analysis's, never one with no Citation", () => {
    const analysed: ChartAttributes = {
      ...chart,
      data: {
        ...chart.data,
        rows: chart.data.rows.map((row) => ({
          ...row,
          values: row.values.map((value) =>
            !value || value.citation || value.citations || value.inputs
              ? value
              : { ...value, fromAnalysis: true as const },
          ),
        })),
      },
    };
    const sources = chartSources(analysed);
    expect([sources.values, sources.uncited, sources.analysis]).toEqual([8, 0, 1]);
    expect(sources.uncitedCells).toEqual([]);
  });

  test("the foot's check mark weighs quoted values' Citations, never an Analysis's values'", () => {
    const quoted = footCitations(chart);
    expect(quoted).toHaveLength(7);
    const fromAnalysis: ChartAttributes = {
      ...chart,
      data: {
        ...chart.data,
        rows: chart.data.rows.map((row, index) => ({
          ...row,
          values: row.values.map((value) =>
            value && index === 0 ? { ...value, fromAnalysis: true as const } : value,
          ),
        })),
      },
    };
    const cited = chart.data.rows[0]?.values.filter((value) => value?.citation).length ?? 0;
    expect(cited).toBeGreaterThan(0);
    expect(footCitations(fromAnalysis)).toHaveLength(quoted.length - cited);
  });

  test("its sources count every chosen cell for bars, lines and scatter, and a pie's one column", () => {
    const bar = chartSources(chart);
    const as = (kind: ChartAttributes["kind"], drawn = chart.drawn): ChartAttributes => ({
      ...chart,
      kind,
      drawn,
    });
    for (const kind of ["line", "scatter"] as const) {
      expect(chartSources(as(kind))).toEqual(bar);
    }
    // A scatter point is two cells: Q4 across (2024) is cited, up (2025) has none.
    const scatter = chartSources(as("scatter"));
    expect([scatter.values, scatter.uncited]).toEqual([8, 1]);
    // A pie of 2025 counts its four slices' cells, not 2024's (#503).
    const pie = chartSources(as("pie"));
    expect([pie.values, pie.uncited]).toEqual([4, 1]);
    expect(pie.places.map((place) => place.count)).toEqual([2, 1]);
    expect(chartSources(as("pie", [0])).uncited).toBe(0);
  });

  test("the values with no Citation, row by row, for the foot to find (#503)", () => {
    expect(chartSources(chart).uncitedCells).toEqual([{ row: 3, series: 1 }]);
    const none = fromTable([
      [head("Quarter"), head("2024"), head("2025")],
      [cell("Q1"), cell("289.4", cited(22)), cell("341.5")],
      [cell("Q2"), cell("301.2"), cell("362.0", cited(22))],
      [cell("Q3"), cell("309.8"), cell("377.9")],
    ]) as ChartAttributes;
    expect(chartSources(none).uncitedCells).toEqual([
      { row: 0, series: 1 },
      { row: 1, series: 0 },
      { row: 2, series: 0 },
      { row: 2, series: 1 },
    ]);
  });

  test("a place's footnote is its Citation whose quote wasn't found, if any", () => {
    const missing = { ...cited(23), check: "not-found" as const, quote: "Not there" };
    const grid: SourceGrid = [
      [head("Quarter"), head("2025")],
      [cell("Q3"), cell("377.9", cited(23))],
      [cell("Q4"), cell("401.2", missing)],
    ];
    const places = chartSources(fromTable(grid) as ChartAttributes).places;
    expect(places).toHaveLength(1);
    expect(places[0]?.citation.check).toBe("not-found");
  });

  test("reads back what a Mind stores, leaving out what is malformed rather than guessing", () => {
    const stored = JSON.parse(JSON.stringify(chart)) as Record<string, unknown>;
    expect(readChart(stored)).toEqual(chart);
    const broken = readChart({
      kind: "radar",
      title: 7,
      drawn: [1, 9, "x", 1],
      data: {
        labelHeading: "Quarter",
        series: ["2024", "2025"],
        rows: [{ label: "Q1", values: [{ shown: "1", value: "1", from: { kind: "cell" } }, null] }],
        cutFrom: 0,
      },
    });
    expect(broken.kind).toBe("bar");
    expect(broken.title).toBe("");
    expect(broken.drawn).toEqual([1]);
    expect(broken.data.rows[0]?.values).toEqual([null, null]);
    expect(broken.data.cutFrom).toBeNull();
    expect(broken.source).toEqual({ kind: "table", blockId: null });
  });
});

describe("a number with no unit (#579)", () => {
  /** Revenue in "$… million", and a fifth quarter typed in by hand without its unit. */
  const MILLIONS: SourceGrid = [
    [head("Quarter"), head("2024"), head("2025")],
    [cell("Q1"), cell("$289.4 million", cited(22)), cell("$341.5 million", cited(22))],
    [cell("Q2"), cell("$301.2 million", cited(22)), cell("$362.0 million", cited(22))],
    [cell("Q3"), cell("$309.8 million", cited(23)), cell("$377.9 million", cited(23))],
    [cell("Q4"), cell("$330.6 million", cited(23)), cell("$401.2 million", cited(23))],
    [cell("Q5"), cell(""), cell("120.0")],
  ];

  test("in a column of '$… million', isn't drawn, and the foot counts it apart", () => {
    const chart = { ...(fromTable(MILLIONS) as ChartAttributes), kind: "pie" as const };
    expect(chart.data.rows[4]?.values[1]).toMatchObject({
      value: 120,
      unit: { kind: "plain" },
      scale: 1,
    });
    expect(chart.data.rows[0]?.values[1]).toMatchObject({ value: 341_500_000, scale: 1e6 });
    expect([...unitlessRows(chart.data, 1)]).toEqual([4]);
    const slices = chartPoints(chart);
    expect(slices.map((point) => point.row)).toEqual([0, 1, 2, 3]);
    // It has no Citation either, but isn't counted as a value with none: it isn't drawn. The pie's
    // count is its column's four values (#503).
    expect(chartSources(chart)).toMatchObject({ values: 4, uncited: 0, notDrawn: 0, noUnit: 1 });
    const bars = chartPoints({ ...chart, kind: "bar" });
    expect(bars.some((point) => point.row === 4)).toBe(false);
  });

  test("a column of bare numbers, or one with different units, is drawn as it is", () => {
    const bare = fromTable(QUARTERS) as ChartAttributes;
    expect(chartPoints(bare)).toHaveLength(8);
    expect(chartSources(bare).noUnit).toBe(0);
    // A table of these isn't charted (`isNumericSeries`).
    const mixed = chartFromFigures(
      [
        { text: "Revenue: $1.2 million", citation: null },
        { text: "Margin: 41.2%", citation: null },
        { text: "Staff: 120", citation: null },
      ],
      { title: "", language: "en" },
    ) as ChartAttributes;
    expect(chartPoints(mixed)).toHaveLength(3);
  });

  test("a scale alone counts as a unit: '1.5亿' beside a bare '8000'", () => {
    const chart = fromTable(
      [
        [head("季度"), head("营业收入")],
        [cell("一季度"), cell("1.5亿")],
        [cell("二季度"), cell("1.8亿")],
        [cell("三季度"), cell("8000")],
      ],
      "zh-CN",
    ) as ChartAttributes;
    expect(chartPoints(chart).map((point) => point.row)).toEqual([0, 1]);
    expect(chartSources(chart).noUnit).toBe(1);
  });

  test("a scatter chart leaves out a row whose number across or up has no unit", () => {
    const chart = { ...(fromTable(MILLIONS) as ChartAttributes), kind: "scatter" as const };
    const grid = MILLIONS.map((row, index) =>
      index === 5 ? [cell("Q5"), cell("$310.0 million"), cell("120.0")] : row,
    );
    const both = { ...(fromTable(grid) as ChartAttributes), kind: "scatter" as const };
    expect(chartPoints(chart).map((point) => point.row)).toEqual([0, 1, 2, 3]);
    expect(chartPoints(both).map((point) => point.row)).toEqual([0, 1, 2, 3]);
  });

  test("a chart made before values kept their scale still leaves out a bare number beside a currency", () => {
    const made = fromTable(MILLIONS) as ChartAttributes;
    const stored = JSON.parse(JSON.stringify(made)) as {
      data: { rows: { values: ({ scale?: number } | null)[] }[] };
    };
    for (const row of stored.data.rows)
      for (const value of row.values) if (value) delete value.scale;
    const older = readChart(stored as unknown as Record<string, unknown>);
    expect(older.data.rows[0]?.values[1]?.scale).toBeNull();
    expect([...unitlessRows(older.data, 1)]).toEqual([4]);
  });
});

describe("series of different units (#1392)", () => {
  const MIXED: SourceGrid = [
    [head("Quarter"), head("Gross margin"), head("Net debt / EBITDA")],
    [cell("Q1"), cell("41.2%"), cell("2.8x")],
    [cell("Q2"), cell("42.0%"), cell("2.5x")],
  ];

  test("series that share a unit still share one chart", () => {
    expect(unitGroups(fromTable(QUARTERS) as ChartAttributes)).toEqual([
      { series: [0, 1], unit: null },
    ]);
    const dollars = fromTable([
      [head("Quarter"), head("2024"), head("2025")],
      [cell("Q1"), cell("$289.4 million"), cell("$341.5 million")],
      [cell("Q2"), cell("$301.2 million"), cell("$362.0 million")],
    ]) as ChartAttributes;
    expect(unitGroups(dollars)).toEqual([
      { series: [0, 1], unit: { kind: "currency", code: "USD" } },
    ]);
  });

  test("two units make two charts, each naming its unit", () => {
    expect(unitGroups(fromTable(MIXED) as ChartAttributes)).toEqual([
      { series: [0], unit: { kind: "percent" } },
      { series: [1], unit: { kind: "times" } },
    ]);
  });

  test("three units make a chart each", () => {
    const chart = fromTable([
      [head("Quarter"), head("Gross margin"), head("Leverage"), head("Revenue")],
      [cell("Q1"), cell("41.2%"), cell("2.8x"), cell("$1.2 million")],
      [cell("Q2"), cell("42.0%"), cell("2.5x"), cell("$1.4 million")],
    ]) as ChartAttributes;
    expect(unitGroups(chart)).toEqual([
      { series: [0], unit: { kind: "percent" } },
      { series: [1], unit: { kind: "times" } },
      { series: [2], unit: { kind: "currency", code: "USD" } },
    ]);
  });

  test("a pie or a scatter chart is one chart, its series read together", () => {
    const pie = { ...(fromTable(MIXED) as ChartAttributes), kind: "pie" as const };
    expect(unitGroups(pie)).toEqual([{ series: [1], unit: null }]);
    const scatter = { ...(fromTable(MIXED) as ChartAttributes), kind: "scatter" as const };
    expect(unitGroups(scatter)).toEqual([{ series: [0, 1], unit: null }]);
  });

  test("a switch that would draw a row's two units as one series can't be made", () => {
    const chart = fromTable(MIXED) as ChartAttributes;
    expect(canSwitch(chart)).toBe(false);
    expect(switchedChart(chart)).toBeNull();

    const sameUnit = fromTable(QUARTERS) as ChartAttributes;
    expect(canSwitch(sameUnit)).toBe(true);
  });

  test("says why a mixed-unit chart can't switch, and only that case", () => {
    expect(switchMixesUnits(fromTable(MIXED) as ChartAttributes)).toBe(true);
    expect(switchMixesUnits(fromTable(QUARTERS) as ChartAttributes)).toBe(false);
  });

  test("a chart already drawn as mixed series may still switch to one that keeps them apart", () => {
    const mixed = fromTable(MIXED) as ChartAttributes;
    const old = {
      ...mixed,
      data: switchedData(mixed.data) as ChartAttributes["data"],
      source: { kind: "table" as const, blockId: "table-1", switched: true },
    };
    expect(unitGroups(old)).toEqual([{ series: [0, 1], unit: null }]);
    expect(canSwitch(old)).toBe(true);
    const fixed = switchedChart(old);
    expect(fixed?.data.series).toEqual(["Gross margin", "Net debt / EBITDA"]);
    expect(unitGroups({ ...old, ...fixed } as ChartAttributes)).toEqual([
      { series: [0], unit: { kind: "percent" } },
      { series: [1], unit: { kind: "times" } },
    ]);
  });
});

interface Words {
  head: readonly string[];
  rows: readonly (readonly string[])[];
}

const tableChart = (table: Words, language: string): ChartAttributes =>
  fromTable(
    [table.head.map(head), ...table.rows.map((row) => row.map((text) => cell(text)))],
    language,
  ) as ChartAttributes;

const drawnOf = (chart: ChartAttributes) => chartPoints(chart).map((point) => point.value.value);

const panelUnits = (chart: ChartAttributes) =>
  unitGroups(chart).map((group) => group.unit?.kind ?? null);

interface SwitchCase {
  name: string;
  en: Words;
  zh: Words;
  /** What the chart draws as it stands, and each panel's unit. */
  before: { drawn: number[]; panels: (string | null)[] };
  /** What the Switch would draw; null when it is refused and nothing changes. */
  after: { drawn: number[]; panels: (string | null)[] } | null;
}

const PERCENT_AND_BARE: SwitchCase = {
  name: "a percent beside a bare number",
  en: { head: ["Metric", "Margin", "Leverage"], rows: [["Q1", "41.2%", "2.8"]] },
  zh: { head: ["指标", "毛利率", "杠杆"], rows: [["一季度", "41.2%", "2.8"]] },
  before: { drawn: [0.412, 2.8], panels: ["percent", null] },
  after: null,
};

/**
 * A Switch is decided on every value a row would draw (#1392): a row whose
 * numbers don't share one unit refuses it, a bare number counting as its own.
 * Each case runs in English and Simplified Chinese, the same table and answer.
 */
const SWITCH_CASES: readonly SwitchCase[] = [
  PERCENT_AND_BARE,
  {
    name: "bare numbers outnumbering their column's unit",
    en: {
      head: ["Metric", "Margin", "Leverage"],
      rows: [
        ["Q1", "41.2%", "2.8"],
        ["Q2", "39.0", "3.1"],
        ["Q3", "38.1", "3.4"],
      ],
    },
    zh: {
      head: ["指标", "毛利率", "杠杆"],
      rows: [
        ["一季度", "41.2%", "2.8"],
        ["二季度", "39.0", "3.1"],
        ["三季度", "38.1", "3.4"],
      ],
    },
    before: { drawn: [0.412, 39, 38.1, 2.8, 3.1, 3.4], panels: ["percent", null] },
    after: null,
  },
  {
    name: "a percent beside times",
    en: { head: ["Metric", "Margin", "Leverage"], rows: [["Q1", "41.2%", "2.8 times"]] },
    zh: { head: ["指标", "毛利率", "杠杆"], rows: [["一季度", "41.2%", "2.8倍"]] },
    before: { drawn: [0.412, 2.8], panels: ["percent", "times"] },
    after: null,
  },
  {
    name: "a percent beside percentage points",
    en: {
      head: ["Metric", "Margin", "Change"],
      rows: [["Q1", "41.2%", "2.8 percentage points"]],
    },
    zh: {
      head: ["指标", "毛利率", "变动"],
      rows: [["一季度", "41.2%", "2.8个百分点"]],
    },
    before: { drawn: [0.412, 0.028], panels: ["percent", "points"] },
    after: null,
  },
  {
    name: "a percent beside a percent",
    en: {
      head: ["Metric", "Margin", "Forward margin"],
      rows: [["Q1", "41.2%", "42.0%"]],
    },
    zh: { head: ["指标", "毛利率", "预测毛利率"], rows: [["一季度", "41.2%", "42.0%"]] },
    before: { drawn: [0.412, 0.42], panels: ["percent"] },
    after: { drawn: [0.412, 0.42], panels: ["percent"] },
  },
  {
    name: "bare numbers only",
    en: { head: ["Metric", "Margin", "Leverage"], rows: [["Q1", "2.8", "3.1"]] },
    zh: { head: ["指标", "毛利率", "杠杆"], rows: [["一季度", "2.8", "3.1"]] },
    before: { drawn: [2.8, 3.1], panels: [null] },
    after: { drawn: [2.8, 3.1], panels: [null] },
  },
  {
    name: "one currency in two scales",
    en: {
      head: ["Metric", "Revenue", "Cost"],
      rows: [["Q1", "$289.4 million", "$341.5"]],
    },
    zh: { head: ["指标", "营业收入", "成本"], rows: [["一季度", "$289.4 million", "$341.5"]] },
    before: { drawn: [289_400_000, 341.5], panels: ["currency"] },
    after: { drawn: [289_400_000, 341.5], panels: ["currency"] },
  },
];

for (const { name, en, zh, before, after } of SWITCH_CASES) {
  for (const [language, table] of [
    ["en", en],
    ["zh-CN", zh],
  ] as const) {
    test(`${language}: ${name} decides the Switch on every value the row would draw`, () => {
      const chart = tableChart(table, language);
      expect(drawnOf(chart)).toEqual(before.drawn);
      expect(panelUnits(chart)).toEqual(before.panels);

      expect(switchMixesUnits(chart)).toBe(after === null);
      expect(canSwitch(chart)).toBe(after !== null);
      expect(switchedChart(chart) === null).toBe(after === null);
      if (after === null) return;

      const switched = switchedChart(chart);
      expect(switched).not.toBeNull();
      if (!switched) return;
      const afterChart: ChartAttributes = { ...chart, ...switched };
      expect(drawnOf(afterChart)).toEqual(after.drawn);
      expect(panelUnits(afterChart)).toEqual(after.panels);
      // An allowed Switch draws every value the rows hold: none is left out for want of a unit.
      const hidden = afterChart.data.series.flatMap((_, series) => [
        ...unitlessRows(afterChart.data, series),
      ]);
      expect(hidden).toEqual([]);
    });
  }
}

for (const [language, table] of [
  ["en", PERCENT_AND_BARE.en],
  ["zh-CN", PERCENT_AND_BARE.zh],
] as const) {
  test(`${language}: a chart already stored as the mixed series still switches back to one chart per unit`, () => {
    const chart = tableChart(table, language);
    const stored: ChartAttributes = {
      ...chart,
      data: switchedData(chart.data) as ChartAttributes["data"],
      source: { kind: "table", blockId: "table-1", switched: true },
    };
    expect(canSwitch(stored)).toBe(true);
    const back = switchedChart(stored);
    expect(back).not.toBeNull();
    if (!back) return;
    expect(drawnOf({ ...stored, ...back })).toEqual([0.412, 2.8]);
    expect(panelUnits({ ...stored, ...back })).toEqual(["percent", null]);
  });
}

const YEARS_BY_METRICS: SourceGrid = [
  [head("Metric"), head("2023"), head("2024"), head("2025")],
  [cell("Revenue", cited(22)), cell("289.4", cited(22)), cell("301.2"), cell("330.6")],
  [cell("Net income"), cell("41.2"), cell("45.0"), cell("52.3")],
];

describe("which way round a chart from a table goes", () => {
  test("puts the years on the x axis when they run across the table, and the metrics are the series", () => {
    const chart = fromTable(YEARS_BY_METRICS) as ChartAttributes;
    expect(chart.source).toEqual({ kind: "table", blockId: "table-1", switched: true });
    expect(chart.data.labelHeading).toBe("");
    expect(chart.data.series).toEqual(["Revenue", "Net income"]);
    expect(chart.data.rows.map((row) => row.label)).toEqual(["2023", "2024", "2025"]);
    expect(chart.data.rows.map((row) => row.values.map((value) => value?.value))).toEqual([
      [289.4, 41.2],
      [301.2, 45],
      [330.6, 52.3],
    ]);
    expect(chart.data.rows[1]?.values[1]?.from).toEqual({ kind: "cell", row: 2, column: 2 });
    expect(chart.data.rows[0]?.values[0]?.citation?.pageFrom).toBe(22);
    expect(chart.data.cutFrom).toBeNull();
  });

  test("keeps the years on the rows when they run down the table", () => {
    const chart = fromTable([
      [head("Year"), head("Revenue"), head("Net income")],
      [cell("2023"), cell("289.4"), cell("41.2")],
      [cell("2024"), cell("301.2"), cell("45.0")],
    ]) as ChartAttributes;
    expect(chart.source).toEqual({ kind: "table", blockId: "table-1" });
    expect(chart.data.series).toEqual(["Revenue", "Net income"]);
    expect(chart.data.rows.map((row) => row.label)).toEqual(["2023", "2024"]);
  });

  test("quarters, months and dates are periods too", () => {
    for (const periods of [
      ["Q1 2025", "Q2 2025", "Q3 2025"],
      ["2025Q1", "2025Q2", "2025Q3"],
      ["FY2023", "FY2024", "FY2025"],
      ["Jan 2025", "Feb 2025", "Mar 2025"],
      ["2025-01-31", "2025-02-28", "2025-03-31"],
    ]) {
      const chart = fromTable([
        [head("Metric"), ...periods.map(head)],
        [cell("Revenue"), cell("1.5"), cell("2.5"), cell("3.5")],
        [cell("Cost"), cell("1.0"), cell("1.2"), cell("1.4")],
      ]) as ChartAttributes;
      expect(chart.data.rows.map((row) => row.label)).toEqual(periods);
      expect(chart.data.series).toEqual(["Revenue", "Cost"]);
    }
  });

  test("in Chinese: 2024年, 2024年第一季度, 一季度", () => {
    for (const periods of [
      ["2023年", "2024年", "2025年"],
      ["2024年第一季度", "2024年第二季度", "2024年第三季度"],
      ["一季度", "二季度", "三季度"],
      ["第一季度", "第二季度", "第三季度"],
    ]) {
      const chart = fromTable([
        [head("指标"), ...periods.map(head)],
        [cell("营业收入"), cell("1.5亿元"), cell("2.5亿元"), cell("3.5亿元")],
        [cell("净利润"), cell("0.2亿元"), cell("0.3亿元"), cell("0.4亿元")],
      ]) as ChartAttributes;
      expect(chart.source).toMatchObject({ switched: true });
      expect(chart.data.rows.map((row) => row.label)).toEqual(periods);
      expect(chart.data.series).toEqual(["营业收入", "净利润"]);
      expect(chart.data.rows[0]?.values[0]?.value).toBe(150_000_000);
    }
  });

  test("leaves a note or a total beside the years as it is, and a column of words out", () => {
    const chart = fromTable([
      [head("Metric"), head("2023"), head("2024"), head("Notes")],
      [cell("Revenue"), cell("289.4"), cell("301.2"), cell("restated")],
      [cell("Net income"), cell("41.2"), cell("45.0"), cell("")],
    ]) as ChartAttributes;
    expect(chart.source).toMatchObject({ switched: true });
    expect(chart.data.rows.map((row) => row.label)).toEqual(["2023", "2024"]);
  });

  test("a row with no number is not a series", () => {
    const chart = fromTable([
      [head("Metric"), head("2023"), head("2024")],
      [cell("Revenue"), cell("289.4"), cell("301.2")],
      [cell("Operating costs:"), cell(""), cell("")],
      [cell("Rent"), cell("12.0"), cell("13.5")],
    ]) as ChartAttributes;
    expect(chart.data.series).toEqual(["Revenue", "Rent"]);
  });

  test("keeps today's way round when both the first row and the first column hold periods, or neither does", () => {
    const both = fromTable(QUARTERS) as ChartAttributes;
    expect(both.source).toEqual({ kind: "table", blockId: "table-1" });
    expect(both.data.series).toEqual(["2024", "2025"]);
    expect(both.data.rows.map((row) => row.label)).toEqual(["Q1", "Q2", "Q3", "Q4"]);

    const neither = fromTable([
      [head("Segment"), head("Revenue"), head("Margin")],
      [cell("Cloud"), cell("120"), cell("31%")],
      [cell("Devices"), cell("80"), cell("22%")],
    ]) as ChartAttributes;
    expect(neither.source).toEqual({ kind: "table", blockId: "table-1" });
    expect(neither.data.rows.map((row) => row.label)).toEqual(["Cloud", "Devices"]);
  });

  test("keeps the rows as the labels when they are more series than the key tells apart", () => {
    const metrics = (count: number): SourceGrid => [
      [head("Metric"), head("2024"), head("2025")],
      ...Array.from({ length: count }, (_, index) => [
        cell(`Metric ${index + 1}`),
        cell(String(index + 1)),
        cell(String(index + 2)),
      ]),
    ];
    expect(fromTable(metrics(CATEGORY_COUNT))?.source).toMatchObject({ switched: true });
    const many = fromTable(metrics(CATEGORY_COUNT + 1)) as ChartAttributes;
    expect(many.source).toEqual({ kind: "table", blockId: "table-1" });
    expect(many.data.series).toEqual(["2024", "2025"]);
  });

  test("goes the way it is told, whatever the periods say", () => {
    const options = { blockId: "table-1", title: "", language: "en" };
    const down = chartFromTable(YEARS_BY_METRICS, { ...options, switched: false });
    expect(down?.source).toEqual({ kind: "table", blockId: "table-1" });
    expect(down?.data.series).toEqual(["2023", "2024", "2025"]);
    const across = chartFromTable(QUARTERS, { ...options, switched: true });
    expect(across?.data.rows.map((row) => row.label)).toEqual(["2024", "2025"]);
    expect(across?.data.series).toEqual(["Q1", "Q2", "Q3", "Q4"]);
  });

  test("is cut at the values that fit, whichever way round", () => {
    const years = Array.from({ length: 300 }, (_, index) => String(1900 + index));
    const chart = fromTable([
      [head("Metric"), ...years.map(head)],
      [cell("A"), ...years.map((_, index) => cell(String(index)))],
      [cell("B"), ...years.map((_, index) => cell(String(index * 2)))],
    ]) as ChartAttributes;
    expect(chart.source).toMatchObject({ switched: true });
    expect(chart.data.rows).toHaveLength(MAX_CHART_VALUES / 2);
    expect(chart.data.cutFrom).toBe(300);
    expect(listedRows(chart.data)).toHaveLength(300);
  });
});

describe("a bare number that looks like a year, in a table's body (#1131)", () => {
  const rows = (...lines: string[][]): SourceGrid =>
    lines.map((line, index) => line.map((text) => (index === 0 ? head(text) : cell(text))));
  const valuesOf = (chart: ChartAttributes | null) =>
    chart?.data.rows.map((row) => row.values.map((value) => value?.value ?? null));

  test("is a value when its column is a quantity: 2000 units sold is drawn with 1899 and 2100", () => {
    const chart = fromTable(
      rows(["Product", "Units sold"], ["A", "1899"], ["B", "2000"], ["C", "2100"]),
    );
    expect(valuesOf(chart)).toEqual([[1899], [2000], [2100]]);
    expect(chartPoints(chart as ChartAttributes).map((point) => point.value.value)).toEqual([
      1899, 2000, 2100,
    ]);
    expect(chartSources(chart as ChartAttributes).notDrawn).toBe(0);
  });

  const HEADINGS: readonly [string, string, string][] = [
    ["en", "Units sold", "Revenue"],
    ["zh-CN", "销量", "收入"],
  ];
  const cases = HEADINGS.flatMap(([language, ...headings]) =>
    headings.flatMap((heading) =>
      ["1999", "2000", "2099"].map((value) => [language, heading, value] as const),
    ),
  );
  test.each(cases)(
    "%s: %s of %s sits between 1899 and 2100 and is drawn",
    (language, heading, value) => {
      const chart = fromTable(
        rows(["Product", heading], ["A", "1899"], ["B", value], ["C", "2100"]),
        language,
      );
      expect(valuesOf(chart)).toEqual([[1899], [Number(value)], [2100]]);
      expect(chartPoints(chart as ChartAttributes)).toHaveLength(3);
      expect(chartSources(chart as ChartAttributes).notDrawn).toBe(0);
    },
  );

  test("is a value when the header says quantity, even beside other years", () => {
    const chart = fromTable(rows(["Product", "Units sold"], ["A", "2000"], ["B", "2001"]));
    expect(valuesOf(chart)).toEqual([[2000], [2001]]);
    expect(
      valuesOf(fromTable(rows(["产品", "销量"], ["A", "2000"], ["B", "2001"]), "zh-CN")),
    ).toEqual([[2000], [2001]]);
  });

  test("is a value under a period heading when the periods run across the table", () => {
    const chart = fromTable(
      rows(["Metric", "2023", "2024", "2025"], ["Units sold", "1899", "2000", "2100"]),
    ) as ChartAttributes;
    expect(chart.source).toMatchObject({ switched: true });
    expect(valuesOf(chart)).toEqual([[1899], [2000], [2100]]);
    expect(chartPoints(chart)).toHaveLength(3);
  });

  test("stays a value when written with a currency", () => {
    const chart = fromTable(
      rows(["Product", "Revenue"], ["A", "$1999"], ["B", "$2000"], ["C", "$2099"]),
    );
    expect(valuesOf(chart)).toEqual([[1999], [2000], [2099]]);
  });

  test("is a label in a column of years: a Year column, or one that holds nothing else", () => {
    for (const heading of ["Year", "Founded", "年份"]) {
      const chart = fromTable(
        rows(["Company", heading, "Employees"], ["A", "1999", "150"], ["B", "2005", "40"]),
      ) as ChartAttributes;
      expect(chart.data.series).toEqual(["Employees"]);
    }
    const bare = fromTable(
      rows(["Company", "Listed", "Employees"], ["A", "1999", "150"], ["B", "2005", "40"]),
    ) as ChartAttributes;
    expect(bare.data.series).toEqual(["Employees"]);
  });

  test("is still a label in the first column, and a heading when the years run across", () => {
    const down = fromTable(
      rows(["Year", "Revenue", "Net income"], ["2023", "289.4", "41.2"], ["2024", "301.2", "45.0"]),
    ) as ChartAttributes;
    expect(down.data.rows.map((row) => row.label)).toEqual(["2023", "2024"]);
    expect(down.data.series).toEqual(["Revenue", "Net income"]);
    const across = fromTable(
      rows(["Metric", "2023", "2024", "2025"], ["Revenue", "289.4", "301.2", "340.1"]),
    ) as ChartAttributes;
    expect(across.data.rows.map((row) => row.label)).toEqual(["2023", "2024", "2025"]);
  });
});

describe("a table that is a series of numbers", () => {
  const rows = (...lines: string[][]): SourceGrid =>
    lines.map((line, index) => line.map((text) => (index === 0 ? head(text) : cell(text))));

  test("is one with mostly figures in its body, notes beside them or not", () => {
    expect(isNumericSeries(QUARTERS, "en")).toBe(true);
    expect(isNumericSeries(YEARS_BY_METRICS, "en")).toBe(true);
    expect(
      isNumericSeries(
        rows(
          ["Site", "Rise (mm/yr)", "Notes"],
          ["Harbour", "4.1", "Gauge on the pier"],
          ["Estuary", "3.2", "Since 1990"],
        ),
        "en",
      ),
    ).toBe(true);
    expect(
      isNumericSeries(
        rows(
          ["指标", "2024年", "2025年", "备注"],
          ["营业收入", "1.5亿元", "1.8亿元", "含并表"],
          ["净利润", "(1,250)", "约 3.5%", ""],
        ),
        "zh-CN",
      ),
    ).toBe(true);
  });

  test("with dashes and n/a counting for nothing", () => {
    expect(
      isNumericSeries(
        rows(["Metric", "2024", "2025"], ["Revenue", "—", "12"], ["Cost", "n/a", "-"]),
        "en",
      ),
    ).toBe(true);
  });

  test("is not a calculation's working table, with its formulas, steps in words and several units", () => {
    for (const grid of [
      rows(
        ["Step", "Formula", "Result"],
        ["Revenue growth", "(377.9 − 330.6) ÷ 330.6", "14.3%"],
        ["Gross margin", "138.2 ÷ 377.9", "36.6%"],
        ["Net margin", "41.2 / 377.9", "10.9%"],
      ),
      rows(
        ["Item", "Calculation", "Inputs", "Result"],
        ["Growth", "(B − A) / A", "A = 330.6, B = 377.9", "14.3%"],
        ["Margin", "profit / revenue", "41.2 and 377.9", "10.9%"],
      ),
      rows(
        ["Item", "How it was worked out", "Result"],
        ["Growth", "Take 377.9 less last year's 330.6, then divide by 330.6", "14.3%"],
        ["Weight", "10 kg + 5 lb", "14.3 kg"],
      ),
      rows(["Item", "Value"], ["Load", "10 kg + 5 lb"], ["Cost", "$12 × 3 kg"], ["Total", "$36"]),
    ]) {
      expect(isNumericSeries(grid, "en")).toBe(false);
    }
    for (const grid of [
      rows(
        ["步骤", "公式", "结果"],
        ["营业收入同比", "(377.9 − 330.6) ÷ 330.6", "14.3%"],
        ["毛利率", "138.2 ÷ 377.9", "36.6%"],
      ),
      rows(
        ["项目", "计算过程", "结果"],
        ["同比增长", "用本年的 377.9 减去上年的 330.6，再除以 330.6", "14.3%"],
        ["净利率", "41.2 除以 377.9", "10.9%"],
      ),
    ]) {
      expect(isNumericSeries(grid, "zh-CN")).toBe(false);
    }
  });

  test("measures one thing down each column, or along each row: years by metrics in $ and %", () => {
    expect(
      isNumericSeries(
        rows(
          ["Metric", "FY2024", "FY2025"],
          ["Revenue", "$330.6m", "$377.9m"],
          ["Gross margin", "35.1%", "36.6%"],
          ["Headcount", "1,150", "1,200"],
        ),
        "en",
      ),
    ).toBe(true);
    expect(
      isNumericSeries(
        rows(
          ["Quarter", "Revenue", "Margin"],
          ["Q1", "$289.4m", "14.2%"],
          ["Q2", "$301.2m", "14.9%"],
        ),
        "en",
      ),
    ).toBe(true);
  });

  test("doesn't take a bare number among numbers in one unit for a mix: it isn't drawn (#579)", () => {
    expect(
      isNumericSeries(
        rows(
          ["Quarter", "Revenue"],
          ["Q1", "$331.2 million"],
          ["Q2", "$340 million"],
          ["Q3", "120"],
        ),
        "en",
      ),
    ).toBe(true);
  });

  test("is not a working table of figures in assorted units, in one column or across and down", () => {
    for (const grid of [
      rows(
        ["Item", "Value"],
        ["FY2025 revenue", "$377.9m"],
        ["FY2024 revenue", "$330.6m"],
        ["Growth", "14.3%"],
      ),
      rows(
        ["Item", "Value"],
        ["FY2025 revenue", "377.9"],
        ["FY2024 revenue", "330.6"],
        ["Growth", "14.3%"],
      ),
      rows(
        ["Item", "Before", "After"],
        ["Revenue", "$330.6m", "14.3%"],
        ["Margin", "10.9%", "$41.2m"],
      ),
    ]) {
      expect(isNumericSeries(grid, "en")).toBe(false);
    }
    expect(
      isNumericSeries(
        rows(
          ["项目", "数值"],
          ["2025年营业收入", "3.78亿元"],
          ["2024年营业收入", "3.31亿元"],
          ["同比增长", "14.3%"],
        ),
        "zh-CN",
      ),
    ).toBe(false);
  });

  test("is not a table of words, or of one cell with no number", () => {
    expect(
      isNumericSeries(
        rows(["Claim", "Where"], ["Spring tides", "Documents"], ["Neap tides", "Notes"]),
        "en",
      ),
    ).toBe(false);
    expect(
      isNumericSeries(
        rows(["Company", "HQ", "Founded"], ["Acme", "Oslo", "see note"], ["Beta", "Rome", "n/a"]),
        "en",
      ),
    ).toBe(false);
    expect(isNumericSeries([], "en")).toBe(false);
    expect(isNumericSeries(rows(["A", "B"]), "en")).toBe(false);
  });

  test("so no chart is made of a table that is not one", () => {
    expect(
      fromTable(
        rows(
          ["Step", "Formula", "Result"],
          ["Growth", "(377.9 − 330.6) ÷ 330.6", "14.3%"],
          ["Margin", "138.2 ÷ 377.9", "36.6%"],
        ),
      ),
    ).toBeNull();
  });
});

describe("switching a chart's rows and columns", () => {
  const made = () => fromTable(QUARTERS) as ChartAttributes;

  test("makes the series the rows, and the rows the series, each value where it was", () => {
    const chart = made();
    const data = switchedData(chart.data);
    expect(data?.series).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(data?.rows.map((row) => row.label)).toEqual(["2024", "2025"]);
    expect(data?.rows[1]?.values[2]?.shown).toBe("377.9");
    expect(data?.rows[1]?.values[2]?.from).toEqual({ kind: "cell", row: 3, column: 2 });
    expect(data?.labelHeading).toBe("");
  });

  test("switched twice holds what it held, with no heading over its labels", () => {
    const chart = made();
    const once = switchedData(chart.data);
    expect(switchedData(once as ChartAttributes["data"])).toEqual({
      ...chart.data,
      labelHeading: "",
    });
  });

  test("is what a chart made the other way round from the same table holds", () => {
    const options = { blockId: "table-1", title: "", language: "en" };
    const across = chartFromTable(QUARTERS, { ...options, switched: true });
    expect(switchedData(made().data)).toEqual(across?.data);
    const down = chartFromTable(YEARS_BY_METRICS, { ...options, switched: false });
    expect(switchedData(fromTable(YEARS_BY_METRICS)?.data as ChartAttributes["data"])).toEqual({
      ...down?.data,
      labelHeading: "",
    });
  });

  test("remembers it was switched, draws every column again, and switches back", () => {
    const chart = { ...made(), kind: "line" as const, drawn: [1] };
    const switched = switchedChart(chart);
    expect(switched?.source).toEqual({ kind: "table", blockId: "table-1", switched: true });
    expect(switched?.drawn).toBeNull();
    expect(switched?.kind).toBe("line");
    const back = switchedChart({ ...chart, ...switched } as ChartAttributes);
    expect(back?.source).toEqual({ kind: "table", blockId: "table-1" });
    expect(back?.data).toEqual({ ...chart.data, labelHeading: "" });
  });

  test("a scatter chart stays one if the new series can draw it, and becomes a bar chart if not", () => {
    const oneRow = fromTable([
      [head("Segment"), head("Revenue"), head("Margin")],
      [cell("Cloud"), cell("120"), cell("31")],
    ]) as ChartAttributes;
    expect(switchedChart({ ...oneRow, kind: "scatter" })?.kind).toBe("bar");
    const threeRows = fromTable([
      [head("Segment"), head("Revenue"), head("Margin")],
      [cell("Cloud"), cell("120"), cell("31")],
      [cell("Devices"), cell("80"), cell("22")],
      [cell("Services"), cell("60"), cell("40")],
    ]) as ChartAttributes;
    const switched = switchedChart({ ...threeRows, kind: "scatter" });
    expect(switched?.kind).toBe("scatter");
    expect(switched?.data.series).toEqual(["Cloud", "Devices", "Services"]);
  });

  test("can't be done to figures from text, a single value, or a chart cut to fit", () => {
    const figures = chartFromFigures([{ text: "Q1: 289.4", citation: null }], {
      title: "",
      language: "en",
    }) as ChartAttributes;
    expect(canSwitch(figures)).toBe(false);
    expect(switchedChart(figures)).toBeNull();

    const single = fromTable([
      [head("Segment"), head("Revenue")],
      [cell("Cloud"), cell("120")],
    ]) as ChartAttributes;
    expect(canSwitch(single)).toBe(false);

    const rows = Array.from({ length: 300 }, (_, index) => [
      cell(`Day ${index + 1}`),
      cell(String(index)),
      cell(String(index * 2)),
    ]);
    const cutChart = fromTable([[head("Day"), head("A"), head("B")], ...rows]) as ChartAttributes;
    expect(cutChart.data.cutFrom).toBe(300);
    expect(canSwitch(cutChart)).toBe(false);
    expect(switchedData(cutChart.data)).toBeNull();

    expect(canSwitch(made())).toBe(true);
  });

  test("names a series with no heading by its row once switched, as it did by its column", () => {
    const say = (key: string, params?: Record<string, unknown>) => `${key} ${params?.number}`;
    const grid: SourceGrid = [
      [head("Metric"), head("2023"), head("2024")],
      [cell(""), cell("1.5"), cell("2.5")],
      [cell("Cost"), cell("1.0"), cell("1.2")],
    ];
    const across = fromTable(grid) as ChartAttributes;
    expect(across.data.series).toEqual(["", "Cost"]);
    expect(seriesName(across, 0, say)).toBe("chart.series.unnamedRow 2");
    const down = chartFromTable(grid, {
      blockId: "table-1",
      title: "",
      language: "en",
      switched: false,
    }) as ChartAttributes;
    expect(seriesName(down, 0, say)).toBe("2023");
    const stored = readChart(JSON.parse(JSON.stringify(across)) as Record<string, unknown>);
    expect(stored.source).toEqual({ kind: "table", blockId: "table-1", switched: true });
  });
});

describe("an Analysis's own values in a chart (#2378)", () => {
  const byDocument = (documentId: string, documentName: string, page: number): Citation => ({
    passageId: "passage",
    documentId,
    documentName,
    contentHash: "hash",
    pageFrom: page,
    pageTo: page,
    location: { kind: "page", from: page, to: page },
    quote: `Revenue on page ${page}`,
    check: "found",
    checkReason: null,
  });
  const orders = byDocument("orders", "Orders", 1);
  const regions = byDocument("regions", "Regions", 2);
  const own = byDocument("notebook", "Note book", 3);

  const match = (
    citations: Citation[],
    value: (row: number, column: number) => number | null,
    grid: string[][] = [],
  ): AnalysisTableMatch => ({
    binding: { id: "run", table: { result: "totals" } },
    label: "",
    table: { columns: [], rows: [], rowCount: 0, columnCount: 0 },
    columns: [],
    grids: [grid],
    numeric: [],
    citations,
    value,
  });

  const table = (rows: string[][]): NodeJSON => ({
    type: "table",
    content: rows.map((line, at) => ({
      type: "tableRow",
      content: line.map((text) => ({
        type: at === 0 ? "tableHeader" : "tableCell",
        content: [{ type: "paragraph", content: text === "" ? [] : [{ type: "text", text }] }],
      })),
    })),
  });

  const chartOf = (grid: SourceGrid) =>
    chartFromTable(grid, {
      blockId: "table-1",
      title: "Amounts",
      language: "en",
    }) as ChartAttributes | null;

  test("drawn again from its table, as the core does once a write is checked, keeps the Analysis's values and inputs (#2378)", () => {
    const shown = table([
      ["Region", "Amount"],
      ["Central", "8,325"],
      ["North", "9,450"],
    ]);
    const chart = chartOf(
      withAnalysisValues(
        gridOfTable(shown),
        match([orders], (row, column) => (column === 1 ? ([8325.4, 9450][row] ?? null) : null)),
      ),
    );
    if (!chart) throw new Error("The table drew no chart.");
    // Its table as it is: nothing to draw again, so the values and their inputs stay.
    expect(redrawnData(gridOfTable(shown), chart, "en")).toBeNull();
    // A row renamed is drawn again from its words; the other keeps the Analysis's value and inputs.
    const renamed = redrawnData(
      gridOfTable(
        table([
          ["Region", "Amount"],
          ["Central", "8,325"],
          ["Nord", "9,450"],
        ]),
      ),
      chart,
      "en",
    );
    expect(renamed?.rows.map((row) => row.values[0]?.value)).toEqual([8325.4, 9450]);
    expect(renamed?.rows[0]?.values[0]?.inputs).toEqual([orders]);
    expect(renamed?.rows[1]?.values[0]?.inputs).toBeUndefined();
  });

  test("draws the Analysis's own value, never the number its rounded display reads as", () => {
    const grid = withAnalysisValues(
      gridOfTable(
        table([
          ["Region", "Amount"],
          ["Central", "8,325"],
          ["North", "9,450"],
        ]),
      ),
      match([orders], (row, column) => (column === 1 ? ([8325.4, 9450][row] ?? null) : null)),
    );
    const chart = chartOf(grid);
    if (!chart) throw new Error("The table drew no chart.");
    expect(chart.data.rows.map((row) => row.values[0]?.value)).toEqual([8325.4, 9450]);
    expect(chart.data.rows.map((row) => row.values[0]?.shown)).toEqual(["8,325", "9,450"]);
  });

  test("cites every input the Analysis read first, then the cell's own text Citation", () => {
    const quoted = table([
      ["Region", "Amount"],
      ["Central", "8,325"],
      ["North", "9,450"],
    ]);
    const withOwn = gridOfTable(quoted).map((row) =>
      row.map((cell) => (cell && !cell.header ? { ...cell, citation: own } : cell)),
    );
    // The cell's own Citation is for its words, not for the Analysis's number: an Update reads it fresh.
    const grid = withAnalysisValues(
      withOwn,
      match([orders, regions], (row, column) =>
        column === 1 ? ([8325, 9450][row] ?? null) : null,
      ),
    );
    const chart = chartOf(grid);
    if (!chart) throw new Error("The table drew no chart.");
    const value = chart.data.rows[0]?.values[0];
    // The Analysis's inputs are kept apart; the cell's own Citation stays the value's own text's.
    expect(value?.citation).toEqual(own);
    expect(value?.inputs).toEqual([orders, regions]);
    expect(value && valueCitations(value)).toEqual([orders, regions, own]);
    expect(chartSources(chart)).toMatchObject({ uncited: 0, documents: 3 });
  });

  test("counts every Citation a value carries, so an export names each Document", () => {
    const grid = withAnalysisValues(
      gridOfTable(
        table([
          ["Region", "Amount"],
          ["Central", "8,325"],
          ["North", "9,450"],
        ]),
      ),
      match([orders, regions], (row, column) =>
        column === 1 ? ([8325, 9450][row] ?? null) : null,
      ),
    );
    const chart = chartOf(grid);
    if (!chart) throw new Error("The table drew no chart.");
    const value = chart.data.rows[0]?.values[0];
    if (!value) throw new Error("The chart has no value.");
    expect(valueCitations(value)).toEqual([orders, regions]);
    expect(chartSources(chart)).toMatchObject({ uncited: 0, documents: 2 });
  });

  // protects=a chart value read from a line keeps what the check of its Citation's quoted words found, the next page they ran on to included (#2504), as the Citation has it; fails_when=the copy drops it; no_claim=how the chart shows it.
  test("a line's Citation whose quoted words ran on keeps that page in the chart's copy", () => {
    const cited = { ...orders, quotedWords: { runsOnTo: { kind: "page", from: 2, to: 2 } } };
    const line = sourceLineOf({
      type: "paragraph",
      content: [
        { type: "text", text: "289.4" },
        { type: "citation", attrs: cited },
      ],
    });
    expect(line.citation).toEqual(cited);
  });

  test("reads every Citation a cell holds, not only its first, from its own text", () => {
    const cell: NodeJSON = {
      type: "tableCell",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "289.4" },
            { type: "citation", attrs: { ...orders, id: "c1" } },
            { type: "citation", attrs: { ...regions, id: "c2" } },
          ],
        },
      ],
    };
    const line = sourceLineOf(cell);
    expect(line.citation).toEqual(orders);
    expect(line.citations).toEqual([orders, regions]);
    const chart = chartOf(
      gridOfTable({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [{ type: "paragraph" }] },
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Amount" }] }],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
              },
              cell,
            ],
          },
        ],
      }),
    );
    if (!chart) throw new Error("The table drew no chart.");
    expect(chart.data.rows[0]?.values[0]?.citations).toEqual([orders, regions]);
    expect(chartSources(chart).documents).toBe(2);
  });

  test("keeps a bare year in a year column out, even when the Analysis gives it as a number", () => {
    const quoted = table([
      ["Company", "Listed", "Employees"],
      ["A", "1999", "150"],
      ["B", "2005", "40"],
    ]);
    const grid = withAnalysisValues(
      gridOfTable(quoted),
      match([orders], (row, column) =>
        column === 1 ? ([1999, 2005][row] ?? null) : column === 2 ? ([150, 40][row] ?? null) : null,
      ),
    );
    const chart = chartOf(grid);
    if (!chart) throw new Error("The table drew no chart.");
    expect(chart.data.series).toEqual(["Employees"]);
    expect(chart.data.rows.map((row) => row.values[0]?.value)).toEqual([150, 40]);
  });
});
