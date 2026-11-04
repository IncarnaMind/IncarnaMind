/**
 * An Analysis's own result table in an Answer or a Note (#2378): its numbers are
 * the Analysis's, not text typed again, and each numeric column says where it
 * was read from — the Analysis's inputs, cited to the rows it read.
 *
 * The table is found again by what it holds: the exact headings and cells the
 * Analysis gave, formatted as the interface writes them.
 */
import type { AnswerAnalysis, AnswerAnalysisInput, Citation } from "../core/api";
import type { AnalysisCell, AnalysisTable } from "./analysis";
import type { NodeJSON } from "./blockJson";
import { citationNode } from "./blockJson";
import { figureCellText, rawColumn } from "./figures";

type AnalysisTableInput = Pick<AnswerAnalysis, "number" | "output" | "inputs">;

/** Each Citation an Analysis read its data from, once: its ranges and the numbers quoted from a Passage. */
function analysisInputCitations(inputs: readonly AnswerAnalysisInput[]): Citation[] {
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

const holdsCitation = (node: NodeJSON): boolean =>
  node.type === "citation" || (node.content ?? []).some(holdsCitation);

/** Where a table's heading row says it read: an Analysis table's own headings name its inputs. */
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

/** How many Citations `blocks` hold: what a Note written with them cites. */
export function countCitations(blocks: readonly NodeJSON[]): number {
  return blocks.reduce(
    (count, block) =>
      count + ((block.type === "citation" ? 1 : 0) + countCitations(block.content ?? [])),
    0,
  );
}

function citeCell(cell: NodeJSON, citations: readonly Citation[]): NodeJSON {
  if (holdsCitation(cell)) return cell;
  const content = cell.content ?? [];
  const last = content.at(-1);
  const marked = citations.map((citation) => citationNode(citation));
  if (last?.type !== "paragraph") {
    return { ...cell, content: [...content, { type: "paragraph", content: marked }] };
  }
  return {
    ...cell,
    content: [...content.slice(0, -1), { ...last, content: [...(last.content ?? []), ...marked] }],
  };
}

/** A table an Analysis gave, as a Block reads it back: its grids, its numbers and where they came from. */
export interface AnalysisTableMatch {
  /** The table's grid as it reads in each language the interface writes: its headings, then its rows. */
  grids: string[][][];
  /** Its columns that hold numbers. */
  numeric: number[];
  /** Each Citation the Analysis read its data from, once. */
  citations: Citation[];
  /** What the Analysis gave at a data row (0 the first below the headings) and a column; null: no number. */
  value(row: number, column: number): number | null;
}

/** Every result table and chart an Analysis gave, as a Note reads them back. */
export function analysisTablesOf(analyses: readonly AnalysisTableInput[]): AnalysisTableMatch[] {
  return analyses.flatMap((analysis) => {
    const made: AnalysisTableMatch[] = [];
    const add = (table: AnalysisTable) =>
      made.push({
        grids: LANGUAGES.map((language) => analysisGrid(table, language)),
        numeric: numericColumns(table),
        citations: analysisInputCitations(analysis.inputs),
        value: (row, column) => {
          const given = table.rows[row]?.[column];
          return typeof given === "number" && Number.isFinite(given) ? given : null;
        },
      });
    for (const result of analysis.output.results) if (result.kind === "table") add(result.table);
    for (const chart of analysis.output.charts) add(chart.table);
    return made;
  });
}

/** The Analysis table `block` is, matched by what it holds, as the Answer or Note writes it; null: another table. */
export function analysisTableFor(
  block: NodeJSON,
  tables: readonly AnalysisTableMatch[],
): AnalysisTableMatch | null {
  if (block.type !== "table") return null;
  const grid = gridOf(block);
  const cited = citedPlaces(block);
  const matches = tables.filter((table) => {
    if (table.citations.length === 0) return false;
    // A table whose headings cite other Documents or other places came from another Analysis,
    // though it reads the same: Orders' November sheet and its October sheet give one table (#2378).
    if (
      cited.size > 0 &&
      table.citations.some((citation) => {
        const name = citation.documentId || citation.documentName || "";
        if (name === "") return false;
        return !cited.has(
          JSON.stringify([
            name,
            citation.location ?? null,
            citation.contentHash ?? null,
            citation.passageId ?? null,
          ]),
        );
      })
    )
      return false;
    return table.grids.some(
      (cells) =>
        cells.length === grid.length &&
        grid.every((row, at) => row.join("\u0000") === (cells[at] ?? []).join("\u0000")),
    );
  });
  const [first] = matches;
  if (!first) return null;
  // Two Analyses that read the same rows can give the same table: cited to either alone would name
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

/**
 * `blocks` with each Analysis result table's numeric headings citing the
 * Analysis's inputs; a table that isn't one keeps no Citations.
 */
export function withAnalysisTableCitations(
  blocks: readonly NodeJSON[],
  analyses: readonly AnalysisTableInput[] | undefined,
): NodeJSON[] {
  if (!analyses || analyses.length === 0) return [...blocks];
  const tables = analysisTablesOf(analyses);
  if (tables.length === 0) return [...blocks];
  return blocks.map((block) => {
    const found = analysisTableFor(block, tables);
    if (!found) return block;
    const headingRow = block.content?.[0];
    if (!headingRow) return block;
    const cells = (headingRow.content ?? []).map((cell, at) =>
      found.numeric.includes(at) ? citeCell(cell, found.citations) : cell,
    );
    return {
      ...block,
      content: [{ ...headingRow, content: cells }, ...(block.content ?? []).slice(1)],
    };
  });
}
