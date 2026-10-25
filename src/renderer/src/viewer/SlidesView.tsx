import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Document } from "../../../core/api";
import {
  extractPptx,
  imageDataUrl,
  type PptxResult,
  type SlideOutline,
} from "../../../core/documents/formats/pptx";
import {
  type DeckDrawing,
  drawPptx,
  type FailedSlide,
  type Item,
  type SlideDrawing,
} from "../../../core/documents/formats/pptxDrawing";
import { findQuoteInPieces, type TextRange } from "../../../shared/quoteMatch";
import { useT } from "../i18n";
import type { ViewerTarget } from "../store";
import { useCitedArea } from "./citedArea";
import { FileStates } from "./FileStates";
import { HighlightedText } from "./highlightedText";
import {
  CitationMark,
  marginRoom,
  markTopFor,
  type QuoteMark,
  quoteMarkOf,
  quoteTone,
} from "./quoteMark";
import { domSelection, useSelectionReader } from "./selectedText";
import { findInDrawing, rangesByKey } from "./slides/pieces";
import { SlideCanvas } from "./slides/SlideCanvas";
import { OutlineButton, type OutlineEntry, UnitOutline } from "./UnitOutline";
import { useDocumentFile } from "./useDocumentFile";
import { ViewerHeader } from "./ViewerHeader";

interface Loaded {
  bytes: Uint8Array;
  deck: PptxResult;
  /** The slides as drawings; null when the deck couldn't be drawn, and is shown as an outline. */
  drawing: DeckDrawing | null;
}

const read = async (bytes: Uint8Array): Promise<Loaded> => {
  const deck = await extractPptx(bytes);
  let drawing: DeckDrawing | null = null;
  try {
    drawing = await drawPptx(bytes);
  } catch {
    drawing = null;
  }
  return { bytes, deck, drawing };
};

/** The backdrop's padding, and the gutter on its right where a Citation's mark and label go. */
const PADDING = 24;
const NARROW_PADDING = 16;
const MARK_GUTTER = 104;
const NARROW_MARK_GUTTER = 48;
/** The gap between a slide's edge and the mark. */
const MARK_GAP = 8;

/**
 * A PowerPoint deck (ADR-0011), drawn slide by slide as PowerPoint lays it
 * out (./slides): each slide at its own aspect ratio, scaled to the viewer's
 * width, with its number above it and its speaker notes folded under it.
 * Text stays text. Opened at a Citation, it goes to the cited slide and
 * highlights the quote in the slide's text, else in its notes (which open),
 * else marks the slide, with the Citation's mark in the gutter beside it.
 * Pictures are `data:` URLs, which the app's Content-Security-Policy allows;
 * nothing is fetched. A slide that can't be drawn, or a deck, is shown as
 * the outline it was before: title, text, tables, chart figures, images.
 */
export function SlidesView({ document, target }: { document: Document; target: ViewerTarget }) {
  const loaded = useDocumentFile(document.id, read);
  return (
    <FileStates
      loaded={loaded}
      quote={target.quote}
      ready={(value) => <Slides loaded={value} target={target} />}
    />
  );
}

/** Where the quote was found: in a drawn slide's text, an outline sheet's, a slide's notes, or nowhere (a slide-level mark). */
type Found =
  | { slide: number; where: "slide" | "outline" | "notes"; ranges: Map<string, TextRange[]> }
  | { slide: number; where: "none" };

const isFailed = (slide: SlideDrawing | FailedSlide): slide is FailedSlide => "failed" in slide;

/** The title an outline shows for a slide: its title, or else its first line of text. */
const outlineTitle = (slide: SlideOutline) =>
  slide.title ?? slide.blocks[0]?.[0] ?? slide.tables[0]?.[0]?.[0] ?? "";

const notesKey = (index: number) => `notes${index}`;

function findInNotes(slide: SlideOutline, quote: string): Map<string, TextRange[]> | null {
  return rangesByKey(
    slide.notes.map((text, index) => ({ key: notesKey(index), text, breakAfter: true })),
    quote,
  );
}

/** The package parts of every picture a drawing shows, its backgrounds' and fills' too. */
function pictureParts(slide: SlideDrawing): string[] {
  const parts: string[] = [];
  if (slide.background.kind === "image") parts.push(slide.background.part);
  const walk = (items: readonly Item[]) => {
    for (const item of items) {
      if (item.kind === "picture" && item.part) parts.push(item.part);
      if (item.kind === "shape" && item.fill.kind === "image") parts.push(item.fill.part);
      if (item.kind === "group") walk(item.children);
      if (item.kind === "table") {
        for (const row of item.rows) {
          for (const cell of row.cells) if (cell.fill.kind === "image") parts.push(cell.fill.part);
        }
      }
    }
  };
  walk(slide.items);
  return parts;
}

