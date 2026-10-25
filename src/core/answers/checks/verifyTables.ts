/**
 * A verified PDF's tables in its Mind (#1368), from its text layer and its scanned pages alike
 * (../../documents/tables): each a table of cells as the author laid it out, a table that goes on
 * over the page carrying its headings on, and each row one claim, said with its columns' headings.
 */
import * as Y from "yjs";
import type { DocumentText, ScannedText } from "../../api";
import type { PagePart } from "../../documents/extract";
import { findTables, scannedRows, type TableGrid } from "../../documents/tables";
import type { NodeJSON } from "../blocks";
import { paragraphsOf } from "./claims";
import { cellTexts, type SelectedSentence, textBefore } from "./sentences";

/** A Block the PDF's text makes, with the page of each of its rows (one for a paragraph). */
export interface DocumentBlock {
  node: NodeJSON;
  pages: number[];
}

function scannedParts(page: ScannedText["pages"][number]): PagePart[] | null {
  const rows = scannedRows(page.text, page.anchors);
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
  pages: DocumentText["pages"],
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

function tableNode({ headings, rows, numeric }: TableGrid): NodeJSON {
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

const isSection = (texts: readonly string[]) =>
  /[:：]$/.test(texts[0] ?? "") && texts.slice(1).every((text) => text === "");

/**
 * A table's row, as one claim on its first cell: "固定资产 — 期末余额: 9,470; 期初余额: 8,860",
 * with what its words refer to: the table's caption, and the section it is in. "not-a-claim" for
 * the heading row, a section's own row and every other cell; null outside a table.
 */
export function tableClaim(
  sentence: SelectedSentence,
): { claim: string; context: string } | "not-a-claim" | null {
  const cell = sentence.element.parent;
  const row = cell instanceof Y.XmlElement ? cell.parent : null;
  const table = row instanceof Y.XmlElement ? row.parent : null;
  if (!(cell instanceof Y.XmlElement && row instanceof Y.XmlElement)) return null;
  if (!(table instanceof Y.XmlElement && table.nodeName === "table")) return null;
  const texts = cellTexts(row);
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
  const headings = headed && first ? cellTexts(first) : [];
  const label = anchor === 0 ? texts[0] : "";
  const values = texts.flatMap((text, column) => {
    if (text === "" || (label && column === 0)) return [];
    const heading = headings[column] ?? "";
    return [heading ? `${heading}: ${text}` : text];
  });
  if (values.length === 0) return "not-a-claim";
  const section = rows.slice(0, rows.indexOf(row)).reverse().map(cellTexts).find(isSection)?.[0];
  const caption = textBefore(table);
  const claim = `${label ? `${label} — ` : ""}${values.join("; ")}`;
  const context = [caption, section].filter((each) => each).join("\n");
  return { claim, context: context || claim };
}
