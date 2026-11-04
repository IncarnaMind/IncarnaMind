import type { CitationAttributes, CitationLocation } from "../../../core/api";
import { shownDocumentName } from "../../../shared/citations";
import { propertyRow } from "../../../shared/fileProperties";
import { useLanguage, useT } from "../i18n";
import { useInfo } from "../info";
import { useAppStore } from "../store";

type Properties = Extract<CitationLocation, { kind: "properties" }>;

/** The Document's info panel, once the card that asked for it has closed and given the focus back. */
export function showFileProperties(documentId: string, onOpen: () => void): void {
  onOpen();
  requestAnimationFrame(() => useInfo.getState().open({ kind: "document", id: documentId }, null));
}

/**
 * A check's row for the file property that decided its sentence (#2458): "Properties of
 * “Services agreement.docx”: Modified 2 Nov 2026 (the file’s own date)". It opens the Document's
 * info panel, where the same date is, while the Document is in the Library.
 */
export function PropertySource({
  citation,
  location,
  className,
  testId,
  onOpen,
}: {
  citation: Pick<CitationAttributes, "documentId" | "documentName">;
  location: Properties;
  className: string;
  testId: string;
  onOpen(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const documents = useAppStore((store) => store.documents);
  const { documentId } = citation;
  const known = documentId !== null && documents.some((each) => each.id === documentId);
  const row = propertyRow(location, shownDocumentName(citation, documents) ?? "", t, language);
  if (!known || documentId === null) {
    return (
      <p data-testid={testId} className={className} title={row}>
        {row}
      </p>
    );
  }
  return (
    <button
      type="button"
      data-testid={testId}
      className={className}
      title={row}
      onClick={() => showFileProperties(documentId, onOpen)}
    >
      {row}
    </button>
  );
}
