import type { DocumentPlace } from "../../../core/api";
import { citedLocation, type LiveDocument, type QuoteStanding } from "../../../shared/citations";
import { citationLocation, type Translate } from "../../../shared/locations";
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
 * What the view says of a place that is gone, in the words the Citation's chip uses for it. A page
 * or a slide is worded by its number, so it is gone. Any other place is worded by a name (a
 * heading, a sheet, a time), found by a number that drops when something before it is deleted, so
 * the Document may still have it, and the line says it is no longer where it was. Null when no
 * Citation opened the page, when the Citation says where in no words, and after the line that says
 * where the quote now stands or that it is still at its place (`standing`).
 */
export function citedPlaceGoneLine(
  target: ViewerTarget,
  t: Translate,
  documents: readonly LiveDocument[] | null,
  standing: QuoteStanding | null = null,
): string | null {
  const cited = target.citation;
  if (!cited || standing === "moved" || standing === "found") return null;
  const attributes = {
    documentId: target.documentId,
    contentHash: cited.contentHash ?? null,
    pageFrom: cited.pageFrom ?? target.pageFrom ?? null,
    pageTo: cited.pageTo ?? target.pageTo ?? null,
    location: cited.location ?? null,
    quote: target.quote ?? null,
  };
  const location = citedLocation(attributes, t, documents);
  if (!location) return null;
  const kind = citationLocation(attributes)?.kind;
  const byNumber = kind === "page" || kind === "slide";
  return t(byNumber ? "citation.placeGone" : "citation.placeGone.named", { location });
}