// A slide's speaker notes are part of its Unit (ADR-0011).
const slideOf = (node: Node) => {
  const slide = node.parentElement?.closest<HTMLElement>("[data-slide]")?.dataset.slide;
  return slide ? Number(slide) : null;
};

function Slides({ loaded, target }: { loaded: Loaded; target: ViewerTarget }) {
  const t = useT();
  const { slides } = loaded.deck;
  const { drawing } = loaded;
  const scroller = useRef<HTMLDivElement>(null);
  useSelectionReader(
    useCallback(
      (range) =>
        scroller.current ? domSelection(range, scroller.current, slideOf) : { parts: [] },
      [],
    ),
  );
  const slideElements = useRef(new Map<number, HTMLElement>());
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [images, setImages] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [viewWidth, setViewWidth] = useState(0);
  const [notesToggled, setNotesToggled] = useState<ReadonlyMap<number, boolean>>(new Map());
  const appliedRequest = useRef<number | null>(null);

  const drawn = useMemo(
    () => new Map((drawing?.slides ?? []).map((slide) => [slide.number, slide])),
    [drawing],
  );

  // The quote: in the cited slide (or the next, for two), else in any slide; in its text, then its notes.
  const highlight = useMemo((): Found | null => {
    const quote = target.quote;
    if (!quote) return null;
    const from = target.pageFrom ?? 1;
    const to = target.pageTo ?? from;
    const cited = slides.filter((slide) => slide.number >= from && slide.number <= to);
    const ordered = [...cited, ...slides.filter((slide) => !cited.includes(slide))];
    for (const slide of ordered) {
      const drawnSlide = drawn.get(slide.number);
      if (drawnSlide && !isFailed(drawnSlide)) {
        const ranges = findInDrawing(drawnSlide, quote);
        if (ranges) return { slide: slide.number, where: "slide", ranges };
        const notes = findInNotes(slide, quote);
        if (notes) return { slide: slide.number, where: "notes", ranges: notes };
      } else {
        const ranges = findInOutline(slide, quote);
        if (ranges) return { slide: slide.number, where: "outline", ranges };
      }
    }
    const citedSlide = target.pageFrom;
    return citedSlide !== undefined && slides.some((slide) => slide.number === citedSlide)
      ? { slide: citedSlide, where: "none" }
      : null;
  }, [slides, drawn, target.quote, target.pageFrom, target.pageTo]);
  const mark = useMemo(() => quoteMarkOf(target.citation), [target.citation]);

  // The slides fit the viewer's width, beside a gutter for the Citation's mark when there is one.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const narrow = viewWidth > 0 && viewWidth < 520;
  const padding = narrow ? NARROW_PADDING : PADDING;
  const gutter =
    drawing && mark && highlight ? (narrow ? NARROW_MARK_GUTTER : MARK_GUTTER) : padding;
  const scale = drawing
    ? Math.min(2, Math.max(0.05, (viewWidth - padding - gutter) / Math.max(drawing.width, 1)))
    : 1;

  // Pictures, read from the package as data: URLs: the cited slide's first, then in order.
  useEffect(() => {
    let cancelled = false;
    const cited = target.pageFrom ?? 1;
    const groups: string[][] = drawing
      ? [...drawing.slides]
          .sort((a, b) => (a.number === cited ? -1 : b.number === cited ? 1 : a.number - b.number))
          .map((slide) => (isFailed(slide) ? [] : pictureParts(slide)))
      : [];
    // Outline sheets (a deck or a slide that couldn't be drawn) show their images too.
    for (const slide of slides) {
      const each = drawn.get(slide.number);
      if (!each || isFailed(each)) groups.push(slide.images.map((image) => image.part));
    }
    void (async () => {
      const urls = new Map<string, string | null>();
      for (const group of groups) {
        let added = false;
        for (const part of group) {
          if (urls.has(part)) continue;
          urls.set(part, await imageDataUrl(loaded.bytes, part));
          added = true;
          if (cancelled) return;
        }
        if (added) setImages(new Map(urls));
      }
      if (!cancelled) setImages(new Map(urls));
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded.bytes, drawing, slides, drawn, target.pageFrom]);

  // A cited page drawn to save it (#133): the cited slides, once their pictures are in.
  const citedFrom = target.pageFrom ?? 1;
  const citedTo = target.pageTo ?? citedFrom;
  const citedPictures = useMemo(
    () =>
      slides
        .filter((slide) => slide.number >= citedFrom && slide.number <= citedTo)
        .flatMap((slide) => {
          const each = drawn.get(slide.number);
          return each && !isFailed(each)
            ? pictureParts(each)
            : slide.images.map((image) => image.part);
        }),
    [slides, drawn, citedFrom, citedTo],
  );
  const citedArea = useCallback(() => {
    const elements: HTMLElement[] = [];
    for (let number = citedFrom; number <= citedTo; number++) {
      const element = slideElements.current.get(number);
      if (element) elements.push(element);
    }
    return elements.length > 0 ? elements : null;
  }, [citedFrom, citedTo]);
  useCitedArea(viewWidth > 0 && citedPictures.every((part) => images.has(part)), citedArea);

  // Each open request goes to its quote, else to its slide, else the top.
  useLayoutEffect(() => {
    const container = scroller.current;
    if (!container || viewWidth === 0 || appliedRequest.current === target.request) return;
    appliedRequest.current = target.request;
    setNotesToggled(new Map());
    const first = container.querySelector<HTMLElement>("[data-quote-highlight]");
    const slide = slideElements.current.get(highlight?.slide ?? target.pageFrom ?? 0);
    const anchor = first ?? slide;
    if (!anchor) {
      container.scrollTop = 0;
      return;
    }
    const top =
      anchor.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    container.scrollTop = Math.max(0, top - (first ? container.clientHeight / 3 : padding));
    setCurrent(highlight?.slide ?? target.pageFrom ?? null);
  }, [highlight, target.request, target.pageFrom, viewWidth, padding]);

  const onScroll = () => {
    const container = scroller.current;
    if (!container || !outlineOpen) return;
    const top = container.getBoundingClientRect().top + 48;
    let number: number | null = null;
    for (const [slide, element] of slideElements.current) {
      if (element.getBoundingClientRect().top <= top && (number === null || slide > number)) {
        number = slide;
      }
    }
    setCurrent(number ?? slides[0]?.number ?? null);
  };

  const outline: OutlineEntry[] = slides.map((slide) => ({
    key: slide.number,
    title: outlineTitle(slide) || t("viewer.slide.untitled"),
    depth: 0,
    prefix: String(slide.number),
  }));
  const goTo = (number: number) => {
    const container = scroller.current;
    const element = slideElements.current.get(number);
    if (!container || !element) return;
    container.scrollTop =
      element.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      padding;
    setCurrent(number);
  };
  const setElement = (number: number) => (element: HTMLElement | null) => {
    if (element) slideElements.current.set(number, element);
    else slideElements.current.delete(number);
  };

  return (
    <>
      <ViewerHeader
        leading={
          slides.length > 0 && (
            <OutlineButton open={outlineOpen} onToggle={() => setOutlineOpen((open) => !open)} />
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        {outlineOpen && <UnitOutline entries={outline} current={current} onGo={goTo} />}
        <div
          ref={scroller}
          data-testid="viewer-slides"
          data-drawn={drawing ? "yes" : "no"}
          data-quote-tone={quoteTone(target.citation)}
          onScroll={onScroll}
          className={`viewer-backdrop min-w-0 flex-1 overflow-auto select-text ${drawing ? "viewer-deck-backdrop" : "viewer-slides-backdrop"}`}
          style={drawing ? { paddingLeft: padding, paddingRight: gutter } : undefined}
        >
          {viewWidth > 0 &&
            slides.map((slide) => {
              const found = highlight?.slide === slide.number ? highlight : null;
              const drawnSlide = drawn.get(slide.number);
              if (!drawing || !drawnSlide || isFailed(drawnSlide)) {
                return (
                  <SlideSheet
                    key={slide.number}
                    slide={slide}
                    images={images}
                    ranges={found && found.where === "outline" ? found.ranges : null}
                    mark={found ? mark : null}
                    width={drawing ? drawing.width * scale : undefined}
                    setElement={setElement(slide.number)}
                  />
                );
              }
              const notesOpen = notesToggled.get(slide.number) ?? found?.where === "notes";
              return (
                <SlideFrame
                  key={slide.number}
                  outline={slide}
                  slide={drawnSlide}
                  width={drawing.width}
                  height={drawing.height}
                  scale={scale}
                  images={images}
                  found={found}
                  mark={found ? mark : null}
                  markRoom={gutter - MARK_GAP - 8}
                  notesOpen={notesOpen}
                  onNotesToggle={(open) =>
                    setNotesToggled((before) => new Map(before).set(slide.number, open))
                  }
                  setElement={setElement(slide.number)}
                />
              );
            })}
        </div>
      </div>
    </>
  );
}

/** A drawn slide: its number, the slide scaled to the column, and its notes folded under it. */
function SlideFrame({
  outline,
  slide,
  width,
  height,
  scale,
  images,
  found,
  mark,
  markRoom,
  notesOpen,
  onNotesToggle,
  setElement,
}: {
  outline: SlideOutline;
  slide: SlideDrawing;
  width: number;
  height: number;
  scale: number;
  images: ReadonlyMap<string, string | null>;
  found: Found | null;
  mark: QuoteMark | null;
  markRoom: number;
  notesOpen: boolean;
  onNotesToggle(open: boolean): void;
  setElement(element: HTMLElement | null): void;
}) {
  const t = useT();
  const frame = useRef<HTMLElement | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [markTop, setMarkTop] = useState<number | null>(null);
  const slideRanges = found?.where === "slide" ? found.ranges : null;
  const notesRanges = found?.where === "notes" ? found.ranges : null;

  // The mark sits in the gutter, level with the quote's first line, or the slide's top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again as the slide scales or its notes open
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element || !mark || !found) {
      setMarkTop(null);
      return;
    }
    const place = () => {
      const first = element.querySelector("[data-quote-highlight]");
      const top = sheet.current ? sheet.current.offsetTop + 8 : 0;
      setMarkTop(first ? markTopFor(first, element) : top);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mark, found, scale, notesOpen]);

  return (
    <article
      ref={(element) => {
        frame.current = element;
        setElement(element);
      }}
      data-testid="viewer-slide"
      data-slide={slide.number}
      data-quote-found={found ? found.where : undefined}
      aria-label={t("viewer.slide.label", { number: slide.number })}
      className={`viewer-deck-slide ${outline.hidden ? "viewer-deck-slide--hidden" : ""}`}
      style={{ width: width * scale }}
    >
      <p data-quote-skip="" className="viewer-slide-number">
        {t("viewer.slide.label", { number: slide.number })}
        {outline.hidden && <span> · {t("viewer.slide.hidden")}</span>}
      </p>
      <div
        ref={sheet}
        className="viewer-deck-sheet"
        style={{ width: width * scale, height: height * scale }}
      >
        <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", width, height }}>
          <SlideCanvas
            slide={slide}
            width={width}
            height={height}
            images={images}
            ranges={slideRanges}
          />
        </div>
      </div>
      {outline.notes.length > 0 && (
        <details
          data-testid="viewer-slide-notes"
          className="viewer-deck-notes"
          open={notesOpen}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            if (open !== notesOpen) onNotesToggle(open);
          }}
        >
          <summary data-quote-skip="">{t("viewer.slide.notes")}</summary>
          <div className="viewer-deck-notes-body">
            {outline.notes.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: notes never reorder
              <p key={index}>
                <HighlightedText text={line} ranges={notesRanges?.get(notesKey(index))} />
              </p>
            ))}
          </div>
        </details>
      )}
      {mark && markTop !== null && (
        <CitationMark
          mark={mark}
          room={markRoom}
          style={{ top: markTop, left: `calc(100% + ${MARK_GAP}px)` }}
        />
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* The outline: a slide that couldn't be drawn, or a deck              */

/** One string an outline sheet shows, with an id the highlight finds it by. */
interface Shown {
  id: string;
  text: string;
}

/** What an outline sheet shows, in order: the strings a quote is looked for in. */
function shownStrings(slide: SlideOutline): Shown[] {
  const shown: Shown[] = [];
  if (slide.title) shown.push({ id: "title", text: slide.title });
  for (const [block, lines] of slide.blocks.entries()) {
    for (const [line, text] of lines.entries()) shown.push({ id: `block${block}.${line}`, text });
  }
  for (const [table, rows] of slide.tables.entries()) {
    for (const [row, cells] of rows.entries()) {
      for (const [cell, text] of cells.entries()) {
        shown.push({ id: `table${table}.${row}.${cell}`, text });
      }
    }
  }
  for (const [index, chart] of slide.charts.entries()) {
    for (const [line, text] of chart.split("\n").entries()) {
      shown.push({ id: `chart${index}.${line}`, text });
    }
  }
  for (const [line, text] of slide.notes.entries()) shown.push({ id: `notes${line}`, text });
  return shown;
}

/**
 * Where a quote is in an outline sheet: its highlighted parts, by the id of
 * the string they are in. A chart's figures are matched as the check matches
 * a slide's, however their thousands are written when the quote isn't found as it is.
 */
function findInOutline(slide: SlideOutline, quote: string): Map<string, TextRange[]> | null {
  const shown = shownStrings(slide).filter((each) => each.text);
  const found = findQuoteInPieces(
    shown.map((each) => ({ text: each.text, breakAfter: true })),
    quote,
    { numbers: "if-needed" },
  );
  if (!found) return null;
  const byId = new Map<string, TextRange[]>();
  for (const part of found) {
    const id = (shown[part.piece] as Shown).id;
    byId.set(id, [...(byId.get(id) ?? []), { start: part.start, end: part.end }]);
  }
  return byId;
}

/** A slide as an outline sheet: its number, title, text, tables, charts' figures, images and notes. */
function SlideSheet({
  slide,
  images,
  ranges,
  mark,
  width,
  setElement,
}: {
  slide: SlideOutline;
  images: ReadonlyMap<string, string | null>;
  ranges: Map<string, TextRange[]> | null;
  mark: QuoteMark | null;
  /** In a drawn deck, the width of its slides. */
  width: number | undefined;
  setElement(element: HTMLElement | null): void;
}) {
  const t = useT();
  const column = useRef<HTMLDivElement>(null);
  const [markTop, setMarkTop] = useState<number | null>(null);
  const [markRoom, setMarkRoom] = useState(0);
  const text = (id: string, value: string) => (
    <HighlightedText text={value} ranges={ranges?.get(id)} />
  );

  // The mark sits beside the quote's first line, wherever the slide wraps it, or at its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again when the highlight moves
  useLayoutEffect(() => {
    const element = column.current;
    if (!element || !mark) {
      setMarkTop(null);
      return;
    }
    const place = () => {
      const first = element.querySelector("[data-quote-highlight]");
      setMarkTop(first ? markTopFor(first, element) : 0);
      setMarkRoom(marginRoom(element));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mark, ranges]);

  return (
    <article
      ref={setElement}
      data-testid="viewer-slide"
      data-slide={slide.number}
      data-outline=""
      aria-label={t("viewer.slide.label", { number: slide.number })}
      className={`viewer-page viewer-slide ${slide.hidden ? "viewer-slide--hidden" : ""}`}
      style={width !== undefined ? { width, maxWidth: "none" } : undefined}
    >
      <div ref={column} className="relative">
        <p data-quote-skip="" className="viewer-slide-number">
          {t("viewer.slide.label", { number: slide.number })}
          {slide.hidden && <span> · {t("viewer.slide.hidden")}</span>}
        </p>
        {slide.title && <h2 className="viewer-slide-title">{text("title", slide.title)}</h2>}
        <div className="viewer-slide-body">
          {slide.blocks.map((lines, block) =>
            lines.length > 1 ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: a slide's blocks never reorder
              <ul key={block}>
                {lines.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: neither do their lines
                  <li key={index}>{text(`block${block}.${index}`, line)}</li>
                ))}
              </ul>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: a slide's blocks never reorder
              <p key={block}>{text(`block${block}.0`, lines[0] ?? "")}</p>
            ),
          )}
          {slide.tables.map((rows, table) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a slide's tables never reorder
            <table key={table} className="viewer-slide-table">
              <tbody>
                {rows.map((cells, row) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: nor their rows
                  <tr key={row} className={row === 0 ? "viewer-slide-row--head" : undefined}>
                    {cells.map((cell, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: nor their cells
                      <td key={index} className="viewer-slide-cell">
                        {text(`table${table}.${row}.${index}`, cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
          {slide.charts.map((chart, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a slide's charts never reorder
            <figure key={index} className="viewer-slide-chart">
              <figcaption>{t("viewer.slide.chart")}</figcaption>
              {chart.split("\n").map((line, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: nor their lines
                <p key={at}>{text(`chart${index}.${at}`, line)}</p>
              ))}
            </figure>
          ))}
          {slide.images.map((image, index) => {
            const url = images.get(image.part);
            return url ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: a slide's images never reorder
              <img key={index} src={url} alt={image.alt} className="viewer-slide-image" />
            ) : null;
          })}
        </div>
        {slide.notes.length > 0 && (
          <section data-testid="viewer-slide-notes" className="viewer-slide-notes">
            <h3 data-quote-skip="">{t("viewer.slide.notes")}</h3>
            {slide.notes.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: notes never reorder
              <p key={index}>{text(`notes${index}`, line)}</p>
            ))}
          </section>
        )}
        {mark && markTop !== null && (
          <CitationMark
            mark={mark}
            room={markRoom}
            style={{ top: markTop, left: "calc(100% + 12px)" }}
          />
        )}
      </div>
    </article>
  );
}
