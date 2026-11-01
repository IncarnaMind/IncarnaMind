import type { AnalysisCell, AnalysisTable } from "../../shared/analysis";
import { figureCellText, rawColumn } from "../../shared/figures";
import { translate } from "../../shared/i18n";
import type { AnswerAnalysis } from "../api";
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
  const tables = new Map<number, AnalysisTable>();
  const charts = new Map<number, { title: string; table: AnalysisTable }>();
  const pictures = new Set<number>();
  for (const analysis of analyses) {
    for (const { result, marker } of analysis.markers.tables) {
      const found = analysis.output.results.find((each) => each.name === result);
      if (found?.kind === "table") tables.set(marker, found.table);
    }
    analysis.markers.charts.forEach((marker, index) => {
      const chart = analysis.output.charts[index];
      if (chart) charts.set(marker, { title: chart.title, table: chart.table });
    });
    for (const marker of analysis.markers.pictures ?? []) pictures.add(marker);
  }
  return text
    .split("\n")
    .map((line) => {
      const whole = LINE.exec(line);
      if (!whole) return line.replace(MARKER, "");
      const marker = Number(whole[2]);
      // The Blocks show it as its picture (`withAnalysisPictures`): the text keeps its marker.
      if (whole[1] === "picture") return pictures.has(marker) ? `\n[=picture ${marker}]\n` : "";
      // A table reads as one only with a blank line before and after it.
      if (whole[1] === "table") {
        const table = tables.get(marker);
        return table ? `\n${markdownTable(table, language)}\n` : "";
      }
      const chart = charts.get(marker);
      if (!chart) return "";
      const title = chart.title ? `**${chart.title}**\n\n` : "";
      return `\n${title}${markdownTable(chart.table, language)}\n`;
    })
    .join("\n");
}
