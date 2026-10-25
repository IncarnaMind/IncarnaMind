import type { CitationAttributes, CitationCheck } from "../../core/api";
import { useAppStore } from "./store";

/** Whether opening the cited place washes the quote: it is there, unless the check could not find it. */
export const quoteSaysSo = (check: CitationCheck) =>
  check === "found" || check === "unsupported" || check === "contradicted";

/**
 * Opens a Citation's cited place (a page, slide, section, rows or lines)
 * beside the Mind, with the quote to wash if asked, and the Citation's check,
 * number and label: the viewer colours the quote by the check and shows the
 * check mark, with where it points, beside it. `from`: the group the Mind is
 * in, which the Document opens to the right of. `keep`: a preview of the
 * Document already open is kept.
 */
export function openCited(
  citation: Pick<CitationAttributes, "pageFrom" | "pageTo" | "quote" | "contentHash"> & {
    documentId: string;
    location?: CitationAttributes["location"];
  },
  how: {
    check: CitationCheck;
    withQuote: boolean;
    number?: number;
    label?: string | null;
    from?: string;
    keep?: boolean;
  },
): void {
  useAppStore.getState().openDocument(
    {
      documentId: citation.documentId,
      // A whole TXT or Markdown file cited before Locations, whose quote wasn't found, opens at the top.
      pageFrom: citation.pageFrom ?? undefined,
      pageTo: citation.pageTo ?? undefined,
      quote: how.withQuote && citation.quote ? citation.quote : undefined,
      ...(citation.location?.kind === "section" && citation.location.figure
        ? { figure: citation.location.figure }
        : {}),
      citation: {
        check: how.check,
        ...(how.number && how.number > 0 ? { number: how.number } : {}),
        ...(how.label ? { label: how.label } : {}),
        ...(citation.contentHash ? { contentHash: citation.contentHash } : {}),
        ...(citation.location ? { location: citation.location } : {}),
      },
    },
    { as: "citation", ...(how.from && { from: how.from }), ...(how.keep && { keep: true }) },
  );
}
