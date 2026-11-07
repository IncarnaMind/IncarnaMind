/**
 * An Analysis's own result table in an Answer or a Note (#2378): one calculated object. Its cells
 * stay text, as the Analysis gave them; its table Block names the run and which of its tables it
 * is, and a caption line above it, the Analysis's name for it, ends with one marker in the one
 * number series, whose footnote names the rows and files the Analysis read.
 *
 * A table the Answer writes from a marker is found again by what it holds: the exact headings
 * and cells the Analysis gave, formatted as the interface writes them.
 */

import * as Y from "yjs";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  type AnalysisTableBinding,
  type AnswerAnalysis,
  type AnswerAnalysisInput,
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  type Citation,
  MIND_CONTENT_FIELD,
  type RetainedFigureAnalysis,
} from "../core/api";
import type { Language } from "../core/language";
import {
  AGGREGATE_WORDS,
  type AnalysisCell,
  type AnalysisColumnCheck,
  type AnalysisColumnRule,
  type AnalysisTable,
  type AnalysisTableKey,
  FIGURE_HOW,
  type FigureHow,
  sameTableKey,
} from "./analysis";
import type { NodeJSON } from "./blockJson";
import { readCalculatedFigureEvidence } from "./calculatedFigures";
import { labelRole } from "./figureFooting";
import { figureRunId, figureRunsFor, readTableBinding, sameBinding } from "./figureRuns";
import { figureCellText, figureText, rawColumn } from "./figures";
import { sameNumber } from "./formula";
import { translate } from "./i18n";

/** An Analysis, and the Answer it ran in, whose tables a Note can hold. */
export interface AnalysisTableRun {
  answerId: string;
  analysis: AnswerAnalysis;
}

/** Each Citation an Analysis read its data from, once: its ranges and the numbers quoted from a Passage. */
export function analysisInputCitations(inputs: readonly AnswerAnalysisInput[]): Citation[] {
  const citations = new Map<string, Citation>();
  for (const input of inputs) {
    const citation = input.kind === "range" ? input.citation : input.input.citation;
    const key = JSON.stringify([
      citation.documentId,
      citation.passageId,
      citation.location,
      citation.quote,
    ]);
    if (!citations.has(key)) citations.set(key, citation);
  }
  return [...citations.values()];
}

const textOf = (node: NodeJSON): string =>
  (node.content ?? [])
    .map((child) => (child.type === "text" ? (child.text ?? "") : textOf(child)))
    .join("");

/** The cells of a table Block, row by row, as their text. */
const gridOf = (table: NodeJSON): string[][] =>
  (table.content ?? []).map((row) => (row.content ?? []).map((cell) => textOf(cell).trim()));

/** The languages the interface writes numbers in: a table matches as it reads in either. */
const LANGUAGES = ["en", "zh-CN"] as const;

/** How an Analysis's table reads as a grid of cells, its first row the headings. */
const analysisGrid = (table: AnalysisTable, language: (typeof LANGUAGES)[number]): string[][] => {
  const raw = table.columns.map(rawColumn);
  const cell = (value: AnalysisCell, at: number) =>
    figureCellText(language, value, raw[at] ?? false).replaceAll("\n", " ");
  return [table.columns, ...table.rows.map((row) => row.map((value, at) => cell(value, at)))];
};

/** Its columns that hold numbers: the ones whose readings the Analysis worked out. */
const numericColumns = (table: AnalysisTable): number[] =>
  table.columns.flatMap((_, at) =>
    table.rows.some((row) => typeof row[at] === "number") ? [at] : [],
  );

