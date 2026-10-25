/**
 * Exporting a comparison table to Excel (#132): the table read as the Mind
 * holds it, its Citations' footnotes made as every export makes them, turned
 * into a sheet book (./comparisonSheet) and written as an .xlsx (./xlsx).
 */
import { deflateRawSync } from "node:zlib";
import { citationState, citedLocation, shownDocumentName } from "../../shared/citations";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import { mindName } from "../../shared/naming";
import { readableQuoteText } from "../../shared/readableQuote";
import { findBlock } from "../answers/blocks";
import { type CitationAttributes, COMPARISON_TABLE_NODE } from "../api";
import { NotFoundError } from "../errors";
import { safeFileName } from "../fileNames";
import { type Footnote, type ReadOptions, readComparisonTable, reviewReading } from "../mindText";
import { comparisonBook } from "./comparisonSheet";
import { type ExportsDependencies, footnoteOf } from "./index";
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

/** A comparison table as an .xlsx, with how many of its Citations aren't "Quote found". */
export interface ComparisonWorkbook {
  fileName: string;
  data: Uint8Array;
  unverifiedCitations: number;
}

export function createComparisonExport(deps: ComparisonExportDependencies) {
  return {
    workbook(mindId: unknown, tableId: unknown): ComparisonWorkbook {
      if (typeof tableId !== "string" || tableId === "") {
        throw new NotFoundError({ key: "error.comparison.notFound" });
      }
      const mind = deps.mind(mindId);
      const language = deps.language();
      const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
      const documents = deps.liveDocuments();
      const kept = deps.keptCitationTexts();
      const live = new Set(documents.map((document) => document.id));
      const attributesOf = new Map<Footnote, Partial<CitationAttributes>>();
      const reading = deps.read(mind.id, (fragment) => {
        const table = findBlock(fragment, COMPARISON_TABLE_NODE, tableId)?.element;
        if (!table) return null;
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
          // A table still waiting as a change is exported as it is shown.
          review: reviewReading(fragment),
        };
        return readComparisonTable(table, options);
      });
      if (!reading) throw new NotFoundError({ key: "error.comparison.notFound" });
      const { book, unverified } = comparisonBook({
        reading,
        textLanguage: deps.citationStyle(mind.id).textLanguage,
        t,
        facts: (footnote) => {
          const attributes = attributesOf.get(footnote) ?? {};
          return {
            document: shownDocumentName(attributes, documents) || t("export.unnamedDocument"),
            location: citedLocation(attributes, t),
            quote: attributes.quote
              ? (deps.readableQuote(attributes) ?? readableQuoteText(attributes.quote))
              : null,
            check: citationState(attributes, documents, kept).check,
          };
        },
      });
      const name = safeFileName(mindName(mind) || t("mind.untitled"), "Mind");
      return {
        fileName: `${name}.xlsx`,
        data: writeXlsx(book, deflateRawSync, { author: "IncarnaMind", created: deps.now() }),
        unverifiedCitations: unverified,
      };
    },
  };
}
