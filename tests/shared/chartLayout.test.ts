import { describe, expect, test } from "vitest";
import {
  CHART_FONT_SIZE,
  type ChartLayout,
  chartLegend,
  estimateWidth,
  layoutChart,
  niceStep,
  tickFormat,
} from "../../src/shared/chartLayout";
import { chartSvg, inkColour, LIGHT_CHART_COLOURS } from "../../src/shared/chartSvg";
import { type ChartAttributes, type ChartKind, chartFromTable } from "../../src/shared/charts";

const grid = (rows: readonly (readonly string[])[]) =>
  rows.map((row, index) => row.map((text) => ({ text, citation: null, header: index === 0 })));

const QUARTERS = chartFromTable(
  grid([
    ["Quarter", "2024", "2025"],
    ["Q1", "289.4", "341.5"],
    ["Q2", "301.2", "362.0"],
    ["Q3", "309.8", "377.9"],
    ["Q4", "330.6", "401.2"],
  ]),
  { blockId: null, title: "Revenue", language: "en" },
) as ChartAttributes;

const seriesName = (index: number) => QUARTERS.data.series[index] ?? "";
const lay = (kind: ChartKind, width = 640, chart: ChartAttributes = QUARTERS): ChartLayout =>
  layoutChart({ ...chart, kind }, { width, language: "en", seriesName });

/** Whether every mark lies inside the picture. */
function inside(layout: ChartLayout): boolean {
  return layout.points.every(({ mark }) => {
    if (mark.shape === "bar") {
      return (
        mark.x >= 0 &&
        mark.x + mark.width <= layout.width &&
        mark.y >= 0 &&
        mark.y + mark.height <= layout.height
      );
    }
    return mark.cx >= 0 && mark.cx <= layout.width && mark.cy >= 0 && mark.cy <= layout.height;
  });
}