/** Where a table's heading row says it read, when a Citation there names a place. */
function citedPlaces(block: NodeJSON): Set<string> {
  const places = new Set<string>();
  const visit = (node: NodeJSON) => {
    if (node.type === "citation") {
      const name = node.attrs?.documentId ?? node.attrs?.documentName;
      if (typeof name === "string" && name !== "")
        places.add(
          JSON.stringify([
            name,
            node.attrs?.location === undefined ? null : node.attrs.location,
            node.attrs?.contentHash === undefined ? null : node.attrs.contentHash,
            node.attrs?.passageId === undefined ? null : node.attrs.passageId,
          ]),
        );
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const cell of block.content?.[0]?.content ?? []) visit(cell);
  return places;
}

/** A table an Analysis gave, as a Block reads it back: its grids, its numbers and where they came from. */
export interface AnalysisTableMatch {
  binding: AnalysisTableBinding;
  /** What the Analysis called the table: its caption's words. */
  label: string;
  /** The table as the run gave it. */
  table: AnalysisTable;
  /** The table's grid as it reads in each language the interface writes: its headings, then its rows. */
  grids: string[][][];
  /** Its columns that hold numbers. */
  numeric: number[];
  /** Each Citation the Analysis read its data from, once. */
  citations: Citation[];
  /** What IncarnaMind made of each column of numbers when the Analysis ran. */
  columns: AnalysisColumnCheck[];
  /** What the Analysis gave at a data row (0 the first below the headings) and a column; null: no number. */
  value(row: number, column: number): number | null;
}

/** A table an Analysis gave, read from what a Note keeps of its run. */
export function analysisTableMatch(
  binding: AnalysisTableBinding,
  label: string,
  table: AnalysisTable,
  citations: Citation[],
  columns: AnalysisColumnCheck[],
): AnalysisTableMatch {
  return {
    binding,
    label,
    table,
    grids: LANGUAGES.map((language) => analysisGrid(table, language)),
    numeric: numericColumns(table),
    citations,
    columns,
    value: (row, column) => {
      const given = table.rows[row]?.[column];
      return typeof given === "number" && Number.isFinite(given) ? given : null;
    },
  };
}

/** Every result table and chart an Analysis gave, as a Note reads them back. */
export function analysisTablesOf(runs: readonly AnalysisTableRun[]): AnalysisTableMatch[] {
  return runs.flatMap(({ answerId, analysis }) => {
    if (analysis.end.kind !== "done") return [];
    const id = figureRunId(answerId, analysis);
    const citations = analysisInputCitations(analysis.inputs);
    const columnsOf = (key: AnalysisTableKey) =>
      analysis.tableChecks?.find((each) => sameTableKey(each.table, key))?.columns ?? [];
    const made: AnalysisTableMatch[] = [];
    const add = (key: AnalysisTableKey, label: string, table: AnalysisTable) => {
      made.push(analysisTableMatch({ id, table: key }, label, table, citations, columnsOf(key)));
    };
    for (const result of analysis.output.results)
      if (result.kind === "table") add({ result: result.name }, result.label, result.table);
    for (const [index, chart] of analysis.output.charts.entries())
      add({ chart: index }, chart.title, chart.table);
    return made;
  });
}

/** The tables a Note keeps of its Analyses' runs, as a Note reads them back. */
export function keptAnalysisTables(runs: readonly RetainedFigureAnalysis[]): AnalysisTableMatch[] {
  return runs.flatMap((run) => {
    const citations = analysisInputCitations(run.inputs);
    return (run.tables ?? []).map((table) =>
      analysisTableMatch(
        { id: run.id, table: table.key },
        table.label,
        table.table,
        citations,
        table.columns,
      ),
    );
  });
}

/** The Analysis table `block` is bound to, by what it names; null for a table that names none. */
export function boundTableFor(
  block: NodeJSON,
  tables: readonly AnalysisTableMatch[],
): AnalysisTableMatch | null {
  if (block.type !== "table") return null;
  const binding = readTableBinding(block.attrs?.[ANALYSIS_TABLE_ATTRIBUTE]);
  return binding ? (tables.find((table) => sameBinding(table.binding, binding)) ?? null) : null;
}

/** The Analysis table `block` is, matched by what it holds, as the Answer or Note writes it; null: another table. */
export function analysisTableFor(
  block: NodeJSON,
  tables: readonly AnalysisTableMatch[],
): AnalysisTableMatch | null {
  if (block.type !== "table") return null;
  const bound = readTableBinding(block.attrs?.[ANALYSIS_TABLE_ATTRIBUTE]);
  if (bound) return boundTableFor(block, tables);
  const grid = gridOf(block);
  const cited = citedPlaces(block);
  const matches = tables.filter(
    (table) =>
      table.citations.length > 0 &&
      // A table whose headings cite other Documents or other places came from another Analysis,
      // though it reads the same: Orders' November sheet and its October sheet give one table.
      !(
        cited.size > 0 &&
        table.citations.some((citation) => {
          const name = citation.documentId || citation.documentName || "";
          return (
            name !== "" &&
            !cited.has(
              JSON.stringify([
                name,
                citation.location ?? null,
                citation.contentHash ?? null,
                citation.passageId ?? null,
              ]),
            )
          );
        })
      ) &&
      table.grids.some(
        (cells) =>
          cells.length === grid.length &&
          grid.every((row, at) => row.join("\u0000") === (cells[at] ?? []).join("\u0000")),
      ),
  );
  const [first] = matches;
  if (!first) return null;
  // Two Analyses that read the same rows can give the same table: bound to either alone would name
  // the wrong one, so it counts only while they agree on every value and where it came from (#2378).
  const agrees = matches.every(
    (table) =>
      JSON.stringify(table.citations) === JSON.stringify(first.citations) &&
      grid.every((row, at) =>
        row.every((_, column) => table.value(at - 1, column) === first.value(at - 1, column)),
      ),
  );
  return agrees ? first : null;
}

/** The value of the calculated figure a cell holds alone; null: it holds none, or more than one. */
function figureValueIn(cell: NodeJSON): number | null {
  const inline = (cell.content ?? []).flatMap((block) =>
    (block.content ?? []).filter((node) => node.type !== "text" || (node.text ?? "").trim() !== ""),
  );
  const [only] = inline;
  if (inline.length !== 1 || only?.type !== CALCULATED_FIGURE_NODE) return null;
  const value = readCalculatedFigureEvidence(only.attrs)?.figure.value;
  return typeof value === "number" ? value : null;
}

/**
 * Whether `block`, a table typed in the content, holds `match`'s rows again (#2378): under any
 * headings, the same rows and labels, each other cell the Analysis's text or a figure marker of
 * its value.
 */
export function holdsTableAgain(block: NodeJSON, match: AnalysisTableMatch): boolean {
  if (block.type !== "table" || readTableBinding(block.attrs?.[ANALYSIS_TABLE_ATTRIBUTE]))
    return false;
  // A table that cites a Document's own lines is that Document's, set beside the Analysis's to compare.
  const cites = (node: NodeJSON): boolean =>
    node.type === CITATION_NODE || (node.content ?? []).some(cites);
  if (cites(block)) return false;
  const rows = (block.content ?? []).slice(1);
  if (rows.length === 0 || rows.length !== match.table.rows.length) return false;
  return rows.every((row, at) => {
    const cells = row.content ?? [];
    return (
      cells.length === match.table.columns.length &&
      cells.every((cell, column) => {
        const figure = figureValueIn(cell);
        const value = match.value(at, column);
        if (figure !== null) return value !== null && sameNumber(figure, value);
        const text = textOf(cell).trim();
        return match.grids.some((grid) => grid[at + 1]?.[column] === text);
      })
    );
  });
}

/** A line's words as a title reads them: its case, spacing and a closing colon aside. */
const leadIn = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:：]$/u, "")
    .trim()
    .toLocaleLowerCase();

