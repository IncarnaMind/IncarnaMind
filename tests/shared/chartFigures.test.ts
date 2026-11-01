import { describe, expect, test } from "vitest";
import type { CalculatedFigure } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import {
  chartFromFigures,
  chartSources,
  readChartData,
  sourceLineOf,
  valueCitations,
} from "../../src/shared/charts";
import {
  chartOf,
  citation,
  header,
  paragraph,
  Q1,
  Q2,
  Q3,
  row,
  TABLE,
  TOTAL,
  tableCell,
  text,
} from "../helpers/calculatedCharts";

/*
 * A chart of calculated figures (#2307): a value drawn from a calculated figure keeps the figure,
 * its formula and every Input with its own Citation, and never the Citation written beside it,
 * which holds one Input and not the figure.
 */

describe("a chart of calculated figures", () => {
  test("a calculated cell's value is its figure, not the Citation beside it", () => {
    const chart = chartOf(TABLE);
    const [west, north] = chart.data.rows;
    expect(west?.values[0]).toMatchObject({ shown: "52,530", value: 52530, citation: null });
    expect(west?.values[0]?.figure?.id).toBe("figure-total");
    expect(west?.values[0]?.figure?.figure.inputs).toHaveLength(3);
    expect(west?.values[1]?.figure?.id).toBe("figure-growth");
    expect(north?.values[0]?.figure).toBeUndefined();
    expect(north?.values[0]?.citation?.quote).toBe(Q1.citation.quote);
  });

  test("a calculated figure shown rounded charts its value, never the number the rounding reads as", () => {
    const rounded: CalculatedFigure = {
      ...TOTAL,
      label: "Central total",
      value: 8325,
      shown: "8 thousand",
    };
    const table: NodeJSON = {
      type: "table",
      content: [
        row(header("Region"), header("Total amount")),
        row(tableCell(text("Central")), tableCell(calculatedFigureNode(rounded, "figure-central"))),
      ],
    };
    expect(chartOf(table).data.rows[0]?.values[0]).toMatchObject({
      value: 8325,
      shown: "8 thousand",
      figure: { id: "figure-central" },
    });
  });

  test("a calculated value rests on each of its Inputs' Citations", () => {
    const west = chartOf(TABLE).data.rows[0]?.values[0];
    if (!west) throw new Error("No value.");
    expect(valueCitations(west).map((each) => each.location)).toEqual([
      Q1.citation.location,
      Q2.citation.location,
      Q3.citation.location,
    ]);
  });

  test("the sources count calculated values apart, and each Input once", () => {
    const sources = chartSources(chartOf(TABLE));
    expect(sources).toMatchObject({ values: 3, calculated: 2, uncited: 0, documents: 1 });
    expect(sources.places).toHaveLength(1);
    expect(sources.inputs).toMatchObject({ count: 3, cells: true, documents: 1 });
    expect(sources.inputs.places).toHaveLength(3);
  });

  test("a number written before a figure is not that figure", () => {
    const table: NodeJSON = {
      type: "table",
      content: [
        row(header("Region"), header("Total revenue")),
        row(
          tableCell(text("West")),
          tableCell(
            text("52,000 "),
            citation(Q1.citation),
            text(" "),
            calculatedFigureNode(TOTAL, "figure-total"),
          ),
        ),
        row(tableCell(text("East")), tableCell(text("76,540 "), citation(Q2.citation))),
        row(tableCell(text("North")), tableCell(text("70,460 "), citation(Q3.citation))),
      ],
    };
    const value = chartOf(table).data.rows[0]?.values[0];
    expect(value?.figure).toBeUndefined();
    expect(value?.citation?.quote).toBe(Q1.citation.quote);
  });

  test("a figure's place in its line holds when spaces around it are squeezed", () => {
    const line = sourceLineOf(
      paragraph(text("  West   total: "), calculatedFigureNode(TOTAL, "figure-total"), text("  ")),
    );
    expect(line.text).toBe("West total: 52,530");
    expect(line.figures).toHaveLength(1);
    const span = line.figures?.[0];
    expect(span && line.text.slice(span.start, span.end)).toBe("52,530");
  });

  test("a chart of selected lines keeps a line's calculated figure", () => {
    const chart = chartFromFigures(
      [
        sourceLineOf(
          paragraph(
            text("West: "),
            calculatedFigureNode(TOTAL, "figure-total"),
            citation(Q1.citation),
          ),
        ),
      ],
      { title: "", language: "en" },
    );
    const value = chart?.data.rows[0]?.values[0];
    expect(value?.figure?.id).toBe("figure-total");
    expect(value?.citation).toBeNull();
  });

  test("a chart keeps its figures as it is stored, and reads one stored before them", () => {
    const chart = chartOf(TABLE);
    const stored = readChartData(JSON.parse(JSON.stringify(chart.data)));
    expect(stored.rows[0]?.values[0]?.figure?.figure.formula).toBe("q1 + q2 + q3");
    const before = JSON.parse(JSON.stringify(chart.data));
    delete before.rows[0].values[0].figure;
    expect(readChartData(before).rows[0]?.values[0]?.figure).toBeUndefined();
  });
});
