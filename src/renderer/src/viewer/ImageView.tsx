/**
 * A picture Document in the viewer (#762): the picture itself, with the text
 * read from it on this computer laid over it line by line as a text layer of
 * transparent runs, as a scanned PDF page's is, so its text can be selected
 * and a Cited quote washed where it is in the picture. A picture opened at a
 * Citation is washed and scrolled to; without its text read yet it shows the
 * picture alone.
 */
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Document } from "../../../core/api";
import { isHeifPicture } from "../../../core/documents/formats/images";
import { displayName } from "../../../shared/documentNames";
import { findQuoteInPages } from "../../../shared/quoteMatch";
import { DocumentFix } from "../components/DocumentFix";
import { files } from "../core";
import { useT } from "../i18n";
import type { ViewerTarget } from "../store";
import { loadDocumentBytes, MissingDocumentError } from "./documentBytes";
import { FitWidthIcon, ZoomInIcon, ZoomOutIcon } from "./icons";
import { CitationMark, quoteMarkOf } from "./quoteMark";
import { scannedTextLayer, useScannedPages } from "./scannedText";
import { pdfSelection, useSelectionReader } from "./selectedText";
import { UnreadPagesLine } from "./UnreadPagesLine";
import { HeaderDivider, ViewerHeader } from "./ViewerHeader";
import { FileGone, ViewerMessage } from "./ViewerMessage";
import { createWheelZoom, MAX_ZOOM, MIN_ZOOM, stepZoom } from "./zoom";

/** Space around the picture, in CSS pixels. */
const PADDING = 24;
/** On macOS ⌘ with the wheel zooms too, as Ctrl does. */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** A picture fitted to the width never shows larger than it is: a phone photo stays sharp. */
const MOST_FIT = 1;

type Zoom = { fit: true } | { fit: false; zoom: number };

type Loaded =
  | { kind: "loading" }
  | { kind: "ready"; url: string; width: number; height: number }
  | { kind: "missing" }
  | { kind: "failed"; message: string };

/** The media type of a picture file, by its extension. */
function pictureType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "heic" || extension === "heif") return "image/heic";
  return "image/jpeg";
}

/** Part of a quote, in one of the text layer's runs. */
interface RunHighlight {
  item: number;
  start: number;
  end: number;
}