/** A caption line: the Analysis's name for its table, ending with the table's marker. */
export function captionOf(match: Pick<AnalysisTableMatch, "binding" | "label">): NodeJSON {
  return {
    type: "paragraph",
    content: [
      ...(match.label.trim() ? [{ type: "text", text: match.label.trim() }] : []),
      { type: ANALYSIS_TABLE_NODE, attrs: { [ANALYSIS_TABLE_ATTRIBUTE]: match.binding } },
    ],
  };
}

/** How many tables `blocks` hold that are an Analysis's own: what a Note written with them cites. */
export const countBoundTables = (blocks: readonly NodeJSON[]): number =>
  blocks.reduce(
    (count, block) =>
      count +
      (block.type === "table" && readTableBinding(block.attrs?.[ANALYSIS_TABLE_ATTRIBUTE])
        ? 1
        : 0) +
      countBoundTables(block.content ?? []),
    0,
  );

/** How many Citations `blocks` hold: what a Note written with them cites. */
export function countCitations(blocks: readonly NodeJSON[]): number {
  return blocks.reduce(
    (count, block) =>
      count + ((block.type === "citation" ? 1 : 0) + countCitations(block.content ?? [])),
    0,
  );
}

/**
 * `blocks` with each table that is an Analysis's own bound to its run, under its caption line;
 * a table that isn't one is left as it is. A table already bound keeps its caption.
 */
