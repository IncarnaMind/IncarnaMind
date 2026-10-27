import type { CitationAttributes, CitationCheck } from "../../core/api";
import { type CitedSource, useComposer } from "./composer";
import { currentTabOf } from "./layoutSlice";
import { type AppState, useAppStore } from "./store";

/** Whether opening the cited place washes the quote: it is there, unless the check could not find it. */
export const quoteSaysSo = (check: CitationCheck) =>
  check === "found" || check === "unsupported" || check === "contradicted";

function sourceIsUsable(source: CitedSource, state: AppState): boolean {
  const tab = currentTabOf(state.layout);
  if (tab?.item.kind !== "document" || tab.item.documentId !== source.documentId) return false;
  if (!state.minds.some((mind) => mind.id === source.mindId)) return false;
  return (
    state.layout?.groups.some((group) =>
      group.tabs.some((tab) => tab.item.kind === "mind" && tab.item.mindId === source.mindId),
    ) ?? false
  );
}

/** The Citation's originating Note while its cited Document is the front tab. */
export function useCitedSource(): CitedSource | null {
  const source = useComposer((state) => state.citedSource);
  return useAppStore((state) => (source !== null && sourceIsUsable(source, state) ? source : null));
}

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
    /** Where to open it, when that isn't where the Citation points: its quote moved in the new version. */
    place?: { pageFrom: number | null; pageTo: number | null };
  },
): void {
  const composer = useComposer.getState();
  const seat = composer.seat;
  const previous = composer.citedSource;
  const source = seat
    ? { mindId: seat.mindId, documentId: citation.documentId }
    : previous && sourceIsUsable(previous, useAppStore.getState())
      ? { ...previous, documentId: citation.documentId }
      : null;
  useAppStore.getState().openDocument(
    {
      documentId: citation.documentId,
      // A whole TXT or Markdown file cited before Locations, whose quote wasn't found, opens at the top.
      pageFrom: (how.place ? how.place.pageFrom : citation.pageFrom) ?? undefined,
      pageTo: (how.place ? how.place.pageTo : citation.pageTo) ?? undefined,
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
        ...(citation.pageFrom !== null && { pageFrom: citation.pageFrom }),
        ...(citation.pageTo !== null && { pageTo: citation.pageTo }),
      },
    },
    { as: "citation", ...(how.from && { from: how.from }), ...(how.keep && { keep: true }) },
  );
  useComposer.setState({ citedSource: source });
}
