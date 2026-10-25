import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Document, DocumentPlace, LayoutTab } from "../../../../core/api";
import { citedTextKept } from "../../../../shared/citations";
import { useT } from "../../i18n";
import { useAppStore, type ViewerTarget } from "../../store";
import { DocumentView } from "../../viewer/DocumentView";
import { type PlaceMemory, PlaceMemoryContext, type ViewPlace } from "../../viewer/place";
import { SelectionMenu } from "../../viewer/SelectionMenu";
import { type SelectionReader, SelectionReaderContext } from "../../viewer/selectedText";
import { type ViewerFrame, ViewerFrameContext, ViewerHeader } from "../../viewer/ViewerHeader";
import { DocumentRemoved } from "../../viewer/ViewerMessage";

/** How far the User scrolls a preview, at least, to keep it: the jump to the quote doesn't count. */
const KEEP_AFTER_SCROLL_PX = 120;

/**
 * What the viewer shows of a Document's file, as a key that changes when
 * there is something new to show, so the view reads the file again: a new
 * version, once it is indexed (its `contentHash`), or the file back after it
 * went missing or out of reach, or a PDF recovers with its last good bytes (#1954).
 * A file that goes while it is shown leaves
 * what was read of it on screen. A Transcript reads its file again itself as
 * lines arrive, so a new version doesn't start it afresh (#136).
 */
function useFileKey(document: Document | undefined): string {
  const id = document?.id;
  const available = document?.fileStatus === "available";
  const ready = document?.kind === "pdf" && document.status === "ready";
  const version = document?.kind === "transcript" ? "" : document?.contentHash;
  const [returns, setReturns] = useState(0);
  const last = useRef({ id, available, ready, version });
  useEffect(() => {
    const before = last.current;
    if (
      before.id === id &&
      available &&
      (!before.available || (ready && !before.ready && version === before.version))
    ) {
      setReturns((count) => count + 1);
    }
    last.current = { id, available, ready, version };
  }, [id, available, ready, version]);
  return `${id}:${version}:${returns}`;
}

/** Keeps a view's place for the open request, while its file is read again (see `PlaceMemory`). */
function usePlaceMemory(target: ViewerTarget): PlaceMemory {
  const kept = useRef<{ key: string; place: ViewPlace } | null>(null);
  const key = `${target.documentId}#${target.request}`;
  return useMemo(
    () => ({
      recall: () => (kept.current?.key === key ? kept.current.place : null),
      remember: (place) => {
        kept.current = { key, place };
      },
    }),
    [key],
  );
}

/** Keys that scroll a page, not type in it. */
const SCROLL_KEYS = ["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End", " "];
/** How far in from a scroller's right edge a press is on its scrollbar, overlaid or not. */
const SCROLLBAR_PX = 16;

/**
 * A preview is kept once the User reads it (VS Code's preview tabs): a scroll
 * of at least `KEEP_AFTER_SCROLL_PX` with the wheel, the keys or the
 * scrollbar (not the jump to the quote), or a selection of some text. Native
 * listeners, in the capture phase: scroll events don't bubble.
 */
function useKeepOnReading(section: HTMLElement | null, tabId: string, preview: boolean) {
  useEffect(() => {
    if (!section || !preview) return;
    /** When the User last moved the page themselves; a scrollbar held down counts until let go. */
    let intent = 0;
    let scrolled = 0;
    const lastTop = new WeakMap<EventTarget, number>();
    const keep = () => {
      void useAppStore.getState().changeLayout({ type: "keep", tabId });
    };
    const moves = () => {
      intent = Date.now();
    };
    const onKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.includes(event.key)) moves();
    };
    // A press on a scrollbar (a scroller's edge), not on a button that moves the page.
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.scrollHeight <= target.clientHeight) return;
      if (event.offsetX >= target.clientWidth - SCROLLBAR_PX) intent = Number.POSITIVE_INFINITY;
    };
    const onUp = () => {
      if (intent === Number.POSITIVE_INFINITY) intent = Date.now();
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim().length >= 2) keep();
    };
    const onScroll = (event: Event) => {
      const element = event.target;
      if (!(element instanceof HTMLElement)) return;
      const before = lastTop.get(element) ?? element.scrollTop;
      lastTop.set(element, element.scrollTop);
      if (Date.now() - intent > 400) return;
      scrolled += Math.abs(element.scrollTop - before);
      if (scrolled >= KEEP_AFTER_SCROLL_PX) keep();
    };
    const capture = { capture: true, passive: true };
    section.addEventListener("wheel", moves, capture);
    section.addEventListener("keydown", onKey, capture);
    section.addEventListener("pointerdown", onDown, capture);
    section.addEventListener("pointerup", onUp, capture);
    section.addEventListener("scroll", onScroll, capture);
    return () => {
      section.removeEventListener("wheel", moves, capture);
      section.removeEventListener("keydown", onKey, capture);
      section.removeEventListener("pointerdown", onDown, capture);
      section.removeEventListener("pointerup", onUp, capture);
      section.removeEventListener("scroll", onScroll, capture);
    };
  }, [section, tabId, preview]);
}