export function withAnalysisTables(
  blocks: readonly NodeJSON[],
  runs: readonly AnalysisTableRun[],
): NodeJSON[] {
  if (runs.length === 0) return [...blocks];
  const tables = analysisTablesOf(runs);
  if (tables.length === 0) return [...blocks];
  const out: NodeJSON[] = [];
  for (const block of blocks) {
    const found = readTableBinding(block.attrs?.[ANALYSIS_TABLE_ATTRIBUTE])
      ? null
      : analysisTableFor(block, tables);
    if (!found) {
      out.push(block);
      continue;
    }
    // The caption is the table's title: a line above it that only says the same is dropped.
    const above = out.at(-1);
    if (above?.type === "paragraph" && leadIn(textOf(above)) === leadIn(found.label)) out.pop();
    out.push(captionOf(found), {
      ...block,
      attrs: { ...block.attrs, [ANALYSIS_TABLE_ATTRIBUTE]: found.binding },
    });
  }
  return out;
}

/** A cell of an Analysis's table whose text in the Note isn't what the Analysis gave. */
export interface DifferingCell {
  /** Its row among the Note's table's rows below the headings, from 0. */
  row: number;
  /** Its row's label in the Note. */
  label: string;
  /** As the Note writes it. */
  note: string;
  /** As the Analysis gave it, in the interface's language; null for a row the Analysis gave none of. */
  analysis: string | null;
}

/** One column of numbers of an Analysis's table, as its card lists it. */
export interface AnalysisTableColumn {
  column: number;
  /** Its heading as the Note writes it. */
  heading: string;
  /** The one rule IncarnaMind worked it out again with; null: not recalculated. */
  rule: AnalysisColumnCheck["rule"];
  rows: number;
  differs: DifferingCell[];
  /** A total row the User added that adds up the Analysis's rows above it: its footing's sum. */
  footed: { label: string; sum: string }[];
  /** The table's caption names another way of working it out, or a scale: "Total…" over averages (#2378). */
  captionMisnames?: true;
}

/**
 * What an Analysis's table shows (#2378), worked out from the Note's table and the run the Note
 * keeps, never from the Documents' text: recalculated when IncarnaMind reproduced every column and
 * the Note still reads them, calculated by the Analysis when a column wasn't reproduced, differs
 * when a cell's text isn't the run's, and needs a re-check once a Document it read changed.
 */
export type AnalysisTableState =
  | { kind: "recalculated" }
  | { kind: "calculated" }
  | { kind: "differs" }
  | { kind: "needs-recheck"; why: "new-version" | "document-removed" }
  /** Its run read a Document kept inside a walled Folder the Note is outside (#1934): it backs nothing here. */
  | { kind: "kept-inside"; folder: string }
  | { kind: "unavailable" };

export interface AnalysisTableShown {
  state: AnalysisTableState;
  columns: AnalysisTableColumn[];
  /** Rows the run gave that the Note's table no longer holds, as when the User deleted them. */
  missing: number;
}

const cellKey = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * How `block`, a table bound to `kept`, shows: each Note row is paired with the run's row of the
 * same label, so a row deleted moves no value to its neighbour; a row the run gave none of differs.
 * `versions`: each live Document's version now; null while they aren't known.
 */
