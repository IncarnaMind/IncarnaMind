import type { ClaimReadDocument } from "../../../core/api";
import type { Language } from "../../../core/language";
import { type LiveDocument, shownDocumentName } from "../../../shared/citations";
import { unitsOf } from "../../../shared/i18n/join";
import { formatLocation, type Translate } from "../../../shared/locations";

/**
 * The Documents a check read whole, as its card lists them: each by name with the places it found
 * in it, "Lease.pdf (p. 3, p. 5); Notes.docx".
 */
export function readDocumentsText(
  read: readonly ClaimReadDocument[],
  documents: readonly LiveDocument[] | null,
  t: Translate,
  language: Language,
): string {
  return read
    .map((document) => {
      const name = shownDocumentName(document, documents) || document.documentName;
      const places = unitsOf(
        document.locations.map((location) => formatLocation(location, t)),
        language,
      );
      return places ? `${name} (${places})` : name;
    })
    .join(t("claim.readDocuments.separator"));
}