describe("a chart's layout", () => {
  test("is as wide as the room it has, so its labels stay 12 px", () => {
    for (const width of [360, 640, 900]) {
      const layout = lay("bar", width);
      expect(layout.width).toBe(width);
      expect(inside(layout)).toBe(true);
    }
    expect(CHART_FONT_SIZE).toBe(12);
  });

  test("bars stand on zero, side by side per row, the earlier series left of the later", () => {
    const layout = lay("bar");
    expect(layout.points).toHaveLength(8);
    const base = layout.grid.find((line) => line.base);
    expect(base).toBeDefined();
    for (const { mark } of layout.points) {
      if (mark.shape !== "bar" || !base) throw new Error("Not a bar.");
      expect(mark.y + mark.height).toBeCloseTo(base.y, 5);
    }
    const q1 = layout.points.filter((point) => point.row === 0);
    const [earlier, later] = q1.map((point) => point.mark);
    if (earlier?.shape !== "bar" || later?.shape !== "bar") throw new Error("Not bars.");
    expect(earlier.x).toBeLessThan(later.x);
    // The later year's bar is taller: 341.5 over 289.4.
    expect(later.height).toBeGreaterThan(earlier.height);
  });

  test("two series are greys, the earlier light and the later in the secondary ink; one alone is the secondary ink", () => {
    expect(lay("bar").points.map((point) => point.ink)).toEqual([
      "prior",
      "prior",
      "prior",
      "prior",
      "now",
      "now",
      "now",
      "now",
    ]);
    expect(lay("line", 640, { ...QUARTERS, drawn: [1] }).points.every((p) => p.ink === "now")).toBe(
      true,
    );
    expect(chartLegend(QUARTERS, seriesName).map((item) => [item.name, item.ink])).toEqual([
      ["2024", "prior"],
      ["2025", "now"],
    ]);
  });

  test("a line per series through its rows, with a dot on each value", () => {
    const layout = lay("line");
    expect(layout.lines.map((line) => line.runs.map((run) => run.length))).toEqual([[4], [4]]);
    expect(layout.points.every((point) => point.mark.shape === "dot")).toBe(true);
  });

  test("a pie of the last series, its slices in the category colours, their shares adding up to the whole", () => {
    const layout = lay("pie");
    expect(layout.points.map((point) => point.series)).toEqual([1, 1, 1, 1]);
    expect(layout.points.map((point) => point.ink)).toEqual([
      "category0",
      "category1",
      "category2",
      "category3",
    ]);
    const total = layout.points.reduce((sum, point) => sum + (point.share ?? 0), 0);
    expect(total).toBeCloseTo(1, 6);
    expect(layout.legendMarks.map((mark) => mark.text.text)).toEqual([
      "Q1 · 23.0%",
      "Q2 · 24.4%",
      "Q3 · 25.5%",
      "Q4 · 27.1%",
    ]);
    // The key sits right of the pie, inside the picture.
    for (const mark of layout.legendMarks) expect(mark.x + 12).toBeLessThanOrEqual(layout.width);
  });

  test("a scatter chart: the first series across, the second up, each dot labelled with its row", () => {
    const layout = lay("scatter", 480);
    expect(layout.points).toHaveLength(4);
    expect(inside(layout)).toBe(true);
    const labels = layout.texts.filter((text) => text.role === "label").map((text) => text.text);
    expect(labels).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    const axes = layout.texts.map((text) => text.text);
    expect(axes).toContain("2024 →");
    expect(axes).toContain("↑ 2025");
    // Higher up for more revenue: Q4's dot above Q1's.
    const [q1, , , q4] = layout.points.map((point) => point.mark);
    if (q1?.shape !== "dot" || q4?.shape !== "dot") throw new Error("Not dots.");
    expect(q4.cy).toBeLessThan(q1.cy);
    expect(q4.cx).toBeGreaterThan(q1.cx);
  });

  test("labels along the axis are thinned when they would touch, and cut with … when too long", () => {
    const many = chartFromTable(
      grid([
        ["Day", "Value"],
        ...Array.from({ length: 60 }, (_, index) => [
          `A long day label ${index + 1}`,
          String(index),
        ]),
      ]),
      { blockId: null, title: "", language: "en" },
    ) as ChartAttributes;
    const layout = layoutChart(many, { width: 400, language: "en", seriesName: () => "Value" });
    const along = layout.texts.filter((text) => text.role === "axis" && text.anchor === "middle");
    expect(along.length).toBeLessThan(60);
    for (let index = 1; index < along.length; index++) {
      const before = along[index - 1];
      const here = along[index];
      if (!before || !here) continue;
      const gap = here.x - before.x;
      expect(gap).toBeGreaterThan((estimateWidth(before.text) + estimateWidth(here.text)) / 2);
    }
  });

  test("numbers on the axis: round steps, percents as percents, points as points, large numbers short, in the language", () => {
    expect(niceStep(73)).toBe(100);
    expect(niceStep(0.23)).toBe(0.25);
    expect(tickFormat("en", 0.05, 0.3, "percent")(0.25)).toBe("25%");
    expect(tickFormat("en", 0.005, 0.025, "points")(0.023)).toBe("2.3");
    expect(tickFormat("zh-CN", 0.005, 0.025, "points")(0.023)).toBe("2.3");
    expect(tickFormat("en", 50_000_000, 200_000_000, null)(150_000_000)).toBe("150M");
    expect(tickFormat("zh-CN", 50_000_000, 200_000_000, null)(150_000_000)).toBe("1.5亿");
    expect(tickFormat("en", 0.5, 4, null)(2.5)).toBe("2.5");
  });

  test("percentage points on the axis are points, not their share, in English and Chinese (#1392)", () => {
    const charts = {
      en: grid([
        ["Quarter", "Change"],
        ["Q1", "2.3 percentage points"],
        ["Q2", "2.5 percentage points"],
        ["Q3", "2.4 percentage points"],
      ]),
      "zh-CN": grid([
        ["季度", "变化"],
        ["一季度", "2.3个百分点"],
        ["二季度", "2.5个百分点"],
        ["三季度", "2.4个百分点"],
      ]),
    };
    for (const language of ["en", "zh-CN"] as const) {
      const chart = chartFromTable(charts[language], {
        blockId: null,
        title: "",
        language,
      }) as ChartAttributes;
      const layout = layoutChart(chart, {
        width: 640,
        language,
        seriesName: (index) => chart.data.series[index] ?? "",
      });
      const axis = layout.texts
        .filter((text) => text.role === "axis" && text.anchor === "end")
        .map((text) => text.text);
      expect(axis).toContain("2.5");
      expect(axis.some((label) => label.includes("0.025"))).toBe(false);
    }
  });

  test("one unit's series alone, on its own scale (#1392)", () => {
    const chart = chartFromTable(
      grid([
        ["Quarter", "Gross margin", "Leverage"],
        ["Q1", "41.2%", "2.8x"],
        ["Q2", "42.0%", "2.5x"],
      ]),
      { blockId: null, title: "", language: "en" },
    ) as ChartAttributes;
    const names = (index: number) => chart.data.series[index] ?? "";
    const percent = layoutChart(chart, {
      width: 640,
      language: "en",
      seriesName: names,
      series: [0],
    });
    const times = layoutChart(chart, {
      width: 640,
      language: "en",
      seriesName: names,
      series: [1],
    });
    expect(percent.points.map((point) => point.series)).toEqual([0, 0]);
    expect(times.points.map((point) => point.series)).toEqual([1, 1]);
    const axis = (layout: ChartLayout) =>
      layout.texts.filter((text) => text.role === "axis").map((text) => text.text);
    expect(axis(percent)).toContain("40%");
    expect(axis(times)).not.toContain("40%");
    expect(axis(times)).toContain("2");
  });

  test("with nothing to draw, it has no marks", () => {
    expect(lay("bar", 640, { ...QUARTERS, drawn: [] }).points).toEqual([]);
    expect(lay("scatter", 640, { ...QUARTERS, drawn: [0] }).points).toEqual([]);
  });
});

describe("a chart's picture, for an export", () => {
  test("is a standalone SVG at twice its size, in the light theme's colours, with its key", () => {
    const layout = layoutChart(QUARTERS, {
      width: 600,
      language: "en",
      seriesName,
      legendInside: true,
    });
    const svg = chartSvg(layout, 2);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1200"')).toBe(true);
    expect(svg).toContain(`viewBox="0 0 600 ${layout.height}"`);
    expect(svg).toContain(`fill="${LIGHT_CHART_COLOURS.prior}"`);
    expect(svg).toContain(`fill="${LIGHT_CHART_COLOURS.now}"`);
    expect(svg).toContain(">Q3</text>");
    expect(svg).toContain(">2024</text>");
    expect(svg).toContain('font-size="12"');
    expect(svg.match(/<rect /g)?.length).toBe(1 + 8 + 2);
  });

  test("escapes what it writes, and never uses green, red or blue for categories", () => {
    const layout = layoutChart(
      chartFromTable(
        grid([
          ["Name", "Value"],
          ['<b>&"x"', "3"],
          ["y", "4"],
        ]),
        { blockId: null, title: "", language: "en" },
      ) as ChartAttributes,
      { width: 400, language: "en", seriesName: () => "Value" },
    );
    expect(chartSvg(layout)).toContain("&lt;b&gt;&amp;&quot;x&quot;");
    const categories = Array.from({ length: 9 }, (_, index) => inkColour(`category${index}`));
    for (const banned of ["#4CC38A", "#F25C54", "#4A8CF7", "#2A5BD7"]) {
      expect(categories).not.toContain(banned);
    }
  });
});