export function analysisTableShown(
  block: NodeJSON,
  kept: AnalysisTableMatch | null,
  language: string,
  versions: ReadonlyMap<string, string> | null,
  keptInside: ((documentId: string) => string | null) | null = null,
  /** The words of its caption line, which may name it another way than its columns' rules. */
  caption: string | null = null,
): AnalysisTableShown {
  if (!kept) return { state: { kind: "unavailable" }, columns: [], missing: 0 };
  const grid = gridOf(block);
  const [headings = [], ...rows] = grid;
  const given = kept.table;
  const raw = given.columns.map(rawColumn);
  const written = (value: AnalysisCell, column: number) =>
    LANGUAGES.map((each) => cellKey(figureCellText(each, value, raw[column] ?? false)));
  // A label the run gives twice, as a group by two keys does, pairs its rows in their order.
  const runRows = new Map<string, number[]>();
  given.rows.forEach((row, at) => {
    for (const label of new Set(written(row[0] ?? null, 0)))
      runRows.set(label, [...(runRows.get(label) ?? []), at]);
  });
  const seen = new Map<string, number>();
  const runRowOf = rows.map((row) => {
    const label = cellKey(row[0] ?? "");
    const nth = seen.get(label) ?? 0;
    seen.set(label, nth + 1);
    return runRows.get(label)?.[nth];
  });
  const missing = given.rows.length - new Set(runRowOf.filter((at) => at !== undefined)).size;
  // Its headings say what its numbers are: renamed, or beside a column the run never gave, the
  // table is the User's words over the Analysis's numbers, which no rule vouches for.
  const shaped =
    headings.length === given.columns.length &&
    headings.every((heading, at) => cellKey(heading) === cellKey(given.columns[at] ?? ""));
  const columns: AnalysisTableColumn[] = kept.numeric
    .filter((column) => column > 0)
    .map((column) => {
      const check = kept.columns.find((each) => each.column === column);
      const differs: DifferingCell[] = [];
      const footed: AnalysisTableColumn["footed"] = [];
      let above = 0;
      for (const [index, row] of rows.entries()) {
        const label = row[0] ?? "";
        const note = cellKey(row[column] ?? "");
        const at = runRowOf[index];
        const value = at === undefined ? undefined : given.rows[at]?.[column];
        if (value !== undefined && written(value, column).includes(note)) {
          if (typeof value === "number") above += value;
          continue;
        }
        if (value === undefined && note === "") continue;
        // A total the User added is footed, as a table they typed is: it adds up the rows above it.
        if (
          value === undefined &&
          labelRole(label) !== "detail" &&
          written(above, column).includes(note)
        ) {
          footed.push({ label, sum: figureCellText(language, above, raw[column] ?? false) });
          continue;
        }
        differs.push({
          row: index,
          label,
          note,
          analysis:
            value === undefined ? null : figureCellText(language, value, raw[column] ?? false),
        });
      }
      return {
        column,
        heading: headings[column] ?? given.columns[column] ?? "",
        // A table with none of its rows left holds nothing a rule reproduced.
        rule: shaped && rows.length > 0 && check?.rule && earned(check.rule) ? check.rule : null,
        rows: shaped ? (check?.rows ?? 0) : 0,
        differs,
        footed,
      };
    });
  const wall = keptInside
    ? kept.citations.map((citation) => keptInside(citation.documentId)).find(Boolean)
    : null;
  // Behind a wall the Note is outside, the run backs nothing: no column reads recalculated.
  if (wall)
    return {
      state: { kind: "kept-inside", folder: wall },
      columns: columns.map((column) => ({ ...column, rule: null })),
      missing,
    };
  const differs = columns.some((column) => column.differs.length > 0);
  if (differs) return { state: { kind: "differs" }, columns, missing };
  for (const citation of kept.citations) {
    const current = versions?.get(citation.documentId);
    if (versions && current === undefined)
      return { state: { kind: "needs-recheck", why: "document-removed" }, columns, missing };
    if (current !== undefined && citation.contentHash !== null && current !== citation.contentHash)
      return { state: { kind: "needs-recheck", why: "new-version" }, columns, missing };
  }
  const held = [...headings, ...rows.map((row) => row[0] ?? "")].join(" ");
  const read =
    caption === null
      ? columns
      : columns.map((column) =>
          column.rule && captionMisnames(caption, column.rule.how, held)
            ? { ...column, captionMisnames: true as const }
            : column,
        );
  const recalculated = read.length > 0 && read.every(columnEarns);
  return { state: { kind: recalculated ? "recalculated" : "calculated" }, columns: read, missing };
}

const underItsInput = (column: AnalysisTableColumn, rule: AnalysisColumnRule) =>
  cellKey(column.heading).toLowerCase() === cellKey(rule.value).toLowerCase();

