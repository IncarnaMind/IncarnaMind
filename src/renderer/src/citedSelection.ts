import type { CitationAttributes, CitedSelection, Document } from "../../core/api";

/** The attributes a Citation of `cited` in `document` is stored with. */
export function citationAttributesOf(
  cited: CitedSelection,
  document: Pick<Document, "id" | "name">,
): CitationAttributes {
  return {
    passageId: cited.passageId,
    documentId: document.id,
    documentName: document.name,
    contentHash: cited.contentHash,
    pageFrom: cited.pageFrom,
    pageTo: cited.pageTo,
    location: cited.location,
    quote: cited.quote,
    check: cited.check,
    checkReason: cited.checkReason,
    ...(cited.yourNoteAt && { yourNoteAt: cited.yourNoteAt }),
    ...(cited.unsure && cited.unsure.length > 0 && { unsure: cited.unsure }),
  };
}
