/**
 * A comparison table as a workbook (#132): the table's sheet, a Document a
 * row and a Question a column, each cell its Answer's text, or the number or
 * day it is (./figureCells) with its words as written in its note; each cell's
 * Citations in its note; and a Sources sheet, a Citation a row, that links back
 * to the cell citing it, and the User's column widths come along in characters.
 */
import { comparisonNameOf } from "../../shared/comparisons";
import { formatDate } from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import type { CitationCheck } from "../api";
import { checkedByLine } from "../checkRecord/labels";
import type { Language } from "../language";
import type { ComparisonCellReading, ComparisonReading } from "../mindText";
import { type Block, type Footnote, footnotesIn, type Inline } from "../mindText";
import { figureCell } from "./figureCells";
import type { SheetBook, SheetCell, SheetRow } from "./sheets";

/** What the Sources sheet and a cell's note say of one Citation. */
export interface CitationFacts {
  document: string;
  location: string | null;
  quote: string | null;
  check: CitationCheck;
}

export interface ComparisonSheetInput {
  reading: ComparisonReading;
  /** The table's own name, which its sheet is called. */
  title: string;
  /** The interface's language, which writes the days in the cells' notes. */
  language: Language;
  /** The language the Mind is written in, which settles how its Answers write numbers. */
  textLanguage: Language;
  t(key: MessageKey, params?: MessageParams): string;
  facts(footnote: Footnote): CitationFacts;
}

/** Whoever opens the file isn't "you": a mark names the person who made it, and when. */
const markNotes = (
  cell: ComparisonCellReading,
  { t, language }: ComparisonSheetInput,
): string[] => [
  ...(cell.edited ? [t("export.excel.edited")] : []),
  ...(cell.signOffs ?? []).map((now) => checkedByLine(now, (at) => formatDate(at, language), t)),
  ...(cell.kind === "answer" && cell.failure ? [cell.failure] : []),
];

const CHECK_WORDS: Readonly<Record<CitationCheck, MessageKey>> = {
  found: "aiStatement.citations.found",
  "not-found": "aiStatement.citations.notFound",
  "cant-check": "aiStatement.citations.cantCheck",
  unsupported: "aiStatement.citations.unsupported",
  contradicted: "aiStatement.citations.contradicted",
  checking: "aiStatement.citations.checking",
};

function inlineText(content: readonly Inline[]): string {
  return content
    .map((inline) => {
      switch (inline.kind) {
        case "text":
          return inline.text;
        case "figure":
          return inline.figure.shown;
        case "break":
          return "\n";
        case "math":
          return inline.latex;
        default:
          return "";
      }
    })
    .join("");
}

/** An Answer's words, a line a paragraph and "• " before a list's items; Citations are its note's. */
export function blocksText(blocks: readonly Block[]): string {
  const lines: string[] = [];
  const visit = (block: Block, bullet: string) => {
    switch (block.kind) {
      case "paragraph":
      case "heading":
      case "question":
        lines.push(bullet + inlineText(block.content).trim());
        return;
      case "list":
        block.items.forEach((item, index) => {
          const mark = block.ordered ? `${block.start + index}. ` : "• ";
          for (const [at, each] of item.entries()) visit(each, at === 0 ? mark : "  ");
        });
        return;
      case "quote":
        for (const each of block.content) visit(each, bullet);
        return;
      case "code":
        lines.push(block.code);
        return;
      case "math":
        lines.push(block.latex);
        return;
      case "table":
        for (const row of block.rows) {
          lines.push(row.map((cell) => blocksText(cell.content)).join("\t"));
        }
        return;
      default:
        return;
    }
  };
  for (const block of blocks) visit(block, "");
  return lines.filter((line) => line.trim() !== "").join("\n");
}

const TABLE = "table";
const SOURCES = "sources";
const DOCUMENT_COLUMN = "document";
/** Excel's default column, and how many pixels of the page one of its characters holds. */
const DEFAULT_COLUMN_WIDTH = 36;
const PIXELS_PER_CHARACTER = 7;

/** A column's width as Excel counts it, from the width it has on the page. */
function columnWidthOf(width: number | undefined): number {
  if (width === undefined) return DEFAULT_COLUMN_WIDTH;
  return Math.max(8, Math.min(120, Math.round(width / PIXELS_PER_CHARACTER)));
}