/**
 * Whether a column earns the badge's ✓ (#2378): recalculated under its input column's own name.
 * One under another heading ("Net" over gross sums) keeps its line, which says what it sums, but no
 * code reads a heading as naming another column, so it earns nothing.
 */
export const columnEarns = (column: AnalysisTableColumn): boolean =>
  column.rule !== null && !column.captionMisnames && underItsInput(column, column.rule);

/** A currency, by its sign or code, in English or Chinese. */
const CURRENCY = /[$€£¥￥₹₩]|\b(?:usd|eur|gbp|cny|rmb|jpy|chf|aud|cad|hkd)\b|元|英镑|镑/iu;
/**
 * A percent, or a share or rate that names one without its mark; a rate per item; a scale, written
 * out or abbreviated; or an aggregate no rule works out. 千, 万 and 亿 are a scale after a number, a
 * bracket or a colon, or before a unit or a closing bracket, never inside a name (万和路).
 */
const NOT_ITS_FIGURES =
  /[%％]|\bper ?cent\b|百分|\b(?:shares?|rates?|ratios?|proportions?)\b|占比|比例|份额|\bper\b|每|\b(?:k|m|mn|bn|mm|000s?)\b|\bmedian\b|中位|thousands?|millions?|billions?|(?:[\p{N}（(：:]\s*[千万亿])|(?:[千万亿](?:元|美元|欧元|英镑|次|人|件|吨|个|[）)]|$))/iu;
