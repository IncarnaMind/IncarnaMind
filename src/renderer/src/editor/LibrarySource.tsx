import type { CitationLocation } from "../../../core/api";
import { libraryRow } from "../../../shared/libraryFacts";
import { useLanguage, useT } from "../i18n";

/**
 * A check's row for the Library fact that decided its sentence (#2525): "Your Library: 22
 * Documents". The facts are no Document's, so the row opens nothing.
 */
export function LibrarySource({
  location,
  className,
  testId,
}: {
  location: Extract<CitationLocation, { kind: "library" }>;
  className: string;
  testId: string;
}) {
  const t = useT();
  const language = useLanguage();
  const row = libraryRow(location, t, language);
  return (
    <p data-testid={testId} className={className} title={row}>
      {row}
    </p>
  );
}
