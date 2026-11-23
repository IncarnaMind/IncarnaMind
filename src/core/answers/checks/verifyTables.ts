/**
 * A verified PDF's tables in its Mind (#1368), from its text layer and its scanned pages alike
 * (../../documents/tables): each a table of cells as the author laid it out, a table that goes on
 * over the page carrying its headings on, and each row one claim, said with its columns' headings.
 */
import * as Y from "yjs";
import { BLOCK_ID_ATTRIBUTE, type ScannedText } from "../../api";
import type { PagePart } from "../../documents/extract";
import { findTables, scannedRows, type TableGrid } from "../../documents/tables";
import type { NodeJSON } from "../blocks";
import { type DocumentPage, paragraphsOf } from "./claims";
import { type SelectedSentence, wordsOf } from "./sentences";

/** A Block the PDF's text makes, with the page of each of its rows (one for a paragraph). */
export interface DocumentBlock {
  node: NodeJSON;
  pages: number[];
}

function scannedParts(page: ScannedText["pages"][number]): PagePart[] | null {
  const rows = scannedRows(page.text, page.anchors, page.label?.scan?.turn ?? 0);
  const tables = findTables(rows);
  if (tables.length === 0) return null;
  const lines = page.text.split("\n");
  const parts: PagePart[] = [];
  let at = 0;
  for (const table of tables) {
    const before = lines.slice(at, table.first).join("\n").trim();
    if (before) parts.push({ kind: "text", text: before });
    parts.push({ kind: "table", grid: table.grid });
    at = table.last + 1;
  }
  const after = lines.slice(at).join("\n").trim();
  if (after) parts.push({ kind: "text", text: after });
  return parts;
}

/** The Blocks a PDF's text makes: its paragraphs, and its tables where its pages have them. */
export function documentBlocks(
  pages: readonly DocumentPage[],
  tables: ReadonlyMap<number, PagePart[]>,
  scanned: ScannedText["pages"],
): DocumentBlock[] {
  const blocks: { grid?: TableGrid; node?: NodeJSON; pages: number[] }[] = [];
  for (const unit of pages) {
    const scan = scanned.find((each) => each.page === unit.page);
    const parts = tables.get(unit.page) ??
      (scan && scannedParts(scan)) ?? [{ kind: "text" as const, text: unit.text }];
    parts.forEach((part, index) => {
      if (part.kind === "text") {
        for (const { text, heading } of paragraphsOf([{ ...unit, text: part.text }])) {
          blocks.push({
            node: {
              type: heading ? "heading" : "paragraph",
              ...(heading && { attrs: { level: 2 } }),
              content: [{ type: "text", text }],
            },
            pages: [unit.page],
          });
        }
        return;
      }
      const last = blocks.at(-1);
      // The page's first part, in the columns of the table that ended the page before: the same table.
      if (index === 0 && last?.grid && last.grid.numeric.length === part.grid.numeric.length) {
        const repeated = part.grid.headings.join("|") === last.grid.headings.join("|");
        const headed = part.grid.headings.some((heading) => heading !== "");
        if (repeated || !headed) {
          last.grid = { ...last.grid, rows: [...last.grid.rows, ...part.grid.rows] };
          last.pages.push(...part.grid.rows.map(() => unit.page));
          return;
        }
      }
      const headed = part.grid.headings.some((heading) => heading !== "");
      const earlier = [...blocks].reverse().find((block) => block.grid);
      // Over the page, with a running head between: a table with no headings of its own takes the one before's.
      const carried =
        !headed &&
        earlier?.grid &&
        earlier.pages.at(-1) === unit.page - 1 &&
        earlier.grid.numeric.length === part.grid.numeric.length
          ? earlier.grid.headings
          : null;
      const grid = carried ? { ...part.grid, headings: carried } : part.grid;
      blocks.push({
        grid,
        pages: [...(headed || carried ? [unit.page] : []), ...part.grid.rows.map(() => unit.page)],
      });
    });
  }
  return blocks.map(({ grid, node, pages: shown }) => ({
    node: grid ? tableNode(grid) : (node as NodeJSON),
    pages: shown,
  }));
}

const cell = (type: string, text: string, right: boolean | undefined): NodeJSON => ({
  type,
  attrs: { colspan: 1, rowspan: 1, ...(right && { align: "right" }) },
  content: [{ type: "paragraph", ...(text !== "" && { content: [{ type: "text", text }] }) }],
});

