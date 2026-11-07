/**
 * Exporting a comparison table (#132, #1839): the table read as the Mind
 * holds it, its Citations' footnotes made as every export makes them, turned
 * into a sheet book (./comparisonSheet) and written as an .xlsx or a .csv.
 */
import { deflateRawSync } from "node:zlib";
import { citationState, citedLocation, citedName, shownDocumentName } from "../../shared/citations";
import { comparisonQuestionsOf, comparisonTitleOf } from "../../shared/comparisons";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import { readableQuoteText } from "../../shared/readableQuote";
import { comparisonCellContent, comparisonCellMarksNow, signOffsOf } from "../../shared/signOffs";
import { findBlock, nodeOf } from "../answers/blocks";
import { type CitationAttributes, COMPARISON_TABLE_NODE } from "../api";
import { NotFoundError } from "../errors";
import { safeFileName } from "../fileNames";
import { type Footnote, type ReadOptions, readComparisonTable, reviewReading } from "../mindText";
import { comparisonBook, comparisonCsv } from "./comparisonSheet";
import { type ExportsDependencies, footnoteOf } from "./index";
import type { SheetBook } from "./sheets";
import { writeXlsx } from "./xlsx";

export type ComparisonExportDependencies = Pick<
  ExportsDependencies,
  | "mind"
  | "read"
  | "liveDocuments"
  | "keptCitationTexts"
  | "readableQuote"
  | "language"
  | "citationStyle"
  | "now"
>;

/** A comparison table written as a file, with how many of its Citations aren't "Quote found". */
export interface ComparisonFile {
  fileName: string;
  data: Uint8Array;
  unverifiedCitations: number;
  /** The columns left out of the file, for the app to say so. */
  hiddenColumns: number;
}

interface ComparisonRead {
  book: SheetBook;
  sourcesHeading: string;
  name: string;
  unverified: number;
  hiddenColumns: number;
}

export function createComparisonExport(deps: ComparisonExportDependencies) {
  function read(
    mindId: unknown,
    tableId: unknown,
    keepDocumentIds?: readonly string[],
  ): ComparisonRead {
    if (typeof tableId !== "string" || tableId === "") {
      throw new NotFoundError({ key: "error.comparison.notFound" });
    }
    const mind = deps.mind(mindId);
    const language = deps.language();
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    const documents = deps.liveDocuments();
    const kept = deps.keptCitationTexts();
    const live = new Set(documents.map((document) => document.id));
    const versions = new Map(documents.map((document) => [document.id, document.contentHash]));
    const attributesOf = new Map<Footnote, Partial<CitationAttributes>>();
    let hiddenColumns = 0;
    let title = "";
    const reading = deps.read(mind.id, (fragment) => {
      const table = findBlock(fragment, COMPARISON_TABLE_NODE, tableId)?.element;
      if (!table) return null;
      title = comparisonTitleOf(table.getAttributes()) || t("comparison.title");
      hiddenColumns = comparisonQuestionsOf(table.getAttributes()).filter(
        (question) => question.hidden === true,
      ).length;
      const marks = fragment.doc ? signOffsOf(fragment.doc) : [];
      const options: ReadOptions = {
        includeQuestions: false,
        footnote: (attributes) => {
          const note = footnoteOf(attributes, documents, kept, language, deps);
          attributesOf.set(note, attributes);
          return note;
        },
        trimBeforeCitation: true,
        trimBeforeFootnote: true,
        comparisonText: t,
        documentRemoved: (documentId) => !live.has(documentId),
        leaveOutHiddenColumns: true,
        cellSignOffs: (target, cell) =>
          comparisonCellMarksNow(
            marks,
            target,
            comparisonCellContent(nodeOf(cell)),
            versions,
            null,
          ),
        // A table still waiting as a change is exported as it is shown.
        review: reviewReading(fragment),
      };
      return readComparisonTable(table, options);
    });
    if (!reading) throw new NotFoundError({ key: "error.comparison.notFound" });
    const keep = keepDocumentIds ? new Set(keepDocumentIds) : null;
    const rows = keep ? reading.rows.filter((row) => keep.has(row.documentId)) : reading.rows;
    const { book, unverified } = comparisonBook({
      reading: { ...reading, rows },
      title: title || t("comparison.title"),
      language,
      textLanguage: deps.citationStyle(mind.id).textLanguage,
      t,
      facts: (footnote) => {
        const attributes = attributesOf.get(footnote) ?? {};
        return {
          document: citedName(
            {
              ...attributes,
              documentName: shownDocumentName(attributes, documents) || t("export.unnamedDocument"),
            },
            t,
            language,
          ),
          location: citedLocation(attributes, t),
          quote: attributes.quote
            ? (deps.readableQuote(attributes) ?? readableQuoteText(attributes.quote))
            : null,
          check: citationState(attributes, documents, kept).check,
        };
      },
    });
    return {
      book,
      sourcesHeading: t("export.excel.sources"),
      name: safeFileName(title || t("comparison.title"), t("comparison.title")),
      unverified,
      hiddenColumns,
    };
  }

  return {
    workbook(mindId: unknown, tableId: unknown): ComparisonFile {
      const { book, name, unverified, hiddenColumns } = read(mindId, tableId);
      return {
        fileName: `${name}.xlsx`,
        data: writeXlsx(book, deflateRawSync, { author: "IncarnaMind", created: deps.now() }),
        unverifiedCitations: unverified,
        hiddenColumns,
      };
    },

    /** The table as CSV (#1839): what is shown, its rows limited to `documentIds` when given. */
    csv(mindId: unknown, tableId: unknown, documentIds?: unknown): ComparisonFile {
      const keep =
        Array.isArray(documentIds) && documentIds.every((id) => typeof id === "string")
          ? (documentIds as string[])
          : undefined;
      const { book, name, unverified, hiddenColumns, sourcesHeading } = read(mindId, tableId, keep);
      return {
        fileName: `${name}.csv`,
        data: new TextEncoder().encode(comparisonCsv(book, sourcesHeading)),
        unverifiedCitations: unverified,
        hiddenColumns,
      };
    },
  };
}
