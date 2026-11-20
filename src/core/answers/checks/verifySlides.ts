/**
 * A verified deck's slides in its Mind (#3275): each slide's title a heading, each line of its
 * text boxes a paragraph, its tables as tables with each row one claim (./verifyTables), then its
 * charts' text and its speaker notes, which count as part of the slide (ADR-0011). A slide with
 * no text makes no Block.
 */
import type { SlideBox, SlideOutline } from "../../documents/formats/pptx";
import { headingRowsOf, isFigure, join } from "../../documents/tableCells";
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

const cellsOf = (table: readonly string[][]): string[][] => {
  const width = Math.max(0, ...table.map((row) => row.length));
  return table
    .map((row) => Array.from({ length: width }, (_, column) => (row[column] ?? "").trim()))
    .filter((row) => row.some((cell) => cell !== ""));
};

/**
 * A slide's table as the Mind keeps one, headed as a Word file's is (../../documents/tableCells):
 * the rows above the first that holds a figure. A table of words alone has no heading row, so
 * every row of it is checked.
 */
function gridOf(rows: readonly string[][]): TableGrid {
  const headingCount = headingRowsOf(rows);
  const body = rows.slice(headingCount);
  const columns = rows[0] ?? [];
  return {
    headings: columns.map((_, column) =>
      rows.slice(0, headingCount).reduce((said, row) => join(said, row[column] ?? ""), ""),
    ),
    rows: body.map((cells) => ({ cells, section: false })),
    numeric: columns.map((_, column) => {
      const filled = body.map((cells) => cells[column] ?? "").filter((cell) => cell !== "");
      return filled.length > 0 && filled.every(isFigure);
    }),
  };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

const placed = (box: SlideBox) =>
  box.place
    ? `${box.kind}, left ${percent(box.place.left)}, top ${percent(box.place.top)}, ${percent(box.place.width)} wide, ${percent(box.place.height)} high`
    : `${box.kind}, place not given`;

/**
 * A slide as the file holds it (#3455), for the models that read its lines: every box's text in
 * the file's order, each with where it sits on the slide, and the speaker notes. Which box says
 * what a number in another is, is theirs to read; nothing here pairs boxes. Its number is not in
 * it, so a slide put in before it leaves its lines' results standing (`slideHeading` names it).
 */
export function slideText(slide: SlideOutline): string {
  return [
    ...slide.boxes.map((box) => `[${placed(box)}] ${box.lines.join("\n  ")}`),
    ...(slide.notes.length > 0 ? ["[speaker notes]", ...slide.notes] : []),
  ].join("\n");
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
      const rows = cellsOf(table);
      // One column is a list set in a table: a row of one cell has nothing said about it to check.
      if ((rows[0]?.length ?? 0) < 2) {
        for (const [line] of rows) if (line) blocks.push({ node: paragraph(line), pages: [page] });
        continue;
      }
      const grid = gridOf(rows);
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
