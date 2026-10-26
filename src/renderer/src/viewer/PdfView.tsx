import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Document } from "../../../core/api";
import { readPdfPageText } from "../../../shared/pdfFormText";
import { findQuoteInPages, lostLigatures, type TextPiece } from "../../../shared/quoteMatch";
import { core } from "../core";
import { useT } from "../i18n";
import { useAppStore, type ViewerTarget } from "../store";
import {
  ExpandIcon,
  FitWidthIcon,
  NextPageIcon,
  OutlineToggleIcon,
  PreviousPageIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./icons";
import { LockedPdf } from "./LockedPdf";
import { loadOutline, type OutlineItem } from "./outline";
import { isMissingDocumentError, isPasswordError, loadPdfJs, openPdf, type PdfJs } from "./pdfjs";
import { PlaceMemoryContext } from "./place";
import { CitationMark, type QuoteMark, quoteMarkOf, quoteTone } from "./quoteMark";
import { type ScannedPage, scannedTextLayer, useScannedPages } from "./scannedText";
import { pdfSelection, useSelectionReader } from "./selectedText";
import { UnreadPagesLine } from "./UnreadPagesLine";
import { HeaderDivider, ViewerHeader } from "./ViewerHeader";
import { FileGone, ViewerMessage } from "./ViewerMessage";
import { createWheelZoom, MAX_ZOOM, MIN_ZOOM, stepZoom } from "./zoom";

/** CSS pixels per PDF point: at 100% a page shows at its printed size. */
const CSS_UNITS = 96 / 72;
/** On macOS ⌘ with the wheel zooms too, as Ctrl does. */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/**
 * Fitted to the width, a page may be smaller than the smallest step, e.g. in
 * a narrow viewer with the outline beside it: it fits what width there is.
 */
const MIN_FIT_ZOOM = 0.05;
/** Space between pages, and around them, in CSS pixels. */
const PAGE_GAP = 16;
const PAGE_PADDING = 24;
/** A canvas larger than this many pixels is drawn at a lower resolution, to bound memory. */
const MAX_CANVAS_PIXELS = 2 ** 24;
/**
 * A zoom or resize draws the visible pages again once it settles, not at every
 * step: a pinch changes the zoom at each of its events, many a second.
 */
const RERENDER_DELAY = 150;
/** Zooms closer than this are the same: a wheel event that moves the zoom less does nothing. */
const ZOOM_EPSILON = 1e-6;
/** The most pages a quote is looked for across. */
const MAX_QUOTE_PAGES = 10;

/** A page's size at 100% scale, in PDF points. */
interface PageSize {
  width: number;
  height: number;
}

/** Part of a quote, in one of a page's text runs (`item` indexes its text layer's runs). */
interface RunHighlight {
  item: number;
  start: number;
  end: number;
}

type Zoom = { fit: true } | { fit: false; zoom: number };

type Loaded =
  | { kind: "loading" }
  | { kind: "ready"; pdfjs: PdfJs; pdf: PDFDocumentProxy; firstPage: PageSize }
  | { kind: "missing" }
  /** Password-protected, with no password kept that opens it (#763). */
  | { kind: "locked" }
  | { kind: "failed"; message: string };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** The first of the pages (in order, top to bottom) whose bottom edge is below `y`, by its index. */
function pageIndexAt(elements: readonly (HTMLElement | null)[], y: number): number {
  let low = 0;
  let high = elements.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const element = elements[middle];
    if (element && element.offsetTop + element.offsetHeight <= y) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * A PDF Document, rendered with pdf.js: pages are drawn only while near the
 * visible area, each with a text layer so its text can be selected. Opened at
 * a page range with a quote, it shows the first page of the range and
 * highlights the quote if those pages contain it. A PDF with an outline
 * (bookmarks) can show it in a panel beside the pages.
 */
export function PdfView({
  document,
  target,
  source,
  banner,
}: {
  document: Document;
  target: ViewerTarget;
  /** Another PDF the Document serves, instead of its file: a web page's look. */
  source?: string;
  /** Under the toolbar, whatever the PDF's state. */
  banner?: ReactNode;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reopen = () => {
    setLoaded({ kind: "loading" });
    setAttempt((count) => count + 1);
  };
  const retry = () => {
    reopen();
    if (document.status === "failed" || document.status === "no-text") {
      void useAppStore.getState().retryDocument(document.id);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` opens it again after Retry or unlocking.
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    /** Opens the PDF; a locked one with the password the core keeps for it, asked for only then. */
    const open = async (pdfjs: PdfJs): Promise<PDFDocumentProxy | null> => {
      task = openPdf(pdfjs, document.id, source);
      try {
        return await task.promise;
      } catch (error) {
        if (!isPasswordError(error)) throw error;
        const password = await core.documentPasswordFor(document.id);
        if (cancelled || password === null) return null;
        await task.destroy();
        task = openPdf(pdfjs, document.id, source, password);
        return await task.promise;
      }
    };
    loadPdfJs()
      .then(async (pdfjs) => {
        if (cancelled) return;
        const pdf = await open(pdfjs);
        if (cancelled) return;
        if (!pdf) {
          setLoaded({ kind: "locked" });
          return;
        }
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
        if (!cancelled) {
          setLoaded({
            kind: "ready",
            pdfjs,
            pdf,
            firstPage: { width: first.width, height: first.height },
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isMissingDocumentError(error)) setLoaded({ kind: "missing" });
        else if (isPasswordError(error)) setLoaded({ kind: "locked" });
        else setLoaded({ kind: "failed", message: error instanceof Error ? error.message : "" });
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [document.id, source, attempt]);

  switch (loaded.kind) {
    case "loading":
      return (
        <>
          <ViewerHeader />
          {banner}
          <ViewerMessage>{t("viewer.loading")}</ViewerMessage>
        </>
      );
    case "missing":
      return (
        <>
          <ViewerHeader openable={false} />
          {banner}
          <FileGone quote={target.quote} />
        </>
      );
    case "locked":
      return (
        <>
          <ViewerHeader />
          <LockedPdf documentId={document.id} onUnlocked={reopen} />
        </>
      );
    case "failed":
      return (
        <>
          <ViewerHeader onRetry={retry} />
          {banner}
          <ViewerMessage
            tone="error"
            action={{ label: t("documents.retryAction"), testId: "viewer-retry", onClick: retry }}
          >
            <span title={loaded.message}>{t("viewer.pdf.failed")}</span>
          </ViewerMessage>
        </>
      );
    case "ready":
      return (
        <PdfPages
          document={document}
          pdfjs={loaded.pdfjs}
          pdf={loaded.pdf}
          firstPage={loaded.firstPage}
          target={target}
          banner={banner}
        />
      );
  }
}

interface PdfPagesProps {
  document: Document;
  pdfjs: PdfJs;
  pdf: PDFDocumentProxy;
  firstPage: PageSize;
  target: ViewerTarget;
  banner: ReactNode;
}

/** Whether each PDF's text lost its f-ligatures, read once per PDF, all its pages (see `lostLigatures`). */
const ligaturesLost = new WeakMap<PDFDocumentProxy, Promise<boolean>>();

/** As the Citation check reads the Document's stored text: whether a quote's ligatures may be a lone "f". */
function lostLigaturesOf(pdf: PDFDocumentProxy): Promise<boolean> {
  let known = ligaturesLost.get(pdf);
  if (!known) {
    known = (async () => {
      const texts: string[] = [];
      for (let page = 1; page <= pdf.numPages; page++) {
        const content = await (await pdf.getPage(page)).getTextContent();
        for (const entry of content.items) if ("str" in entry) texts.push(entry.str);
      }
      return lostLigatures(texts.join("\n"));
    })();
    ligaturesLost.set(pdf, known);
  }
  return known;
}

function PdfPages({ document, pdfjs, pdf, firstPage, target, banner }: PdfPagesProps) {
  const pageCount = pdf.numPages;
  // A scanned page's text was read from its picture (#397): it is laid over the picture.
  const scanned = useScannedPages(document);
  const places = useContext(PlaceMemoryContext);
  // Where the view was, if its file was read again: it comes back at the same zoom and page.
  const [recalled] = useState(() => places.recall());
  // Every page starts at the first page's size; each is corrected once it loads.
  const [sizes, setSizes] = useState<readonly PageSize[]>(() =>
    Array.from({ length: pageCount }, () => firstPage),
  );
  const [zoom, setZoom] = useState<Zoom>(() =>
    recalled?.zoom ? { fit: false, zoom: recalled.zoom } : { fit: true },
  );
  const [viewportWidth, setViewportWidth] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [nearby, setNearby] = useState<ReadonlySet<number>>(() => new Set());
  const [highlights, setHighlights] = useState<ReadonlyMap<number, RunHighlight[]>>(
    () => new Map(),
  );
  const [outline, setOutline] = useState<readonly OutlineItem[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  useSelectionReader(
    useCallback(
      (range) => (scroller.current ? pdfSelection(range, scroller.current) : { parts: [] }),
      [],
    ),
  );
  const pageElements = useRef<(HTMLElement | null)[]>([]);
  /** The page at the top edge of the view, and how far into it: kept through zooms and resizes. */
  const anchor = useRef({ page: 1, fraction: 0 });
  /** Set when the view was moved to a page, so the page indicator shows that page. */
  const placed = useRef<{ page: number; scrollTop: number } | null>(null);
  /** The open request whose highlight the view should move to once it is drawn. */
  const pendingHighlight = useRef<number | null>(null);
  /**
   * The open request the view last moved to the quote for: finding the quote
   * again (a scanned page's text arriving) washes it, but leaves the view where it is.
   */
  const shownHighlight = useRef<number | null>(null);
  const frame = useRef(0);
  /** The zoom shown, or about to be: a zoom by wheel or pinch goes on from it. */
  const shownZoom = useRef(1);
  /**
   * Where a zoom by wheel or pinch was centred: a point of a page, as
   * fractions of its size, and where the pointer was in the view.
   */
  const zoomOrigin = useRef<{
    page: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  const scale =
    zoom.fit && viewportWidth > 0
      ? clamp(
          (viewportWidth - 2 * PAGE_PADDING) / firstPage.width,
          MIN_FIT_ZOOM * CSS_UNITS,
          MAX_ZOOM * CSS_UNITS,
        )
      : zoom.fit
        ? CSS_UNITS
        : zoom.zoom * CSS_UNITS;

  const pageElement = (page: number) => pageElements.current[page - 1] ?? null;

  /** Scrolls so `page` starts at the top of the view. */
  const goToPage = useCallback(
    (page: number) => {
      const container = scroller.current;
      const element = pageElements.current[clamp(page, 1, pageCount) - 1];
      if (!container || !element) return;
      const number = Number(element.dataset.pageNumber);
      // The page's top edge shows, with the gap above it (the padding, above the first).
      const above = number === 1 ? PAGE_PADDING : PAGE_GAP;
      container.scrollTop = Math.max(0, element.offsetTop - above);
      placed.current = { page: number, scrollTop: container.scrollTop };
      anchor.current = {
        page: number,
        fraction: (container.scrollTop - element.offsetTop) / element.offsetHeight,
      };
      setCurrentPage(number);
    },
    [pageCount],
  );

  /** Works out the current page (the one taking most of the view) and the anchor. */
  const measure = useCallback(() => {
    const container = scroller.current;
    if (!container) return;
    const { scrollTop, clientHeight } = container;
    const elements = pageElements.current;
    // The first page whose bottom is below the top of the view.
    const low = pageIndexAt(elements, scrollTop);
    const top = elements[low];
    if (!top) return;
    anchor.current = {
      page: low + 1,
      fraction: (scrollTop - top.offsetTop) / top.offsetHeight,
    };
    if (placed.current && Math.abs(placed.current.scrollTop - scrollTop) < 2) {
      setCurrentPage(placed.current.page);
      return;
    }
    placed.current = null;
    let best = low + 1;
    let bestVisible = -1;
    for (let index = low; index < elements.length; index++) {
      const element = elements[index];
      if (!element || element.offsetTop >= scrollTop + clientHeight) break;
      const visible =
        Math.min(element.offsetTop + element.offsetHeight, scrollTop + clientHeight) -
        Math.max(element.offsetTop, scrollTop);
      if (visible > bestVisible) {
        best = index + 1;
        bestVisible = visible;
      }
    }
    setCurrentPage(best);
  }, []);

  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      measure();
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // The view's width, for fitting pages to it.
  useLayoutEffect(() => {
    const container = scroller.current;
    if (!container) return;
    setViewportWidth(container.clientWidth);
    const observer = new ResizeObserver(() => setViewportWidth(container.clientWidth));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // When pages change size (a zoom, a resize, a page's real size arriving), keep the same place in view:
  // the point under the pointer after a zoom by wheel or pinch, else the top of the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs because the layout changed
  useLayoutEffect(() => {
    shownZoom.current = scale / CSS_UNITS;
    const container = scroller.current;
    if (!container) return;
    const origin = zoomOrigin.current;
    zoomOrigin.current = null;
    const around = origin && pageElement(origin.page);
    if (origin && around) {
      container.scrollLeft = around.offsetLeft + origin.x * around.offsetWidth - origin.left;
      container.scrollTop = around.offsetTop + origin.y * around.offsetHeight - origin.top;
      measure();
      return;
    }
    const element = pageElement(anchor.current.page);
    if (!element) return;
    container.scrollTop = element.offsetTop + anchor.current.fraction * element.offsetHeight;
    if (placed.current) placed.current.scrollTop = container.scrollTop;
  }, [scale, sizes]);

  /**
   * Zooms to `next`, keeping the point of the page under the pointer
   * (`clientX`, `clientY`) where it is. During a pinch this runs for each of
   * its events: the pages are resized at once, their drawings and text layers
   * stretched to fit, and made again at the new zoom once it settles (`PdfPage`).
   */
  const zoomAround = useCallback((next: number, clientX: number, clientY: number) => {
    const container = scroller.current;
    if (!container || Math.abs(next - shownZoom.current) < ZOOM_EPSILON) return;
    const box = container.getBoundingClientRect();
    const left = clientX - box.left - container.clientLeft;
    const top = clientY - box.top - container.clientTop;
    const y = container.scrollTop + top;
    const index = pageIndexAt(pageElements.current, y);
    const element = pageElements.current[index];
    if (element) {
      zoomOrigin.current = {
        page: index + 1,
        x: (container.scrollLeft + left - element.offsetLeft) / element.offsetWidth,
        y: (y - element.offsetTop) / element.offsetHeight,
        left,
        top,
      };
    }
    // Another event may come before the zoom is drawn: it goes on from this one.
    shownZoom.current = next;
    setZoom({ fit: false, zoom: next });
  }, []);

  // A pinch, or the wheel with Ctrl (or ⌘ on macOS) held, zooms the pages around the pointer:
  // a pinch follows the fingers, the wheel goes a step per notch.
  // The gesture is theirs: nothing else scrolls or zooms with it.
  useEffect(() => {
    const container = scroller.current;
    if (!container) return;
    const gesture = createWheelZoom({ mac: IS_MAC });
    const onKey = (event: globalThis.KeyboardEvent) => gesture.keyChanged(event);
    const onBlur = () => gesture.blur();
    const onWheel = (event: WheelEvent) => {
      if (!gesture.isZoom(event)) return;
      event.preventDefault();
      event.stopPropagation();
      zoomAround(gesture.zoom(event, shownZoom.current), event.clientX, event.clientY);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      container.removeEventListener("wheel", onWheel);
    };
  }, [zoomAround]);

  // Each open request goes to the first page of its range (a plain reopen keeps the place).
  // Read again, the file opens where the view was, or else at the range.
  const appliedRequest = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (appliedRequest.current === target.request) return;
    const first = appliedRequest.current === null;
    appliedRequest.current = target.request;
    if (first && recalled) goToPage(recalled.page);
    else if (target.pageFrom !== undefined || target.quote) goToPage(target.pageFrom ?? 1);
    else if (first) goToPage(1);
  }, [target.request, target.pageFrom, target.quote, goToPage, recalled]);

  useEffect(() => {
    places.remember({ page: currentPage, zoom: zoom.fit ? null : zoom.zoom });
  }, [places, currentPage, zoom]);

  // Finds the quote on the pages of the range, for each page's text layer to highlight.
  useEffect(() => {
    const quote = target.quote;
    setHighlights(new Map());
    pendingHighlight.current = null;
    if (!quote) return;
    let cancelled = false;
    const from = clamp(target.pageFrom ?? 1, 1, pageCount);
    const to = clamp(target.pageTo ?? from, from, Math.min(pageCount, from + MAX_QUOTE_PAGES - 1));
    void (async () => {
      // Each page's text runs, counted as its text layer counts them.
      const pages: TextPiece[][] = [];
      const signatures = await pdf.getSignatures();
      for (let page = from; page <= to; page++) {
        const read = scanned.get(page);
        if (read) {
          pages.push(read.pieces);
          continue;
        }
        const { content } = await readPdfPageText(await pdf.getPage(page), signatures);
        const pieces: TextPiece[] = [];
        for (const entry of content.items) {
          if (!("str" in entry)) continue;
          pieces.push({ text: entry.str, breakAfter: entry.hasEOL });
        }
        const last = pieces.at(-1);
        if (last) last.breakAfter = true;
        pages.push(pieces);
      }
      if (cancelled) return;
      // Across a page break, running headers and footers may sit inside the quote. A PDF whose
      // text lost its f-ligatures is matched as the check matched it, only when needed.
      const found =
        findQuoteInPages(pages, quote) ??
        ((await lostLigaturesOf(pdf))
          ? findQuoteInPages(pages, quote, undefined, { lostLigatures: true })
          : null);
      if (cancelled || !found) return;
      const byPage = new Map<number, RunHighlight[]>();
      for (const part of found) {
        const page = from + part.page;
        const list = byPage.get(page) ?? [];
        list.push({ item: part.piece, start: part.start, end: part.end });
        byPage.set(page, list);
      }
      if (shownHighlight.current !== target.request) pendingHighlight.current = target.request;
      setHighlights(byPage);
    })().catch((error: unknown) => {
      if (!cancelled) console.error(error);
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, pageCount, scanned, target.request, target.quote, target.pageFrom, target.pageTo]);

  // The outline, if the PDF has one: its button shows only then.
  useEffect(() => {
    let cancelled = false;
    loadOutline(pdf).then(
      (items) => {
        if (!cancelled) setOutline(items);
      },
      (error: unknown) => {
        if (!cancelled) console.error(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  // Pages within a screen of the view are drawn; the rest are released.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) =>
        setNearby((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.pageNumber);
            if (entry.isIntersecting) next.add(page);
            else next.delete(page);
          }
          return next;
        }),
      { root, rootMargin: "100% 0px" },
    );
    for (const element of pageElements.current) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onPageSize = useCallback((page: number, size: PageSize) => {
    setSizes((previous) => {
      const old = previous[page - 1];
      if (old && old.width === size.width && old.height === size.height) return previous;
      const next = previous.slice();
      next[page - 1] = size;
      return next;
    });
  }, []);

  const firstHighlightPage = highlights.size > 0 ? Math.min(...highlights.keys()) : null;
  const onHighlightShown = useCallback(
    (page: number, element: HTMLElement) => {
      const container = scroller.current;
      if (!container || page !== firstHighlightPage) return;
      if (pendingHighlight.current !== target.request) return;
      pendingHighlight.current = null;
      shownHighlight.current = target.request;
      const box = container.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      if (rect.top >= box.top && rect.bottom <= box.bottom) return; // already in view
      container.scrollTop = rect.top - box.top + container.scrollTop - container.clientHeight / 3;
      placed.current = { page, scrollTop: container.scrollTop };
      setCurrentPage(page);
    },
    [firstHighlightPage, target.request],
  );

  const setPageElement = useCallback((page: number, element: HTMLElement | null) => {
    pageElements.current[page - 1] = element;
  }, []);

  const currentZoom = scale / CSS_UNITS;
  /** A step in (1) or out (-1), keeping the top of the view in place. */
  const zoomStep = (steps: number) => {
    measure(); // so the anchor is current
    setZoom({ fit: false, zoom: stepZoom(currentZoom, steps) });
  };

  const hasOutline = outline.length > 0;
  const zoomPercent = Math.round(currentZoom * 100);
  const mark = useMemo(() => quoteMarkOf(target.citation), [target.citation]);

  return (
    <>
      <ViewerHeader
        leading={
          hasOutline && (
            <OutlineToggle
              open={outlineOpen}
              onToggle={() => {
                measure(); // the pages may refit to the narrower view: keep the place
                setOutlineOpen((open) => !open);
              }}
            />
          )
        }
      >
        <PageNavigation current={currentPage} count={pageCount} onGo={goToPage} />
        <HeaderDivider />
        <ZoomControls
          percent={zoomPercent}
          fitWidth={zoom.fit}
          onZoomIn={() => zoomStep(1)}
          onZoomOut={() => zoomStep(-1)}
          onFitWidth={() => {
            measure();
            setZoom({ fit: true });
          }}
        />
      </ViewerHeader>
      {banner}
      <UnreadPagesLine document={document} />
      <div className="flex min-h-0 flex-1">
        {hasOutline && outlineOpen && (
          <OutlinePanel items={outline} currentPage={currentPage} onGoToPage={goToPage} />
        )}
        <div
          ref={scroller}
          data-testid="pdf-scroller"
          data-quote-tone={quoteTone(target.citation)}
          onScroll={onScroll}
          className="viewer-backdrop relative min-w-0 flex-1 overflow-auto [overflow-anchor:none]"
        >
          <div
            className="flex w-max min-w-full flex-col items-center"
            style={{
              gap: PAGE_GAP,
              padding: `${PAGE_PADDING}px ${PAGE_PADDING}px ${2 * PAGE_PADDING}px`,
            }}
          >
            {sizes.map((size, index) => {
              const page = index + 1;
              return (
                <PdfPage
                  key={page}
                  pdfjs={pdfjs}
                  pdf={pdf}
                  page={page}
                  size={size}
                  scale={scale}
                  nearby={nearby.has(page)}
                  scanned={scanned.get(page)}
                  highlights={highlights.get(page)}
                  mark={page === firstHighlightPage ? mark : null}
                  onSize={onPageSize}
                  onHighlightShown={onHighlightShown}
                  setElement={setPageElement}
                />
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

/** The outline's indent per level, in CSS pixels. */
const OUTLINE_INDENT = 16;
/** The left padding of a top-level entry, in CSS pixels. */
const OUTLINE_INSET = 8;

/**
 * The entry for the page in view, as a path of indexes from the top ("1.0"):
 * the first entry that starts on that page, or else the section running on
 * from an earlier page (the last entry of the latest page before it).
 */
function currentEntry(items: readonly OutlineItem[], page: number): string | null {
  let onPage: string | null = null;
  let before: { path: string; page: number } | null = null;
  const visit = (list: readonly OutlineItem[], prefix: string) => {
    list.forEach((item, index) => {
      const path = prefix ? `${prefix}.${index}` : String(index);
      if (item.page === page) onPage ??= path;
      else if (item.page !== null && item.page < page && (!before || item.page >= before.page)) {
        before = { path, page: item.page };
      }
      visit(item.items, path);
    });
  };
  visit(items, "");
  return onPage ?? (before as { path: string } | null)?.path ?? null;
}

/**
 * The PDF's outline, beside its pages: entries with others under them expand
 * and collapse, clicking an entry goes to its page, and the entry for the page
 * in view is marked.
 */
function OutlinePanel({
  items,
  currentPage,
  onGoToPage,
}: {
  items: readonly OutlineItem[];
  currentPage: number;
  onGoToPage(page: number): void;
}) {
  const t = useT();
  const current = useMemo(() => currentEntry(items, currentPage), [items, currentPage]);
  return (
    <nav data-testid="pdf-outline" aria-label={t("viewer.outline.label")} className="pdf-outline">
      <OutlineList items={items} path="" current={current} onGoToPage={onGoToPage} />
    </nav>
  );
}

function OutlineList({
  items,
  path,
  current,
  onGoToPage,
}: {
  items: readonly OutlineItem[];
  /** Where this list is in the outline: "" at the top, else its entry's path. */
  path: string;
  current: string | null;
  onGoToPage(page: number): void;
}) {
  return (
    <ul>
      {items.map((item, index) => (
        <OutlineEntry
          // The outline never changes while shown, so its order is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: entries can share a title.
          key={index}
          item={item}
          path={path ? `${path}.${index}` : String(index)}
          current={current}
          onGoToPage={onGoToPage}
        />
      ))}
    </ul>
  );
}

function OutlineEntry({
  item,
  path,
  current,
  onGoToPage,
}: {
  item: OutlineItem;
  path: string;
  current: string | null;
  onGoToPage(page: number): void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(item.open);
  const title = item.title || t("viewer.outline.untitled");
  const hasChildren = item.items.length > 0;
  const depth = path.split(".").length - 1;
  // A collapsed entry stands for the entries under it.
  const isCurrent =
    current !== null &&
    (current === path || (hasChildren && !expanded && current.startsWith(`${path}.`)));
  const toggleLabel = t(expanded ? "viewer.outline.collapse" : "viewer.outline.expand", {
    title,
  });
  const { page } = item;
  return (
    <li>
      <div
        className={`pdf-outline-row ${depth > 0 ? "pdf-outline-row--nested" : ""} ${
          isCurrent ? "pdf-outline-row--current" : ""
        }`}
      >
        <button
          type="button"
          data-testid="pdf-outline-item"
          data-page={page ?? undefined}
          aria-current={isCurrent ? "location" : undefined}
          disabled={page === null}
          title={title}
          onClick={() => {
            if (page !== null) onGoToPage(page);
          }}
          className="pdf-outline-title"
          style={{ paddingLeft: OUTLINE_INSET + depth * OUTLINE_INDENT }}
        >
          {title}
        </button>
        {hasChildren && (
          <button
            type="button"
            data-testid="pdf-outline-expand"
            aria-expanded={expanded}
            aria-label={toggleLabel}
            title={toggleLabel}
            onClick={() => setExpanded((open) => !open)}
            className="pdf-outline-expand"
          >
            <ExpandIcon className={`size-3.5 ${expanded ? "rotate-90" : ""}`} />
          </button>
        )}
      </div>
      {hasChildren && expanded && (
        <OutlineList items={item.items} path={path} current={current} onGoToPage={onGoToPage} />
      )}
    </li>
  );
}

/** Shows and hides the outline; only a PDF with an outline has it. */
function OutlineToggle({ open, onToggle }: { open: boolean; onToggle(): void }) {
  const t = useT();
  const label = t(open ? "viewer.outline.hide" : "viewer.outline.show");
  return (
    <button
      type="button"
      data-testid="pdf-outline-button"
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={onToggle}
      className="viewer-icon-button"
    >
      <OutlineToggleIcon className="size-4" />
    </button>
  );
}

/** Previous and next page, with the page number and the page count between them. */
function PageNavigation({
  current,
  count,
  onGo,
}: {
  current: number;
  count: number;
  onGo(page: number): void;
}) {
  const t = useT();
  return (
    <>
      <button
        type="button"
        data-testid="pdf-previous-page"
        aria-label={t("viewer.page.previous")}
        title={t("viewer.page.previous")}
        disabled={current <= 1}
        onClick={() => onGo(current - 1)}
        className="viewer-icon-button"
      >
        <PreviousPageIcon className="size-4" />
      </button>
      <PageNumberInput current={current} count={count} onGo={onGo} />
      <span data-testid="pdf-page-count" className="viewer-page-count">
        {t("viewer.page.count", { count })}
      </span>
      <button
        type="button"
        data-testid="pdf-next-page"
        aria-label={t("viewer.page.next")}
        title={t("viewer.page.next")}
        disabled={current >= count}
        onClick={() => onGo(current + 1)}
        className="viewer-icon-button"
      >
        <NextPageIcon className="size-4" />
      </button>
    </>
  );
}

/** Zoom out, the zoom level, zoom in, and fit to the width (the zoom a PDF opens at). */
function ZoomControls({
  percent,
  fitWidth,
  onZoomIn,
  onZoomOut,
  onFitWidth,
}: {
  percent: number;
  fitWidth: boolean;
  onZoomIn(): void;
  onZoomOut(): void;
  onFitWidth(): void;
}) {
  const t = useT();
  return (
    <>
      <button
        type="button"
        data-testid="pdf-zoom-out"
        aria-label={t("viewer.zoom.out")}
        title={t("viewer.zoom.out")}
        disabled={percent <= MIN_ZOOM * 100}
        onClick={onZoomOut}
        className="viewer-icon-button"
      >
        <ZoomOutIcon className="size-4" />
      </button>
      <span
        data-testid="pdf-zoom-level"
        title={t("viewer.zoom.level", { percent })}
        className="viewer-zoom-level"
      >
        {percent}%
      </span>
      <button
        type="button"
        data-testid="pdf-zoom-in"
        aria-label={t("viewer.zoom.in")}
        title={t("viewer.zoom.in")}
        disabled={percent >= MAX_ZOOM * 100}
        onClick={onZoomIn}
        className="viewer-icon-button"
      >
        <ZoomInIcon className="size-4" />
      </button>
      <button
        type="button"
        data-testid="pdf-fit-width"
        aria-label={t("viewer.zoom.fitWidth")}
        aria-pressed={fitWidth}
        title={t("viewer.zoom.fitWidth")}
        onClick={onFitWidth}
        className="viewer-icon-button"
      >
        <FitWidthIcon className="size-4" />
      </button>
    </>
  );
}

/** Shows the current page; typing a number and pressing Enter goes there. */
function PageNumberInput({
  current,
  count,
  onGo,
}: {
  current: number;
  count: number;
  onGo(page: number): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const go = () => {
    const page = Number.parseInt(draft ?? "", 10);
    if (Number.isFinite(page)) onGo(clamp(page, 1, count));
    setDraft(null);
  };
  return (
    <input
      data-testid="pdf-page-number"
      aria-label={t("viewer.page.number")}
      inputMode="numeric"
      value={draft ?? String(current)}
      onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
      onFocus={(event) => event.target.select()}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") go();
        if (event.key === "Escape" && draft !== null) {
          event.preventDefault(); // keep the panel open
          setDraft(null);
        }
      }}
      onBlur={() => setDraft(null)}
      className="viewer-page-input"
      // Wide enough for the largest page number.
      style={{ width: `max(32px, calc(${String(count).length}ch + 12px))` }}
    />
  );
}

interface PdfPageProps {
  pdfjs: PdfJs;
  pdf: PDFDocumentProxy;
  page: number;
  size: PageSize;
  scale: number;
  /** Near the visible area: drawn. Otherwise blank, with its resources released. */
  nearby: boolean;
  /** A scanned page's text, read from its picture: its text layer instead of the PDF's. */
  scanned: ScannedPage | undefined;
  highlights: readonly RunHighlight[] | undefined;
  /** The Citation's mark, for the page the quote starts on. */
  mark: QuoteMark | null;
  onSize(page: number, size: PageSize): void;
  onHighlightShown(page: number, element: HTMLElement): void;
  setElement(page: number, element: HTMLElement | null): void;
}

/** Room the mark keeps from the page's right edge (its width and a little more), in CSS pixels. */
const MARK_ROOM = 40;
/** Space between the text and the mark, in CSS pixels. */
const MARK_GAP = 12;

/**
 * Where the mark goes on a page, as fractions of its size so that it follows
 * a zoom at once: the middle of the quote's first line, and the right edge of
 * the page's text (the mark sits in the margin past it).
 */
interface MarkPlace {
  lineMiddle: number;
  textRight: number;
}

function markPlace(first: HTMLElement, page: HTMLElement, runs: readonly Element[]): MarkPlace {
  const box = page.getBoundingClientRect();
  const line = first.getClientRects()[0] ?? first.getBoundingClientRect();
  let right = line.right;
  for (const run of runs) {
    const rect = run.getBoundingClientRect();
    if (rect.width > 0 && rect.right > right) right = rect.right;
  }
  return {
    lineMiddle: (line.top + line.height / 2 - box.top) / box.height,
    textRight: Math.min(1, (right - box.left) / box.width),
  };
}

/** One page: a canvas, and a text layer above it for selecting and highlighting text. */
const PdfPage = memo(function PdfPage(props: PdfPageProps) {
  const {
    pdfjs,
    pdf,
    page,
    size,
    scale,
    nearby,
    scanned,
    highlights,
    mark,
    onSize,
    onHighlightShown,
    setElement,
  } = props;
  const t = useT();
  const section = useRef<HTMLElement | null>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  /** The page's text layer's runs, and each one's text: pdf.js's, or a scanned page's (#397). */
  const textRuns = useRef<{ divs: readonly HTMLElement[]; strings: readonly string[] } | null>(
    null,
  );
  /** The quote's first highlighted part on this page, once marked. */
  const firstHighlight = useRef<HTMLElement | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [textLayerVersion, setTextLayerVersion] = useState(0);
  /** The scale the text layer was made at, if there is one. */
  const [layerScale, setLayerScale] = useState<number | null>(null);
  const [place, setPlace] = useState<MarkPlace | null>(null);
  const hasDrawn = useRef(false);
  /** The scale the page was last asked to draw at, near the view or not. */
  const lastScale = useRef(scale);

  useEffect(() => {
    const canvasDiv = canvasHost.current;
    const textDiv = textHost.current;
    if (!canvasDiv || !textDiv) return;
    const rescaled = scale !== lastScale.current;
    lastScale.current = scale;
    if (!nearby) {
      if (!hasDrawn.current) return;
      hasDrawn.current = false;
      canvasDiv.replaceChildren();
      textDiv.replaceChildren();
      textRuns.current = null;
      setDrawn(false);
      setLayerScale(null);
      pdf.getPage(page).then(
        (proxy) => proxy.cleanup(),
        () => undefined, // the PDF was closed meanwhile
      );
      return;
    }

    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let layer: TextLayer | undefined;
    const draw = async () => {
      const proxy = await pdf.getPage(page);
      if (cancelled) return;
      const natural = proxy.getViewport({ scale: 1 });
      onSize(page, { width: natural.width, height: natural.height });
      const viewport = proxy.getViewport({ scale });

      const canvas = document.createElement("canvas");
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
      );
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.className = "absolute inset-0 size-full";
      renderTask = proxy.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await renderTask.promise;
      if (cancelled) return;
      canvasDiv.replaceChildren(canvas);
      hasDrawn.current = true;
      setDrawn(true);

      if (scanned) {
        const read = scannedTextLayer(scanned, natural.width, natural.height);
        textDiv.replaceChildren(read.container);
        textRuns.current = read;
      } else {
        const { content } = await readPdfPageText(proxy, await pdf.getSignatures());
        if (cancelled) return;
        const container = document.createElement("div");
        container.className = "textLayer";
        layer = new pdfjs.TextLayer({ textContentSource: content, container, viewport });
        await layer.render();
        if (cancelled) return;
        textDiv.replaceChildren(container);
        textRuns.current = { divs: layer.textDivs, strings: layer.textContentItemsStr };
      }
      setLayerScale(scale);
      setTextLayerVersion((version) => version + 1);
    };
    // The first draw is immediate; a draw for a new scale waits until it settles, so that
    // a page coming into view during a pinch isn't started again at each of its events.
    const timer = setTimeout(
      () =>
        draw().catch((error: unknown) => {
          if (!cancelled && !(error instanceof pdfjs.RenderingCancelledException)) {
            console.error(error);
          }
        }),
      hasDrawn.current || rescaled ? RERENDER_DELAY : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      renderTask?.cancel();
      layer?.cancel();
    };
  }, [pdfjs, pdf, page, scale, nearby, scanned, onSize]);

  // Marks the quote in the text layer, and lets the view move to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs for each new text layer
  useEffect(() => {
    const runs = textRuns.current;
    if (!runs) return;
    const { divs, strings } = runs;
    let first: HTMLElement | null = null;
    const marked: number[] = [];
    // A run can hold two parts of a quote with an ellipsis: its ranges, in order.
    const byItem = new Map<number, { start: number; end: number }[]>();
    for (const { item, start, end } of highlights ?? []) {
      byItem.set(item, [...(byItem.get(item) ?? []), { start, end }]);
    }
    for (const [item, ranges] of byItem) {
      const div = divs[item];
      const text = strings[item];
      if (!div || text === undefined) continue;
      marked.push(item);
      const [only] = ranges;
      if (ranges.length === 1 && only && only.start === 0 && only.end === text.length) {
        div.classList.add("highlight");
        div.dataset.quoteHighlight = "";
        first ??= div;
        continue;
      }
      const children: (string | HTMLElement)[] = [];
      let at = 0;
      for (const { start, end } of ranges) {
        const mark = document.createElement("span");
        mark.className = "highlight appended";
        mark.textContent = text.slice(start, end);
        mark.dataset.quoteHighlight = "";
        children.push(text.slice(at, start), mark);
        at = end;
        first ??= mark;
      }
      div.replaceChildren(...children, text.slice(at));
    }
    firstHighlight.current = first;
    if (first) onHighlightShown(page, first);
    return () => {
      firstHighlight.current = null;
      for (const item of marked) {
        const div = divs[item];
        if (!div) continue;
        div.classList.remove("highlight");
        delete div.dataset.quoteHighlight;
        div.textContent = strings[item] ?? "";
      }
    };
  }, [textLayerVersion, highlights, page, onHighlightShown]);

  // Places the Citation's mark beside the quote's first line, once the quote is marked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-placed for each new text layer
  useEffect(() => {
    const element = section.current;
    const first = firstHighlight.current;
    const runs = textRuns.current?.divs;
    setPlace(mark && element && first && runs ? markPlace(first, element, runs) : null);
  }, [textLayerVersion, highlights, mark]);

  // The margin past the text: the mark shows its label only if the label fits there.
  const pageWidth = Math.floor(size.width * scale);
  const pageHeight = Math.floor(size.height * scale);
  const room = place ? pageWidth * (1 - place.textRight) - MARK_GAP - 4 : undefined;
  // The text layer keeps the size it was made at, scaled to fit the page, until it's made again
  // at the new scale: through a zoom (a pinch's above all) its runs of text, which size and place
  // themselves from `--scale-factor`, aren't laid out again at each step.
  const textScale = layerScale ?? scale;
  const textWidth = Math.floor(size.width * textScale);
  const textHeight = Math.floor(size.height * textScale);

  return (
    <section
      ref={(element) => {
        section.current = element;
        setElement(page, element);
      }}
      data-page-number={page}
      data-drawn={drawn ? "true" : "false"}
      aria-label={t("viewer.page.label", { number: page })}
      className="viewer-page relative shrink-0"
      style={{ width: pageWidth, height: pageHeight }}
    >
      <div ref={canvasHost} className="absolute inset-0" />
      <div
        ref={textHost}
        className="pdf-page-text absolute top-0 left-0 origin-top-left"
        style={
          {
            width: textWidth,
            height: textHeight,
            "--scale-factor": textScale,
            transform:
              textScale === scale || textWidth === 0 || textHeight === 0
                ? undefined
                : `scale(${pageWidth / textWidth}, ${pageHeight / textHeight})`,
          } as CSSProperties
        }
      />
      {mark && place && (
        <CitationMark
          mark={mark}
          room={room}
          style={{
            top: `calc(${place.lineMiddle * 100}% - 9px)`,
            left: `min(calc(${place.textRight * 100}% + ${MARK_GAP}px), calc(100% - ${MARK_ROOM}px))`,
          }}
        />
      )}
    </section>
  );
});