/**
 * A Document's tab: its toolbar and the view for its kind (PDF, Word,
 * PowerPoint, Excel, CSV, Markdown, text, web page), at the place it was opened, a
 * Citation's quote washed. It follows the Document's file on disk: a new
 * version is shown once it is indexed, and a file that went missing is shown
 * again when it comes back, at the same place.
 */
export function DocumentTab({ tab }: { tab: LayoutTab }) {
  const t = useT();
  const documentId = tab.item.kind === "document" ? tab.item.documentId : "";
  // The same target until the tab is opened at another place: each new layout is a new object.
  const placeKey = JSON.stringify(tab.place ?? {});
  const target = useMemo<ViewerTarget>(
    () => ({ documentId, ...(JSON.parse(placeKey) as DocumentPlace), request: tab.opened }),
    [documentId, placeKey, tab.opened],
  );
  // Deleted Documents leave the list, so a target that isn't in it has been removed.
  const document = useAppStore((state) => state.documents.find((each) => each.id === documentId));
  // A Citation's Document that went with its Linked folder, whose quoted text was kept.
  const unlinked = useAppStore((state) => {
    if (!target.citation) return false;
    return citedTextKept(
      {
        documentId,
        contentHash: target.citation.contentHash ?? null,
        pageFrom: target.pageFrom ?? null,
        pageTo: target.pageTo ?? null,
      },
      state.keptCitationTexts,
    );
  });
  const preview = tab.preview;
  const tabId = tab.id;
  const frame = useMemo<ViewerFrame>(
    () => ({
      document,
      preview,
      keep: () => void useAppStore.getState().changeLayout({ type: "keep", tabId }),
      target,
    }),
    [document, preview, tabId, target],
  );
  const fileKey = useFileKey(document);
  const places = usePlaceMemory(target);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const [reader, setReader] = useState<SelectionReader | null>(null);
  // A reader is a function: kept as one, not called as an update.
  const lendReader = useCallback((lent: SelectionReader | null) => setReader(() => lent), []);
  useKeepOnReading(section, tab.id, tab.preview);

  return (
    <section
      ref={setSection}
      data-testid="viewer"
      data-surface="viewer"
      data-document-id={documentId}
      aria-label={t("viewer.label")}
      className="viewer-pane flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sheet"
    >
      <ViewerFrameContext.Provider value={frame}>
        <PlaceMemoryContext.Provider value={places}>
          {!document ? (
            <>
              <ViewerHeader />
              <DocumentRemoved quote={target.quote} unlinked={unlinked} />
            </>
          ) : (
            // Keyed, so another Document, or a new read of its file, starts afresh (the last one
            // goes at once). While its view loads, the header alone: the page comes a moment later.
            <Suspense key={fileKey} fallback={<ViewerHeader />}>
              <SelectionReaderContext.Provider value={lendReader}>
                <DocumentView document={document} target={target} />
              </SelectionReaderContext.Provider>
            </Suspense>
          )}
          {document && reader && (
            <SelectionMenu document={document} section={section} reader={reader} />
          )}
        </PlaceMemoryContext.Provider>
      </ViewerFrameContext.Provider>
    </section>
  );
}
