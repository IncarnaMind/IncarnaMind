/**
 * A verified deck's slides in its Mind (#3275): each slide's title a heading, each line of its
 * text boxes a paragraph, its tables as tables with each row one claim (./verifyTables), then its
 * charts' text and its speaker notes, which count as part of the slide (ADR-0011). A slide with
 * no text makes no Block.
 */
import { looksLikeFigure } from "../../documents/formats/grid";
import type { SlideOutline } from "../../documents/formats/pptx";
import type { TableGrid } from "../../documents/tables";
import type { NodeJSON } from "../blocks";
import { type DocumentBlock, tableNode } from "./verifyTables";

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

const paragraph = (text: string): NodeJSON => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

/** A slide's table as the Mind keeps one: its first row the headings, unless that row holds figures. */
function gridOf(table: readonly string[][]): TableGrid | null {
  const width = Math.max(0, ...table.map((row) => row.length));
  const rows = table
    .map((row) => Array.from({ length: width }, (_, column) => (row[column] ?? "").trim()))
    .filter((row) => row.some((cell) => cell !== ""));
  const [first, ...rest] = rows;
  if (!first) return null;
  const headed = rest.length > 0 && !first.some(looksLikeFigure);
  const body = headed ? rest : rows;
  return {
    headings: headed ? first : first.map(() => ""),
    rows: body.map((cells) => ({ cells, section: false })),
    numeric: first.map((_, column) => {
      const filled = body.map((cells) => cells[column] ?? "").filter((cell) => cell !== "");
      return filled.length > 0 && filled.every(looksLikeFigure);
    }),
  };
}

/** The Blocks a deck's slides make, each with its slide's number, as `documentBlocks` gives a PDF's. */
export function slideBlocks(slides: readonly SlideOutline[]): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  for (const slide of slides) {
    const page = slide.number;
    const title = slide.title?.trim();
    if (title) {
      blocks.push({
        node: { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: title }] },
        pages: [page],
      });
    }
    for (const line of slide.blocks.flatMap((box) => box.flatMap(lines))) {
      blocks.push({ node: paragraph(line), pages: [page] });
    }
    for (const table of slide.tables) {
      const grid = gridOf(table);
      if (!grid) continue;
      const headed = grid.headings.some((heading) => heading !== "");
      blocks.push({
        node: tableNode(grid),
        pages: [...(headed ? [page] : []), ...grid.rows.map(() => page)],
      });
    }
    for (const line of [...slide.charts, ...slide.notes].flatMap(lines)) {
      blocks.push({ node: paragraph(line), pages: [page] });
    }
  }
  return blocks;
}
