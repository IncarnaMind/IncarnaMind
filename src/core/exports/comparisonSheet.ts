/**
 * A comparison table as a workbook (#132): the table's sheet, a Document a
 * row and a Question a column, each cell its Answer's text, or the number or
 * day it is (./figureCells) with its words as written in its note; each cell's
 * Citations in its note; and a Sources sheet, a Citation a row, that links back
 * to the cell citing it.
 */
import type { MessageKey, MessageParams } from "../../shared/i18n";
import type { CitationCheck } from "../api";
import type { Language } from "../language";
import type { ComparisonReading } from "../mindText";
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
  /** The language the Mind is written in, which settles how its Answers write numbers. */
  textLanguage: Language;
  t(key: MessageKey, params?: MessageParams): string;
  facts(footnote: Footnote): CitationFacts;
}

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
      if (cell.kind === "empty") return;
      if (cell.kind === "words") {
        cells.push({ column: question.id, value: { kind: "text", text: cell.text }, wrap: true });
        return;
      }
      const text = blocksText(cell.content);
      const figure = figureCell(text, input.textLanguage);
      const notes: string[] = figure ? [t("export.excel.asWritten", { text })] : [];
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
              value: { kind: "text", text: `${row.name} · ${question.text}` },
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
          name: t("comparison.title"),
          columns: [
            { id: DOCUMENT_COLUMN, width: 32 },
            ...reading.questions.map((question) => ({ id: question.id, width: 36 })),
          ],
          rows: [
            header([
              [DOCUMENT_COLUMN, t("comparison.document")],
              ...reading.questions.map((question): [string, string] => [
                question.id,
                question.text,
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