export function ImageView({ document, target }: { document: Document; target: ViewerTarget }) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<Zoom>({ fit: true });
  const [viewWidth, setViewWidth] = useState(0);
  const [marked, setMarked] = useState(0);
  const [place, setPlace] = useState<{ line: number; right: number } | null>(null);
  const scanned = useScannedPages(document);
  const page = scanned.get(1);
  const scroller = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const textRuns = useRef<{ divs: readonly HTMLElement[]; strings: readonly string[] } | null>(
    null,
  );
  const firstHighlight = useRef<HTMLElement | null>(null);
  const shown = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again at Retry, and when the file's version changes
  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    loadDocumentBytes(document.id, controller.signal)
      .then(async (bytes) => {
        // A HEIC is a picture the web engine can't show: this computer's decoder makes it a PNG.
        const decoded = isHeifPicture(bytes)
          ? await files.decodePicture(bytes).catch(() => null)
          : null;
        const display = decoded ?? bytes;
        if (controller.signal.aborted) return;
        const copy = display.buffer.slice(
          display.byteOffset,
          display.byteOffset + display.byteLength,
        ) as ArrayBuffer;
        url = URL.createObjectURL(
          new Blob([copy], { type: decoded ? "image/png" : pictureType(document.path) }),
        );
        setLoaded({ kind: "ready", url, width: 0, height: 0 });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof MissingDocumentError) setLoaded({ kind: "missing" });
        else setLoaded({ kind: "failed", message: error instanceof Error ? error.message : "" });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [document.id, document.path, document.contentHash, attempt]);

  // The width the picture is fitted to; a resize fits it again at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the picture is there to fit
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded.kind]);

  useSelectionReader(
    useCallback(
      (range) => (scroller.current ? pdfSelection(range, scroller.current) : { parts: [] }),
      [],
    ),
  );

  const natural = {
    width: loaded.kind === "ready" ? loaded.width : 0,
    height: loaded.kind === "ready" ? loaded.height : 0,
  };
  const fit =
    viewWidth > 0 && natural.width > 0
      ? Math.max(0.05, Math.min(MOST_FIT, (viewWidth - 2 * PADDING) / natural.width))
      : 1;
  const scale = zoom.fit ? fit : zoom.zoom;
  const width = Math.floor(natural.width * scale);
  const height = Math.floor(natural.height * scale);

  // biome-ignore lint/correctness/useExhaustiveDependencies: found again for each open request
  const highlights = useMemo(() => {
    if (!page || !target.quote) return [] as RunHighlight[];
    const found = findQuoteInPages([page.pieces], target.quote);
    return found?.map((part) => ({ item: part.piece, start: part.start, end: part.end })) ?? [];
  }, [page, target.quote, target.request]);

  // Lays the text read from the picture over it, then washes the quote in it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: laid again once the picture's size is known
  useEffect(() => {
    const host = textHost.current;
    if (!host || !page || natural.width === 0) return;
    const layer = scannedTextLayer(page, natural.width, natural.height);
    host.replaceChildren(layer.container);
    textRuns.current = layer;
    const { divs, strings } = layer;
    let first: HTMLElement | null = null;
    const byItem = new Map<number, { start: number; end: number }[]>();
    for (const { item, start, end } of highlights) {
      byItem.set(item, [...(byItem.get(item) ?? []), { start, end }]);
    }
    for (const [item, ranges] of byItem) {
      const div = divs[item];
      const text = strings[item];
      if (!div || text === undefined) continue;
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
        const mark = window.document.createElement("span");
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
    setMarked((count) => count + 1);
  }, [page, natural.width, natural.height, highlights, loaded.kind]);

  const mark = useMemo(() => quoteMarkOf(target.citation), [target.citation]);

  // Places the Citation's mark beside the quote's first line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again for each new text layer
  useEffect(() => {
    const element = section.current;
    const first = firstHighlight.current;
    const runs = textRuns.current?.divs;
    if (!mark || !element || !first || !runs) {
      setPlace(null);
      return;
    }
    const line = first.getClientRects()[0] ?? first.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    let right = line.right;
    for (const run of runs) {
      const rect = run.getBoundingClientRect();
      if (rect.width > 0 && rect.right > right) right = rect.right;
    }
    setPlace({
      line: (line.top + line.height / 2 - box.top) / box.height,
      right: Math.min(1, (right - box.left) / box.width),
    });
  }, [mark, marked]);

  // A quote is there: the view goes to it, once for each open request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once for each request
  useEffect(() => {
    const container = scroller.current;
    const first = firstHighlight.current;
    if (!container || !first || target.quote === undefined) return;
    if (shown.current === target.request) return;
    shown.current = target.request;
    const box = container.getBoundingClientRect();
    const rect = first.getBoundingClientRect();
    container.scrollTop = rect.top - box.top + container.scrollTop - container.clientHeight / 3;
  }, [marked, target.request, target.quote]);

  // Ctrl (or ⌘ on macOS) with the wheel zooms, as in a PDF.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const gesture = createWheelZoom({ mac: IS_MAC });
    const onKey = (event: globalThis.KeyboardEvent) => gesture.keyChanged(event);
    const onBlur = () => gesture.blur();
    const onWheel = (event: WheelEvent) => {
      if (!gesture.isZoom(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setZoom((now) => {
        const current = now.fit ? fit : now.zoom;
        return { fit: false, zoom: gesture.zoom(event, current) };
      });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      element.removeEventListener("wheel", onWheel);
    };
  }, [fit]);

  const current = zoom.fit ? fit : zoom.zoom;
  const zoomStep = (direction: number) =>
    setZoom({ fit: false, zoom: stepZoom(current, direction) });
  const reload = () => {
    setLoaded({ kind: "loading" });
    setAttempt((count) => count + 1);
  };
  const room = place ? width * (1 - place.right) - 12 - 4 : undefined;

  return (
    <>
      <ViewerHeader openable={loaded.kind !== "missing"} onRetry={reload}>
        <HeaderDivider />
        <button
          type="button"
          data-testid="image-zoom-out"
          aria-label={t("viewer.zoom.out")}
          title={t("viewer.zoom.out")}
          disabled={current <= MIN_ZOOM}
          onClick={() => zoomStep(-1)}
          className="viewer-icon-button"
        >
          <ZoomOutIcon className="size-4" />
        </button>
        <span
          data-testid="image-zoom-level"
          title={t("viewer.zoom.level", { percent: Math.round(current * 100) })}
          className="viewer-zoom-level"
        >
          {Math.round(current * 100)}%
        </span>
        <button
          type="button"
          data-testid="image-zoom-in"
          aria-label={t("viewer.zoom.in")}
          title={t("viewer.zoom.in")}
          disabled={current >= MAX_ZOOM}
          onClick={() => zoomStep(1)}
          className="viewer-icon-button"
        >
          <ZoomInIcon className="size-4" />
        </button>
        <button
          type="button"
          data-testid="image-fit-width"
          aria-label={t("viewer.zoom.fitWidth")}
          title={t("viewer.zoom.fitWidth")}
          aria-pressed={zoom.fit}
          onClick={() => setZoom({ fit: true })}
          className="viewer-icon-button"
        >
          <FitWidthIcon className="size-4" />
        </button>
      </ViewerHeader>
      <UnreadPagesLine document={document} />
      {loaded.kind === "loading" ? (
        <ViewerMessage>{t("viewer.loading")}</ViewerMessage>
      ) : loaded.kind === "missing" ? (
        <FileGone quote={target.quote} />
      ) : loaded.kind === "failed" ? (
        <DocumentFix
          document={document}
          view
          message={loaded.message}
          reload={reload}
          fallback={
            <ViewerMessage tone="error">
              {loaded.message
                ? t("viewer.failed", { message: loaded.message })
                : t("viewer.pictureNotShown")}
            </ViewerMessage>
          }
        />
      ) : (
        <div
          ref={scroller}
          data-testid="image-scroller"
          className="viewer-backdrop relative min-w-0 flex-1 overflow-auto [overflow-anchor:none]"
        >
          <div
            className="flex min-h-full w-max min-w-full items-start justify-center"
            style={{ padding: PADDING }}
          >
            <section
              ref={section}
              data-page-number={1}
              aria-label={t("viewer.page.label", { number: 1 })}
              className="viewer-page relative shrink-0"
              style={{ width, height }}
            >
              <img
                src={loaded.url}
                alt={displayName(document)}
                draggable={false}
                data-testid="image-picture"
                className="absolute inset-0 size-full select-none object-contain"
                onError={() => setLoaded({ kind: "failed", message: "" })}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  if (image.naturalWidth > 0) {
                    setLoaded({
                      kind: "ready",
                      url: loaded.url,
                      width: image.naturalWidth,
                      height: image.naturalHeight,
                    });
                  }
                }}
              />
              <div
                ref={textHost}
                className="pdf-page-text absolute top-0 left-0 origin-top-left"
                style={
                  {
                    width: Math.floor(natural.width * scale),
                    height: Math.floor(natural.height * scale),
                    "--scale-factor": scale,
                  } as CSSProperties
                }
              />
              {mark && place && (
                <CitationMark
                  mark={mark}
                  room={room}
                  style={{
                    top: `calc(${place.line * 100}% - 9px)`,
                    left: `min(calc(${place.right * 100}% + 12px), calc(100% - 40px))`,
                  }}
                />
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}
