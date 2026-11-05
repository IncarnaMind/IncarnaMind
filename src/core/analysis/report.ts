import {
  ANALYSIS_LIMITS,
  type AnalysisCell,
  type AnalysisFigureRows,
  type AnalysisRecalculation,
  type AnalysisTable,
  type AnalysisValue,
  OUT_FILES,
} from "../../shared/analysis";
import { figureCellText, figureResultText, figureText, rawColumn } from "../../shared/figures";
import type { AnalysisRangeInput, AnswerAnalysis } from "../api";
import type { Language } from "../language";
import { tableWhereText } from "./documentTables";
import { cellsText, notNumbersText, rowRuns, rowsText } from "./figureRows";

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

/** The rows the file sets aside among `rows`, as the report names them; "" for none. */
function setAsideText(
  setAside: AnalysisRangeInput["setAside"],
  rows: (row: number) => boolean = () => true,
): string {
  const struck = (setAside?.struck ?? []).filter(rows);
  const hidden = (setAside?.hidden ?? []).filter(rows);
  return [
    ...(struck.length > 0 ? [`${rowsText(rowRuns(struck))}, which the file strikes through`] : []),
    ...(hidden.length > 0 ? [`${rowsText(rowRuns(hidden))}, which the file hides`] : []),
  ].join(", and ");
}

const ROWS_READ = 20;

const bytesText = (bytes: number) =>
  bytes < 1024
    ? `${count(bytes)} bytes`
    : bytes < 1024 * 1024
      ? `${figureText("en", Math.round(bytes / 102.4) / 10)} KB`
      : `${figureText("en", Math.round(bytes / 104857.6) / 10)} MB`;

/**
 * What the model reads of an Analysis. `codeOffered`: run_code is in the same Run, so a range
 * run_analysis cut is to be run again there, which reads up to 200,000 rows.
 */