/** The table and its Sources as a sheet book, and how many of its Citations aren't "Quote found". */
export function comparisonBook(input: ComparisonSheetInput): {
  book: SheetBook;
  unverified: number;
} {
  const { reading, t } = input;
  const sources: SheetRow[] = [];
  const header = (cells: [column: string, text: string][]): SheetRow => ({
    id: "head",
    header: true,
    cells: cells.map(([column, text]) => ({ column, value: { kind: "text", text } })),
  });
  let unverified = 0;
  const rows = reading.rows.map((row, rowAt): SheetRow => {
    const rowId = `row-${rowAt}`;
    const cells: SheetCell[] = [
      { column: DOCUMENT_COLUMN, value: { kind: "text", text: row.name }, wrap: true },
    ];
    row.cells.forEach((cell, at) => {
      const question = reading.questions[at];
      if (!question) return;
      const marks = markNotes(cell, input);
      if (cell.kind === "empty") {
        if (marks.length > 0) {
          cells.push({
            column: question.id,
            value: { kind: "text", text: "" },
            note: marks.join("\n\n"),
            wrap: true,
          });
        }
        return;
      }
      if (cell.kind === "words") {
        cells.push({
          column: question.id,
          value: { kind: "text", text: cell.text },
          ...(marks.length > 0 && { note: marks.join("\n\n") }),
          wrap: true,
        });
        return;
      }
      const text = blocksText(cell.content);
      const figure = figureCell(text, input.textLanguage);
      const notes = [...marks, ...(figure ? [t("export.excel.asWritten", { text })] : [])];
      for (const footnote of footnotesIn(cell.content)) {
        const facts = input.facts(footnote);
        if (footnote.unverified) unverified++;
        notes.push(
          [
            `${footnote.source}${footnote.unverified ? ` ${t("export.unverified")}` : ""}`,
            facts.quote ? `“${facts.quote}”` : null,
          ]
            .filter(Boolean)
            .join(": "),
        );
        sources.push({
          id: `source-${sources.length}`,
          cells: [
            {
              column: "cell",
              value: { kind: "text", text: `${row.name} · ${comparisonNameOf(question)}` },
              link: { sheet: TABLE, row: rowId, column: question.id },
              wrap: true,
            },
            { column: "document", value: { kind: "text", text: facts.document }, wrap: true },
            {
              column: "location",
              value: facts.location ? { kind: "text", text: facts.location } : { kind: "empty" },
            },
            {
              column: "quote",
              value: facts.quote ? { kind: "text", text: facts.quote } : { kind: "empty" },
              wrap: true,
            },
            { column: "result", value: { kind: "text", text: t(CHECK_WORDS[facts.check]) } },
          ],
        });
      }
      cells.push({
        column: question.id,
        value: figure ? figure.value : { kind: "text", text },
        ...(figure && { format: figure.format }),
        ...(notes.length > 0 && { note: notes.join("\n\n") }),
        wrap: figure === null,
      });
    });
    return { id: rowId, cells };
  });
  return {
    unverified,
    book: {
      sheets: [
        {
          id: TABLE,
          name: input.title,
          columns: [
            { id: DOCUMENT_COLUMN, width: 32 },
            ...reading.questions.map((question) => ({
              id: question.id,
              width: columnWidthOf(question.width),
            })),
          ],
          rows: [
            header([
              [DOCUMENT_COLUMN, t("comparison.document")],
              ...reading.questions.map((question): [string, string] => [
                question.id,
                comparisonNameOf(question),
              ]),
            ]),
            ...rows,
          ],
          frozen: { rows: 1, columns: 1 },
        },
        {
          id: SOURCES,
          name: t("export.excel.sources"),
          columns: [
            { id: "cell", width: 40 },
            { id: "document", width: 32 },
            { id: "location", width: 16 },
            { id: "quote", width: 60 },
            { id: "result", width: 22 },
          ],
          rows: [
            header([
              ["cell", t("export.excel.cell")],
              ["document", t("checkRecord.column.document")],
              ["location", t("checkRecord.column.location")],
              ["quote", t("checkRecord.column.quote")],
              ["result", t("checkRecord.column.result")],
            ]),
            ...sources,
          ],
          frozen: { rows: 1, columns: 0 },
        },
      ],
    },
  };
}