/** A table of cells as the Mind keeps it: its headings a row of header cells, its figures to the right. */
export function tableNode({ headings, rows, numeric }: TableGrid): NodeJSON {
  const headed = headings.some((heading) => heading !== "");
  return {
    type: "table",
    content: [
      ...(headed
        ? [
            {
              type: "tableRow",
              content: headings.map((text, column) => cell("tableHeader", text, numeric[column])),
            },
          ]
        : []),
      ...rows.map((row) => ({
        type: "tableRow",
        content: row.cells.map((text, column) => cell("tableCell", text, numeric[column])),
      })),
    ],
  };
}

/** A workbook's cells in its Note's table, by their paragraphs' ids (#3278). */
export interface WorkbookCells {
  /** The cells whose numbers are the workbook's own working. */
  formulas: ReadonlySet<string>;
  /**
   * The cells holding a typed-in number (#3412). Null in a Note checked before, whose rows were
   * judged on their words with their formulas' results left out.
   */
  typed: ReadonlySet<string> | null;
}

const paragraphOf = (cell: unknown): Y.XmlElement | null => {
  const paragraph = cell instanceof Y.XmlElement ? cell.toArray()[0] : null;
  return paragraph instanceof Y.XmlElement ? paragraph : null;
};

const isIn = (cell: unknown, ids: ReadonlySet<string> | null | undefined): boolean => {
  const id = ids && paragraphOf(cell)?.getAttribute(BLOCK_ID_ATTRIBUTE);
  return typeof id === "string" && ids?.has(id) === true;
};

/** A row's cells as its claim reads them: each as the Note shows it, but in a Note checked before #3412, a formula's result left out. */
const cellsOf = (row: Y.XmlElement, workbook?: WorkbookCells) =>
  row.toArray().map((each) => {
    const left = workbook?.typed === null && isIn(each, workbook.formulas);
    const paragraph = left ? null : paragraphOf(each);
    return paragraph ? wordsOf(paragraph).trim() : "";
  });

/**
 * A workbook row whose numbers are all formulas' results: the formulas are worked out again, and
 * no Document is asked about the row, so no mark sits beside a figure the model never read (#3412).
 */
const onlyWorkedOut = (row: Y.XmlElement, workbook: WorkbookCells | undefined): boolean => {
  if (!workbook?.typed) return false;
  const cells = row.toArray();
  return (
    cells.some((each) => isIn(each, workbook.formulas)) &&
    !cells.some((each) => isIn(each, workbook.typed))
  );
};

const isSection = (texts: readonly string[]) =>
  /[:：]$/.test(texts[0] ?? "") && texts.slice(1).every((text) => text === "");

/**
 * A table's row, as one claim on its first cell: "固定资产 — 期末余额: 9,470; 期初余额: 8,860",
 * with what its words refer to: the table's caption, and the section it is in. "not-a-claim" for
 * the heading row, a section's own row and every other cell; null outside a table.
 */
export function tableClaim(
  sentence: SelectedSentence,
  workbook?: WorkbookCells,
): { claim: string; context: string } | "not-a-claim" | null {
  const cell = sentence.element.parent;
  const row = cell instanceof Y.XmlElement ? cell.parent : null;
  const table = row instanceof Y.XmlElement ? row.parent : null;
  if (!(cell instanceof Y.XmlElement && row instanceof Y.XmlElement)) return null;
  if (!(table instanceof Y.XmlElement && table.nodeName === "table")) return null;
  if (onlyWorkedOut(row, workbook)) return "not-a-claim";
  const texts = cellsOf(row, workbook);
  const anchor = texts.findIndex((text) => text !== "");
  if (cell.nodeName === "tableHeader" || row.toArray().indexOf(cell) !== anchor) {
    return "not-a-claim";
  }
  if (isSection(texts)) return "not-a-claim";
  const rows = table.toArray().filter((each) => each instanceof Y.XmlElement);
  const first = rows[0];
  const headed =
    first instanceof Y.XmlElement && first.toArray()[0] instanceof Y.XmlElement
      ? (first.toArray()[0] as Y.XmlElement).nodeName === "tableHeader"
      : false;
  const headings = headed && first ? cellsOf(first) : [];
  const label = anchor === 0 ? texts[0] : "";
  const values = texts.flatMap((text, column) => {
    if (text === "" || (label && column === 0)) return [];
    const heading = headings[column] ?? "";
    return [heading ? `${heading}: ${text}` : text];
  });
  if (values.length === 0) return "not-a-claim";
  const section = rows
    .slice(0, rows.indexOf(row))
    .reverse()
    .map((each) => cellsOf(each, workbook))
    .find(isSection)?.[0];
  const before = table.prevSibling;
  const caption =
    before instanceof Y.XmlElement && before.nodeName !== "table" ? wordsOf(before).trim() : "";
  const claim = `${label ? `${label} — ` : ""}${values.join("; ")}`;
  const context = [caption, section].filter((each) => each).join("\n");
  return { claim, context: context || claim };
}
