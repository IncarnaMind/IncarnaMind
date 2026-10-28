import type { LiveDocument } from "../../shared/citations";
import type { UnitText } from "../../shared/units";
import type { DocumentTextMatch } from "../api";
import type { EvidenceScope } from "../documents/evidence";
import type { RecordCiteDocument } from "./resolver";

interface RecordCiteDocumentSource {
  names?(): readonly LiveDocument[];
  pageTexts(
    documentId: string,
    contentHash: string,
    from: number | null,
    to: number | null,
  ): readonly UnitText[];
  searchText?(query: string, options: { limit: number }): DocumentTextMatch[];
  batesMatch?(documentId: string, prefix: string, identifier: string): boolean;
}

export function recordDocuments(
  documents: RecordCiteDocumentSource,
  scope: EvidenceScope,
): RecordCiteDocument[] {
  const allowed = scope.documentIds === null ? null : new Set(scope.documentIds);
  return (documents.names?.() ?? [])
    .filter(
      (document) =>
        (allowed === null || allowed.has(document.id)) && !scope.excluded.has(document.id),
    )
    .map((document) => {
      let units: readonly UnitText[] | undefined;
      return {
        id: document.id,
        name: document.name ?? document.title ?? "",
        contentHash: document.contentHash,
        get units() {
          units ??= documents.pageTexts(document.id, document.contentHash, null, null);
          return units;
        },
        batesMatch(prefix, identifier) {
          if (documents.batesMatch) return documents.batesMatch(document.id, prefix, identifier);
          if (!documents.searchText) return true;
          const matches = documents.searchText(`${prefix}-${identifier}`, { limit: 200 });
          // A full result page cannot prove absence, so exact Unit validation must decide it.
          if (matches.length === 200) return true;
          return matches.some((match) => match.documentId === document.id);
        },
      };
    });
}