export function analysisReport(
  analysis: AnswerAnalysis,
  language: Language,
  codeOffered = false,
): string {
  const { output, end } = analysis;
  const lines = [`Analysis ${analysis.number}: ${analysis.title}`];
  if (analysis.files) {
    lines.push(
      "Files in ../inputs:",
      ...analysis.files.map(
        (file) =>
          `- ${file.name}${file.name === file.documentName ? "" : ` (${file.documentName})`}: ${bytesText(file.bytes)}`,
      ),
    );
  }
  if (analysis.inputs.length > 0 || !analysis.files) lines.push("Inputs:");
  for (const input of analysis.inputs) {
    if (input.kind === "range") {
      const sheet = input.citation.location?.kind === "rows" ? input.citation.location.sheet : null;
      const table = input.table
        ? `, table ${input.table.number} (${tableWhereText(input.table.rows, input.citation.location?.kind)})`
        : "";
      const where = `${input.citation.documentName}${sheet ? `, sheet "${sheet}"` : ""}${table}, ${input.range}`;
      const cut = !input.cut
        ? ""
        : codeOffered && !analysis.files
          ? ` (cut: only its first ${rowsOf(input.rows)} were read, the most run_analysis reads; run it again with run_code, which reads up to 200,000 rows)`
          : ` (cut: only its first ${rowsOf(input.rows)} were read, the most this Analysis can read; say so in the Answer)`;
      const aside = setAsideText(input.setAside);
      const held = aside
        ? `; it holds ${aside}: drop such rows by their numbers where they are an earlier version of rows the sheet shows plainly`
        : "";
      lines.push(
        `- ${input.name}: ${where}: ${rowsOf(input.rows)} × ${input.columns} columns${cut}${held}`,
      );
      if (input.table?.scan) {
        lines.push(
          `  Its numbers were read from a scan by text recognition, which may misread them: say so in the Answer.`,
        );
      }
      if (input.table?.marks) {
        lines.push(
          `  ${input.table.marks === 1 ? "1 cell has a footnote mark after its number" : `${count(input.table.marks)} cells have a footnote mark after their numbers`} (such as ¹ or *); a cell's value leaves it out.`,
        );
      }
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
    const what = notNumbersText(cells.count, cells.column, `in ${cells.input}`);
    lines.push(
      `${what}, so the code reads ${cells.count === 1 ? "it" : "them"} as missing: ${cellsText(cells.cells, cells.count)}.`,
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
  const out = analysis.outFiles;
  if (out && (out.files.length > 0 || out.left > 0)) {
    lines.push("Files it left in out/:");
    for (const file of out.files) {
      lines.push(`- ${file.name}: ${bytesText(file.bytes)}`);
      if (file.text !== undefined) lines.push(file.text.trimEnd());
    }
    if (out.left > 0) {
      lines.push(
        `(${count(out.left)} more left out: at most ${OUT_FILES.count} files of ${OUT_FILES.bytes / 1024 / 1024} MB come back, and never a link)`,
      );
    }
  }
  if (end.kind === "done") {
    const results = resultLines(analysis, language);
    if (results.length > 0) lines.push("Results:", ...results);
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
  const unlisted = output.cut.withoutGlyphs ?? 0;
  if (end.kind === "done" && withoutGlyphs.length > 0) {
    const titles = [
      ...withoutGlyphs.map((title) => `"${title || "Untitled"}"`),
      ...(unlisted > 0 ? [`${count(unlisted)} more`] : []),
    ].join(", ");
    const total = withoutGlyphs.length + unlisted;
    lines.push(
      `Left out: ${total === 1 ? "a picture" : `${count(total)} pictures`} (${titles}) whose text has characters the plot's fonts don't have, such as Japanese, Korean or a rare Chinese character, which would show as boxes. In the Answer, tell the User ${total === 1 ? "this plot was" : "these plots were"} left out and why. To show ${total === 1 ? "it" : "them"}, draw with chart(), which the app draws in any language, or write the plot's text without those characters.`,
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
      lines.push(
        `- [=${marker}] ${result.label}: ${value}${of}${countsSetAside(analysis, result)}`,
      );
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

/** What a figure counts of the rows the file sets aside, said after it; "" when it counts none. */
function countsSetAside(
  analysis: AnswerAnalysis,
  result: Extract<AnalysisValue, { kind: "figure" }>,
): string {
  const of = result.of;
  const input = analysis.inputs.find((each) => each.kind === "range" && each.name === of?.input);
  if (!of || input?.kind !== "range") return "";
  const counted = (row: number) => of.rows.some(([from, to]) => row >= from && row <= to);
  const aside = setAsideText(input.setAside, counted);
  return aside
    ? `; it counts ${aside}: never give it as the sheet's current figure unless those rows are current entries, and say so`
    : "";
}

function refusal(
  result: Extract<AnalysisValue, { kind: "figure" }>,
  check: AnalysisRecalculation,
): string {
  if (check.kind === "unchecked") return `IncarnaMind couldn't work it out again: ${check.reason}.`;
  const of = result.of;
  return `figure() gave ${figureText("en", result.value)}, but ${of ? `the ${of.how} of ${of.columns[0]} in those rows of ${of.input}` : "its cells"} comes to ${figureText("en", check.value)} as the input has them. figure() reads a column as its input has it; give a figure from a column the code changed with result().`;
}

function endLine(analysis: AnswerAnalysis, end: AnswerAnalysis["end"]): string {
  switch (end.kind) {
    case "done":
      if (analysis.language === "bash") {
        return "It ran to its end. bash is for looking around: no number it printed may be given in the Answer. Give each number the Answer uses with Python's result() or figure() in run_code, and write its marker.";
      }
      return analysis.output.results.length > 0 ||
        analysis.output.charts.length > 0 ||
        (analysis.output.pictures ?? []).length > 0
        ? "Write [=n] where a figure goes, and [=table n], [=chart n] or [=picture n] on a line of its own where a table, chart or picture goes. Never write their numbers yourself. A figure worked out from an input's rows names them with of= that input's DataFrame or column."
        : "It gave no results: call result(name, value, label, unit) for each figure or table the Answer uses, and run it again.";
    case "error":
      return `It stopped with an error${end.line === null ? "" : ` on line ${end.line}`}:\n${end.message}\nFix the code and run it again: each run starts clean.`;
    case "timed-out":
      return `It ran longer than ${Math.round(end.limitMs / 1000)} seconds and was stopped. Make it do less, or work on fewer rows.`;
    case "out-of-memory":
      return "It ran out of memory and was stopped. Make it hold less at once.";
    case "disk-unmeasured":
      return "It was stopped because its disk use couldn't be measured. Run it again; if it stops again, make it do less at once.";
    case "stopped":
      return "It was stopped before it finished.";
    case "crashed":
      return "Python stopped unexpectedly under it. Run it again; if it stops again, make it do less at once.";
    case "unavailable":
      return "Analyses can't run on this computer. Answer without one, and say so.";
  }
}