/** A period: a year or any number, a quarter, a month, a week or a day. */
const PERIOD =
  /\p{N}+|\b(?:q[1-4]|quarters?|quarterly|months?|monthly|years?|yearly|annual|weeks?|weekly|days?|daily|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|年|季度?|月|周|日/giu;

/**
 * Whether a caption says the table's figures are other than its columns' rules make them (#2378),
 * failing closed: another way of working them out ("Total amount by region" over averages, a
 * median), a currency, a percent, a rate per item, a scale, or a period `held` (the table's
 * headings and row labels) doesn't hold. Such a column keeps its line, which says what it is, but
 * earns no ✓.
 */
export function captionMisnames(caption: string, how: FigureHow, held = ""): boolean {
  if (CURRENCY.test(caption) || NOT_ITS_FIGURES.test(caption)) return true;
  const table = held.toLowerCase();
  if ([...caption.matchAll(PERIOD)].some(([period]) => !table.includes(period.toLowerCase())))
    return true;
  const words = new Set(caption.toLowerCase().match(/\p{L}+/gu) ?? []);
  return FIGURE_HOW.some(
    (other) =>
      other !== how &&
      AGGREGATE_WORDS[other].some((word) =>
        /\p{Script=Han}/u.test(word)
          ? caption.includes(word)
          : words.has(word) || words.has(`${word}s`),
      ),
  );
}

const sameOrNone = (named: AnalysisTableBinding | null, binding: AnalysisTableBinding) =>
  named !== null && sameBinding(named, binding);

/** The words of the caption line that holds `binding`'s marker, without the marker; null for none. */
export function captionTextOf(blocks: Y.XmlFragment, binding: AnalysisTableBinding): string | null {
  for (const line of blocks.toArray()) {
    if (!(line instanceof Y.XmlElement)) continue;
    const parts = line.toArray();
    const holds = parts.some(
      (part) =>
        part instanceof Y.XmlElement &&
        part.nodeName === ANALYSIS_TABLE_NODE &&
        sameOrNone(readTableBinding(part.getAttribute(ANALYSIS_TABLE_ATTRIBUTE)), binding),
    );
    if (holds)
      return parts.flatMap((part) => (part instanceof Y.XmlText ? [part.toString()] : [])).join("");
  }
  return null;
}

/**
 * A rule a column's line can stand on (#2378): one over a column and a key it can name. A count is
 * never one: what is counted can't be read from its heading, and small whole counts coincide.
 */
const earned = (rule: AnalysisColumnRule): rule is AnalysisColumnRule & { how: Aggregate } =>
  rule.how !== "count" && rule.value.trim() !== "" && rule.key.trim() !== "";

type Aggregate = Exclude<AnalysisColumnRule["how"], "count">;

/** A column's line on the table's card and under its Figure schedule row, in the figure card's words. */
export function columnLine(column: AnalysisTableColumn, language: Language): string {
  const { heading, rule } = column;
  if (!rule || !earned(rule))
    return translate(language, "figures.table.notRecalculated", { heading });
  const plural = column.rows === 1 ? "one" : "other";
  // Under another heading, the line says what it sums: "Net: sum of Gross over 12 rows".
  const named = !underItsInput(column, rule);
  return translate(
    language,
    `figures.table.recalculated.${rule.how}${named ? ".named" : ""}.${plural}`,
    {
      heading,
      column: rule.value,
      key: rule.key,
      count: figureText(language, column.rows),
    },
  );
}

/** The line that says how many of the run's rows the Note's table no longer holds; null for none. */
export const missingLine = (missing: number, language: Language): string | null =>
  missing === 0
    ? null
    : translate(language, `figures.table.rowsMissing.${missing === 1 ? "one" : "other"}`, {
        count: figureText(language, missing),
      });

/** A cell whose text in the Note isn't the Analysis's, under its column. */
export function differingLine(cell: DifferingCell, language: Language): string {
  return cell.analysis === null
    ? translate(language, "figures.table.notInAnalysis", { label: cell.label, written: cell.note })
    : translate(language, "figures.table.differs", {
        label: cell.label,
        written: cell.note,
        analysis: cell.analysis,
      });
}

/** How a Note's table `table` shows, read with the run the Note `doc` keeps of it (#2378). */
export function tableShownIn(
  doc: Y.Doc,
  table: NodeJSON,
  language: string,
  versions: ReadonlyMap<string, string> | null,
  keptInside: ((documentId: string) => string | null) | null = null,
): AnalysisTableShown {
  let kept: AnalysisTableMatch | null = null;
  try {
    kept = boundTableFor(table, keptAnalysisTables(figureRunsFor(doc, [table])));
  } catch (error) {
    console.error("Reading an Analysis table's run failed:", error);
  }
  const binding = readTableBinding(table.attrs?.[ANALYSIS_TABLE_ATTRIBUTE]);
  const caption = binding ? captionTextOf(doc.getXmlFragment(MIND_CONTENT_FIELD), binding) : null;
  return analysisTableShown(table, kept, language, versions, keptInside, caption);
}

/** Whether a table's state needs a look: a cell differs, or a Document it read changed. */
export const tableNeedsLook = (shown: AnalysisTableShown): boolean =>
  shown.state.kind === "differs" || shown.state.kind === "needs-recheck";

/** Each live Document's version, by id, as an Analysis table's state reads them; null while unknown. */
export const liveVersions = (
  documents: readonly { id: string; contentHash: string }[] | null,
): ReadonlyMap<string, string> | null =>
  documents === null ? null : new Map(documents.map((each) => [each.id, each.contentHash]));

/**
 * An Analysis table's footnote in Word, PDF and Markdown (#2378): the Analysis, and the rows of
 * each file it read, "from 40 rows of Orders.csv and 4 rows of Regions.csv".
 */
export function analysisTableNote(
  run: Pick<RetainedFigureAnalysis, "title" | "inputs">,
  language: Language,
): string {
  const ranges = run.inputs.flatMap((input) =>
    input.kind === "range" ? [{ rows: input.rows, file: input.citation.documentName }] : [],
  );
  const named = ranges.map(({ rows, file }) =>
    translate(language, rows === 1 ? "export.table.source.one" : "export.table.source.other", {
      count: figureText(language, rows),
      file,
    }),
  );
  const last = named.at(-1) ?? "";
  const sources =
    named.length < 2
      ? last
      : `${named.slice(0, -1).join(translate(language, "export.table.comma"))}${translate(language, "export.table.and")}${last}`;
  return translate(language, "export.table.analysis", { title: run.title, sources });
}

/** A footed total under its column: "The rows above add to 35,550", in footing's own words. */
export const footedLine = (footed: AnalysisTableColumn["footed"][number], language: Language) =>
  translate(language, "figures.foot.rows", { value: footed.sum });
