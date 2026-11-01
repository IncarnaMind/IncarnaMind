import {
  ANALYSIS_LIMITS,
  type AnalysisCell,
  type AnalysisFigureRows,
  type AnalysisRecalculation,
  type AnalysisTable,
  type AnalysisValue,
} from "../../shared/analysis";
import { figureCellText, figureResultText, figureText, rawColumn } from "../../shared/figures";
import type { AnswerAnalysis } from "../api";
import type { Language } from "../language";
import { rowsText } from "./figureRows";

const count = (n: number) => figureText("en", n);

const rowsOf = (n: number) => `${count(n)} ${n === 1 ? "row" : "rows"}`;

function stepLine(rows: number, before: number | null): string {
  if (before === null || before === rows) return rowsOf(rows);
  const change =
    before > rows ? `${count(before - rows)} left out` : `${count(rows - before)} added`;
  return `${rowsOf(before)} → ${rowsOf(rows)} (${change})`;
}

const escaped = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function tableText(table: AnalysisTable, shownRows: number, language: Language): string {
  const raw = table.columns.map(rawColumn);
  const cell = (value: AnalysisCell, at: number) =>
    escaped(figureCellText(language, value, raw[at] ?? false));
  const lines = [
    `| ${table.columns.map(escaped).join(" | ")} |`,
    `|${table.columns.map(() => "---").join("|")}|`,
    ...table.rows.slice(0, shownRows).map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
  const left = table.rowCount - Math.min(shownRows, table.rows.length);
  if (left > 0) lines.push(`(${count(left)} more ${left === 1 ? "row" : "rows"})`);
  return lines.join("\n");
}

const ROWS_READ = 20;

export function analysisReport(analysis: AnswerAnalysis, language: Language): string {
  const { output, end } = analysis;
  const lines = [`Analysis ${analysis.number}: ${analysis.title}`];
  lines.push("Inputs:");
  for (const input of analysis.inputs) {
    if (input.kind === "range") {
      const sheet = input.citation.location?.kind === "rows" ? input.citation.location.sheet : null;
      const where = `${input.citation.documentName}${sheet ? `, sheet "${sheet}"` : ""}, ${input.range}`;
      const cut = input.cut
        ? ` (cut: only its first ${rowsOf(input.rows)} were read, the most an Analysis reads; say so in the Answer)`
        : "";
      lines.push(
        `- ${input.name}: ${where}: ${rowsOf(input.rows)} × ${input.columns} columns${cut}`,
      );
    } else {
      lines.push(
        `- ${input.name}: ${input.input.number.chars}, from ${input.input.citation.documentName}`,
      );
    }
  }
  if (output.steps.length > 0) {
    lines.push("Steps:");
    let before: number | null = null;
    for (const step of output.steps) {
      lines.push(`- ${step.label}: ${stepLine(step.rows, before)}`);
      before = step.rows;
    }
  }
  for (const merge of output.merges) {
    const at = merge.line === null ? "" : ` on line ${merge.line}`;
    lines.push(
      merge.matched === null
        ? `A merge${at} gave ${rowsOf(merge.rows)}; its matches couldn't be counted.`
        : `A merge${at}: ${rowsOf(merge.matched)} matched; ${rowsOf(merge.leftOnly ?? 0)} of the left side and ${rowsOf(merge.rightOnly ?? 0)} of the right matched none.`,
    );
  }
  for (const cells of output.notNumbers) {
    const listed = cells.cells.map(
      (each) => `${each.row}${each.value ? ` "${each.value}"` : " empty"}`,
    );
    const more = cells.count > cells.cells.length ? ", …" : "";
    const what = cells.count === 1 ? "1 cell of" : `${count(cells.count)} cells of`;
    const are = cells.count === 1 ? "isn't a number and was" : "aren't numbers and were";
    lines.push(
      `${what} ${cells.input}'s column ${cells.column} ${are} read as missing (rows ${listed.join(", ")}${more}).`,
    );
  }
  if (output.literals.length > 0) {
    const listed = output.literals.map((each) => `${each.text} (line ${each.line})`).join(", ");
    lines.push(
      `Numbers written in the code: ${listed}. A number a calculation uses must be an input, cited, not written in the code.`,
    );
  }
  if (output.printed) {
    lines.push(`Printed:\n${output.printed.trimEnd()}${output.cut.printed ? "\n(cut)" : ""}`);
  }
  if (end.kind === "done") {
    const results = resultLines(analysis, language);
    if (results.length > 0) lines.push("Results:", ...results);
    const untraced = untracedLine(analysis);
    if (untraced) lines.push(untraced);
  } else {
    lines.push("Its figures, tables and charts can't be used because this run did not finish.");
  }
  const cut = [
    output.cut.figures > 0 ? `${count(output.cut.figures)} figures` : "",
    output.cut.tables > 0 ? `${count(output.cut.tables)} tables` : "",
    output.cut.charts > 0 ? `${count(output.cut.charts)} charts` : "",
    output.cut.pictures > 0
      ? `${count(output.cut.pictures)} pictures (each at most ${ANALYSIS_LIMITS.pictureEdge} pixels and ${ANALYSIS_LIMITS.pictureBytes / 1_000_000} MB as a PNG)`
      : "",
  ].filter(Boolean);
  if (cut.length > 0) lines.push(`Left out, over the limits: ${cut.join(", ")}.`);
  const withoutGlyphs = output.withoutGlyphs ?? [];
  if (end.kind === "done" && withoutGlyphs.length > 0) {
    const titles = withoutGlyphs.map((title) => `"${title || "Untitled"}"`).join(", ");
    lines.push(
      `Left out: ${withoutGlyphs.length === 1 ? "a picture" : `${count(withoutGlyphs.length)} pictures`} (${titles}) whose text has characters matplotlib here has no font for, such as Chinese, Japanese or Korean, which would show as boxes. Draw it with chart(), which the app draws in any language, or write the plot's text in English.`,
    );
  }
  lines.push(endLine(analysis, end));
  return lines.join("\n");
}

/** Which rows of which input a figure was worked out from, and how. */
function tracedRows(of: AnalysisFigureRows): string {
  const where = `${rowsOf(of.count)} of ${of.input} (${rowsText(of.rows)})`;
  return of.how
    ? `the ${of.how} of ${of.columns[0] ?? ""} in ${where}, worked out again by IncarnaMind from its cells`
    : `from ${where}: ${of.columns.join(", ")}`;
}

function resultLines(analysis: AnswerAnalysis, language: Language): string[] {
  const lines: string[] = [];
  const figure = new Map(analysis.markers.figures.map((each) => [each.result, each.marker]));
  const table = new Map(analysis.markers.tables.map((each) => [each.result, each.marker]));
  const checks = new Map((analysis.recalculations ?? []).map((each) => [each.result, each.check]));
  for (const result of analysis.output.results) {
    const unit = result.unit ? ` ${result.unit}` : "";
    if (result.kind === "figure") {
      const marker = figure.get(result.name);
      const value = `${figureResultText(language, result.value, result.label)}${unit}`;
      const check = checks.get(result.name);
      if (marker === undefined && check && check.kind !== "same") {
        lines.push(`- ${result.name}: no marker, so it can't be used: ${refusal(result, check)}`);
        continue;
      }
      const of = result.of ? ` (${tracedRows(result.of)})` : "";
      lines.push(`- [=${marker}] ${result.label}: ${value}${of}`);
    } else {
      const marker = table.get(result.name);
      const { rowCount, columnCount } = result.table;
      lines.push(
        `- [=table ${marker}] ${result.label}${unit}: ${rowsOf(rowCount)} × ${columnCount} columns`,
        tableText(result.table, ROWS_READ, language),
      );
    }
  }
  analysis.output.charts.forEach((chart, index) => {
    const marker = analysis.markers.charts[index];
    lines.push(
      `- [=chart ${marker}] ${chart.title || "Chart"} (${chart.kind} of ${chart.y.join(", ")} by ${chart.x})`,
    );
  });
  (analysis.output.pictures ?? []).forEach((picture, index) => {
    const marker = analysis.markers.pictures?.[index];
    lines.push(`- [=picture ${marker}] ${picture.title || "Untitled"} (a picture matplotlib drew)`);
  });
  return lines;
}

/**
 * The figures that name no rows, when the Analysis read a range: their cards can cite only the
 * whole range, so the model is told how to say which rows a model's figure used (#2346).
 */
function untracedLine(analysis: AnswerAnalysis): string | null {
  const marked = new Set(analysis.markers.figures.map((each) => each.result));
  const names = analysis.output.results.flatMap((result) =>
    result.kind === "figure" && !result.of && marked.has(result.name) ? [result.name] : [],
  );
  const ranges = analysis.inputs.flatMap((input) => (input.kind === "range" ? [input.name] : []));
  if (names.length === 0 || ranges.length === 0) return null;
  return `${names.join(", ")} ${names.length === 1 ? "names" : "name"} no rows, so ${names.length === 1 ? "its card cites" : "their cards cite"} all of ${ranges.join(", ")}. If a model or test worked one out from only some of those rows (after dropping or filtering rows), give it with of=, the rows it used, and run it again.`;
}

function refusal(
  result: Extract<AnalysisValue, { kind: "figure" }>,
  check: AnalysisRecalculation,
): string {
  if (check.kind === "unchecked") return `IncarnaMind couldn't work it out again: ${check.reason}.`;
  const of = result.of;
  return `figure() gave ${figureText("en", result.value)}, but ${of ? `the ${of.how} of ${of.columns[0]} in those rows of ${of.input}` : "its cells"} comes to ${figureText("en", check.value)} as the sheet has them. figure() reads a column as its input has it; give a figure from a column the code changed with result().`;
}

function endLine(analysis: AnswerAnalysis, end: AnswerAnalysis["end"]): string {
  switch (end.kind) {
    case "done":
      return analysis.output.results.length > 0 ||
        analysis.output.charts.length > 0 ||
        (analysis.output.pictures ?? []).length > 0
        ? "Write [=n] where a figure goes, and [=table n], [=chart n] or [=picture n] on a line of its own where a table, chart or picture goes. Never write their numbers yourself."
        : "It gave no results: call result(name, value, label, unit) for each figure or table the Answer uses, and run it again.";
    case "error":
      return `It stopped with an error${end.line === null ? "" : ` on line ${end.line}`}:\n${end.message}\nFix the code and run it again: each run starts clean.`;
    case "timed-out":
      return `It ran longer than ${Math.round(end.limitMs / 1000)} seconds and was stopped. Make it do less, or work on fewer rows.`;
    case "out-of-memory":
      return "It ran out of memory and was stopped. Make it hold less at once.";
    case "stopped":
      return "It was stopped before it finished.";
    case "crashed":
      return "Python stopped unexpectedly under it. Run it again; if it stops again, make it do less at once.";
    case "unavailable":
      return "Analyses can't run on this computer. Answer without one, and say so.";
  }
}
