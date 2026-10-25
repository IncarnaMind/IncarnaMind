import type { AnalysisCell, AnalysisTable } from "../../shared/analysis";
import { translate } from "../../shared/i18n";
import type { AnswerAnalysis } from "../api";
import type { Language } from "../language";

const MARKER = /\[=(table|chart) (\d+)\]/g;
const LINE = /^[ \t]*\[=(table|chart) (\d+)\][ \t]*$/;

const numberText = (value: number): string => {
  if (Number.isInteger(value) || !Number.isFinite(value)) return String(value);
  const whole = Math.floor(Math.log10(Math.abs(value))) + 1;
  return String(Number(value.toPrecision(Math.max(4, whole + 2))));
};

const cellText = (cell: AnalysisCell): string =>
  cell === null
    ? ""
    : (typeof cell === "number" ? numberText(cell) : String(cell))
        .replaceAll("|", "\\|")
        .replaceAll("\n", " ");

function markdownTable(table: AnalysisTable, language: Language): string {
  const lines = [
    `| ${table.columns.map(cellText).join(" | ")} |`,
    `|${table.columns.map(() => " --- ").join("|")}|`,
    ...table.rows.map((row) => `| ${row.map(cellText).join(" | ")} |`),
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

export function withAnalysisResults(
  text: string,
  analyses: readonly AnswerAnalysis[],
  language: Language,
): string {
  if (analyses.length === 0 || !text.includes("[=")) return text;
  const tables = new Map<number, AnalysisTable>();
  const charts = new Map<number, { title: string; table: AnalysisTable }>();
  for (const analysis of analyses) {
    for (const { result, marker } of analysis.markers.tables) {
      const found = analysis.output.results.find((each) => each.name === result);
      if (found?.kind === "table") tables.set(marker, found.table);
    }
    analysis.markers.charts.forEach((marker, index) => {
      const chart = analysis.output.charts[index];
      if (chart) charts.set(marker, { title: chart.title, table: chart.table });
    });
  }
  return text
    .split("\n")
    .map((line) => {
      const whole = LINE.exec(line);
      if (!whole) return line.replace(MARKER, "");
      const marker = Number(whole[2]);
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
