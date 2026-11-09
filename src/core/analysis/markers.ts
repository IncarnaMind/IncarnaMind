import {
  type AnalysisCell,
  type AnalysisChart,
  type AnalysisTable,
  rowsKey,
} from "../../shared/analysis";
import { figureCellText, rawColumn } from "../../shared/figures";
import { translate } from "../../shared/i18n";
import type { AnswerAnalysis, FiguresLeftOut } from "../api";
import type { Language } from "../language";

const MARKER = /\[=(table|chart|picture) (\d+)\]/g;
const LINE = /^[ \t]*\[=(table|chart|picture) (\d+)\][ \t]*$/;

const escaped = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function markdownTable(table: AnalysisTable, language: Language): string {
  const raw = table.columns.map(rawColumn);
  const cell = (value: AnalysisCell, at: number) =>
    escaped(figureCellText(language, value, raw[at] ?? false));
  const lines = [
    `| ${table.columns.map(escaped).join(" | ")} |`,
    `|${table.columns.map(() => " --- ").join("|")}|`,
    ...table.rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
  const left = table.rowCount - table.rows.length;
  if (left > 0) {
    lines.push(
      "",
      left === 1
        ? translate(language, "analysis.table.more.one")
        : translate(language, "analysis.table.more", { count: left }),
    );
  }
  return lines.join("\n");
}

/**
 * `text` with each chart and picture its Analyses made that no line of it places added at its
 * end, the latest of each title once. A reply can say a chart was drawn and leave its marker out,
 * or write it inside a sentence, where it isn't shown (#2346): the User sees every one it made.
 */
export function withEveryChartPlaced(text: string, analyses: readonly AnswerAnalysis[]): string {
  const placed = new Set(
    text.split("\n").flatMap((line) => {
      const whole = LINE.exec(line);
      return whole ? [`${whole[1]} ${whole[2]}`] : [];
    }),
  );
  const titled = (kind: string, marker: number, title: string | undefined) => ({
    marker: `${kind} ${marker}`,
    title: title ? `${kind}: ${title}` : `${kind} ${marker}`,
  });
  const made = analyses.flatMap((analysis) => [
    ...analysis.markers.charts.map((marker, index) =>
      titled("chart", marker, analysis.output.charts[index]?.title),
    ),
    ...(analysis.markers.pictures ?? []).map((marker, index) =>
      titled("picture", marker, analysis.output.pictures?.[index]?.title),
    ),
  ]);
  const shown = new Set(made.filter((each) => placed.has(each.marker)).map((each) => each.title));
  const latest = new Map<string, string>();
  for (const each of made) {
    if (!placed.has(each.marker) && !shown.has(each.title)) latest.set(each.title, each.marker);
  }
  if (latest.size === 0) return text;
  const added = [...latest.values()].map((marker) => `[=${marker}]`).join("\n\n");
  return `${text.trimEnd()}\n\n${added}`;
}

export function withAnalysisResults(
  text: string,
  analyses: readonly AnswerAnalysis[],
  language: Language,
): string {
  if (analyses.length === 0 || !text.includes("[=")) return text;
  const tables = new Map<number, { analysis: AnswerAnalysis; table: AnalysisTable }>();
  const charts = new Map<number, { analysis: AnswerAnalysis; table: AnalysisTable }>();
  const pictures = new Set<number>();
  // The first Analysis that gave a marker names it: this Answer's, when it is listed first.
  for (const analysis of analyses) {
    for (const { result, marker } of analysis.markers.tables) {
      const found = analysis.output.results.find((each) => each.name === result);
      if (found?.kind === "table" && !tables.has(marker))
        tables.set(marker, { analysis, table: found.table });
    }
    analysis.markers.charts.forEach((marker, index) => {
      const chart = analysis.output.charts[index];
      if (chart && !charts.has(marker)) charts.set(marker, { analysis, table: chart.table });
    });
    for (const marker of analysis.markers.pictures ?? []) pictures.add(marker);
  }
  // Each table goes in once: a marker written again, or a chart's marker whose table is already
  // there, would write the same table a second time (#2378). The table's caption names it. Its
  // rows are what it holds: a chart drawn of a result's rows, sorted or under other headings, is
  // that table.
  const placed = new Set<string>();
  const once = ({ analysis, table }: { analysis: AnswerAnalysis; table: AnalysisTable }) => {
    const key = JSON.stringify([analysis.number, analysis.ranAt, rowsKey(table.rows)]);
    if (placed.has(key)) return null;
    placed.add(key);
    return `\n${markdownTable(table, language)}\n`;
  };
  return text
    .split("\n")
    .map((line) => {
      const whole = LINE.exec(line);
      if (!whole) return line.replace(MARKER, "");
      const marker = Number(whole[2]);
      // The Blocks show it as its picture (`withAnalysisPictures`): the text keeps its marker.
      if (whole[1] === "picture") return pictures.has(marker) ? `\n[=picture ${marker}]\n` : "";
      // A table reads as one only with a blank line before and after it.
      const given = whole[1] === "table" ? tables.get(marker) : charts.get(marker);
      return given ? (once(given) ?? "") : "";
    })
    .join("\n");
}

/** The charts `text` places with a marker on a line of its own, as the Analysis drew each (#2378). */
export function chartsPlacedIn(
  text: string,
  analyses: readonly AnswerAnalysis[],
): { kind: AnalysisChart["kind"]; title: string; rows: AnalysisTable["rows"] }[] {
  const placed: { kind: AnalysisChart["kind"]; title: string; rows: AnalysisTable["rows"] }[] = [];
  for (const line of text.split("\n")) {
    const whole = LINE.exec(line);
    if (whole?.[1] !== "chart") continue;
    const marker = Number(whole[2]);
    // The first Analysis that gave a marker names it, as `withAnalysisResults` reads it.
    for (const analysis of analyses) {
      const index = analysis.markers.charts.indexOf(marker);
      const chart = index < 0 ? undefined : analysis.output.charts[index];
      if (!chart) continue;
      placed.push({ kind: chart.kind, title: chart.title, rows: chart.table.rows });
      break;
    }
  }
  return placed;
}

/** How many labels of figures with no marker a change names. */
const LEFT_OUT_NAMED = 3;

/**
 * What a Note's change says of `count` figure markers its text kept because no figure was recorded
 * for them (#2577): the Analyses' figures that got no marker, as IncarnaMind couldn't work them
 * out again from their rows.
 */
export function figuresLeftOut(count: number, analyses: readonly AnswerAnalysis[]): FiguresLeftOut {
  const labels = analyses.flatMap((analysis) =>
    analysis.output.results.flatMap((result) =>
      result.kind === "figure" &&
      !analysis.markers.figures.some((each) => each.result === result.name)
        ? [result.label]
        : [],
    ),
  );
  return { count, labels: [...new Set(labels)].slice(0, LEFT_OUT_NAMED) };
}
