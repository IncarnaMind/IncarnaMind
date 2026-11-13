import type { DocumentPlace } from "../../../core/api";
import { citedLocation, type LiveDocument } from "../../../shared/citations";
import type { Translate } from "../../../shared/locations";
import type { ViewerTarget } from "../store";

/**
 * Whether the Units a page was opened at are missing from its Document, which has `unitCount`
 * Units, numbered from 1 (ADR-0011): the file changed after the Citation was made. Every view
 * asks this once it knows its Units, and then washes no quote and has its header say so
 * (`citedPlaceGoneLine`), rather than look for the quote where it isn't cited. Where the view
 * opens stays as it is.
 */
export function citedPlaceGone({ pageFrom }: Pick<DocumentPlace, "pageFrom">, unitCount: number) {
  return pageFrom !== undefined && pageFrom > unitCount;
}

/**
 * What the view says of a place that is gone, in the words the Citation's chip uses for it. Null
 * when no Citation opened the page, or the Citation says where in no words.
 */
export function citedPlaceGoneLine(
  target: ViewerTarget,
  t: Translate,
  documents: readonly LiveDocument[] | null,
): string | null {
  const cited = target.citation;
  if (!cited) return null;
  const location = citedLocation(
    {
      documentId: target.documentId,
      contentHash: cited.contentHash ?? null,
      pageFrom: cited.pageFrom ?? target.pageFrom ?? null,
      pageTo: cited.pageTo ?? target.pageTo ?? null,
      location: cited.location ?? null,
      quote: target.quote ?? null,
    },
    t,
    documents,
  );
  return location ? t("citation.placeGone", { location }) : null;
}
