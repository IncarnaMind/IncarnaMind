import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Document } from "../../../core/api";
import { decodeText } from "../../../core/documents/decode";
import { htmlMarkdown } from "../../../core/documents/formats/html";
import { rtfMarkdown } from "../../../core/documents/formats/rtf";
import { lineUnits, markdownUnits, type SourceUnit } from "../../../core/documents/formats/text";
import { findQuote, type TextRange } from "../../../shared/quoteMatch";
import { DocumentFix } from "../components/DocumentFix";
import { useT } from "../i18n";
import type { ViewerTarget } from "../store";
import { type CitedArea, useCitedArea, useCitedAreaFailure } from "./citedArea";
import { loadDocumentBytes, MissingDocumentError } from "./documentBytes";
import { MarkdownBlocks, MarkdownDocumentContext, Slice } from "./MarkdownBlocks";
import { parseMarkdown } from "./markdown";
import { looksLikeCode } from "./plainText";
import { CitationMark, marginRoom, markTopFor, quoteMarkOf, quoteTone } from "./quoteMark";
import { sourceSelection, useSelectionReader } from "./selectedText";
import { OutlineButton, type OutlineEntry, UnitOutline } from "./UnitOutline";
import { ViewerHeader } from "./ViewerHeader";
import { FileGone, ViewerMessage } from "./ViewerMessage";

type Loaded =
  | { kind: "loading" }
  | { kind: "ready"; text: string }
  | { kind: "missing" }
  | { kind: "failed"; message: string };

/** Nothing to highlight. */
const NO_HIGHLIGHT: readonly TextRange[] = [];

/**
 * A TXT or Markdown Document, readable in the viewer on a page, like a PDF's.
 * Markdown is shown formatted, as it reads on GitHub: headings, lists,
 * tables, code, links, and the pictures beside the file; "Source" shows its
 * text as written. Plain text is set in the Mind's serif, or in a monospaced
 * font when it looks like code. Opened at a Citation, it highlights the quote
 * in the cited section (Markdown) or lines (TXT), each part of a quote with
 * an ellipsis, and scrolls to it. Only a target without a place searches the
 * whole file. Without a quote, it opens at the cited Unit, or the top. A
 * Markdown file's headings form an outline.
 */
export function TextView({ document, target }: { document: Document; target: ViewerTarget }) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [source, setSource] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the file is read again at the User's Retry, or when its version changes.
  useEffect(() => {
    const controller = new AbortController();
    loadDocumentBytes(document.id, controller.signal).then(
      (bytes) => {
        // Decoded the way processing decodes it, so quotes from its Passages match: an RTF
        // or HTML file as the text it reads as (#762), Markdown and text as written.
        const text =
          document.kind === "rtf"
            ? rtfMarkdown(bytes)
            : document.kind === "html"
              ? htmlMarkdown(bytes)
              : decodeText(bytes);
        setLoaded(text === null ? { kind: "failed", message: "" } : { kind: "ready", text });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof MissingDocumentError) setLoaded({ kind: "missing" });
        else setLoaded({ kind: "failed", message: error instanceof Error ? error.message : "" });
      },
    );
    return () => controller.abort();
  }, [document.id, document.contentHash, attempt]);

  useCitedAreaFailure(
    loaded.kind === "missing"
      ? loaded.kind
      : loaded.kind === "failed"
        ? loaded.message || loaded.kind
        : null,
  );
  const markdown = document.kind !== "text";
  const written = document.kind === "markdown";
  const units = useMemo(
    () =>
      loaded.kind !== "ready" ? [] : markdown ? markdownUnits(loaded.text) : lineUnits(loaded.text),
    [loaded, markdown],
  );
  const outline = useMemo(() => (markdown ? headingsOf(units) : []), [markdown, units]);
  const reload = () => setAttempt((count) => count + 1);

  return (
    <>
      <ViewerHeader
        openable={loaded.kind !== "missing"}
        leading={
          outline.length > 0 && (
            <OutlineButton open={outlineOpen} onToggle={() => setOutlineOpen((open) => !open)} />
          )
        }
      >
        {written && loaded.kind === "ready" && (
          <button
            type="button"
            data-testid="viewer-markdown-source"
            aria-pressed={source}
            title={source ? t("viewer.markdown.showFormatted") : t("viewer.markdown.showSource")}
            onClick={() => setSource((shown) => !shown)}
            className="viewer-text-button"
          >
            {t("viewer.markdown.source")}
          </button>
        )}
      </ViewerHeader>
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
                : t("viewer.notText")}
            </ViewerMessage>
          }
        />
      ) : (
        <MarkdownDocumentContext.Provider value={document.id}>
          <TextContent
            text={loaded.text}
            markdown={markdown}
            literal={document.kind !== "markdown"}
            source={source}
            units={units}
            outline={outlineOpen ? outline : null}
            target={target}
          />
        </MarkdownDocumentContext.Provider>
      )}
    </>
  );
}

/** A Markdown file's headings, for the outline: each section's, keyed by the heading's index. */
function headingsOf(units: readonly SourceUnit[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  for (const [unit, heading] of headingIndexes(units)) {
    if (heading < 0) continue;
    const path = unit.label?.path ?? [];
    entries.push({ key: heading, title: path.at(-1) ?? "", depth: Math.max(0, path.length - 1) });
  }
  return entries;
}

/**
 * The heading each section starts at, by its index among the file's headings
 * (-1 for the text before the first), for the Units that start a section.
 */
function headingIndexes(units: readonly SourceUnit[]): Map<SourceUnit, number> {
  const indexes = new Map<SourceUnit, number>();
  let heading = -1;
  for (const unit of units) {
    if (unit.label?.part) continue;
    if ((unit.label?.path ?? []).length > 0) heading++;
    indexes.set(unit, heading);
  }
  return indexes;
}

function TextContent({
  text,
  markdown,
  literal,
  source,
  units,
  outline,
  target,
}: {
  text: string;
  markdown: boolean;
  /** The text is the words it holds: no emphasis, code or links to read (#762). */
  literal: boolean;
  /** A Markdown file's text as written, rather than formatted. */
  source: boolean;
  units: readonly SourceUnit[];
  outline: readonly OutlineEntry[] | null;
  target: ViewerTarget;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  useSelectionReader(
    useCallback(
      (range) =>
        column.current ? sourceSelection(range, column.current, text, units) : { parts: [] },
      [text, units],
    ),
  );
  const appliedRequest = useRef<number | null>(null);
  const appliedMode = useRef(source);
  const [current, setCurrent] = useState<number | null>(null);

  // The cited Units' span of the file, when it has those Units.
  const cited = useMemo(() => {
    if (target.pageFrom === undefined) return null;
    const to = target.pageTo ?? target.pageFrom;
    const span = units.filter((unit) => unit.page >= (target.pageFrom ?? 0) && unit.page <= to);
    const first = span[0];
    const last = span.at(-1);
    return first && last ? { start: first.start, end: last.end, first } : null;
  }, [units, target.pageFrom, target.pageTo]);

  const highlight = useMemo(() => {
    const quote = target.quote;
    if (!quote) return NO_HIGHLIGHT;
    if (target.pageFrom !== undefined) {
      if (!cited) return NO_HIGHLIGHT;
      const inside = findQuote(text.slice(cited.start, cited.end), quote);
      if (inside) {
        return inside.map((range) => ({
          start: range.start + cited.start,
          end: range.end + cited.start,
        }));
      }
      return NO_HIGHLIGHT;
    }
    return findQuote(text, quote) ?? NO_HIGHLIGHT;
  }, [text, target.quote, target.pageFrom, cited]);
  const blocks = useMemo(
    () => (markdown ? parseMarkdown(text, { literal }) : null),
    [text, markdown, literal],
  );
  const code = useMemo(() => !markdown && looksLikeCode(text), [text, markdown]);
  const citedHeading = useMemo(() => {
    if (!cited) return null;
    let heading: number | null = null;
    for (const [unit, index] of headingIndexes(units)) {
      if (unit.page <= cited.first.page) heading = index;
    }
    return heading;
  }, [cited, units]);
  const sectionStarts = useMemo(() => {
    const starts = new Map<number, number>();
    for (const [unit, index] of headingIndexes(units)) if (index >= 0) starts.set(unit.page, index);
    return starts;
  }, [units]);
  const mark = quoteMarkOf(target.citation);
  const [markTop, setMarkTop] = useState<number | null>(null);
  const [markRoom, setMarkRoom] = useState(0);

  // A cited page drawn to save it (#133): the cited lines, or the cited sections from the
  // heading the first is under to the one after the last.
  const formatted = blocks !== null && !source;
  const citedArea = useCallback((): CitedArea | null => {
    const element = column.current;
    if (!element || !cited || target.pageFrom === undefined) return null;
    const last = target.pageTo ?? target.pageFrom;
    if (!formatted) {
      const spans = [...element.querySelectorAll("[data-unit]")].filter((span) => {
        const unit = Number(span.getAttribute("data-unit"));
        return unit >= cited.first.page && unit <= last;
      });
      return spans.length > 0 ? spans : null;
    }
    const range = element.ownerDocument.createRange();
    const start =
      citedHeading !== null && citedHeading >= 0
        ? element.querySelector(`[data-heading="${citedHeading}"]`)
        : null;
    if (start) range.setStartBefore(start);
    else range.setStart(element, 0);
    const after = [...sectionStarts].filter(([unit]) => unit > last).sort((a, b) => a[0] - b[0]);
    const next = after[0] && element.querySelector(`[data-heading="${after[0][1]}"]`);
    if (next) range.setEndBefore(next);
    else range.setEnd(element, element.childNodes.length);
    return range;
  }, [formatted, cited, citedHeading, sectionStarts, target.pageFrom, target.pageTo]);
  useCitedArea(true, citedArea);

  // The Citation's mark sits beside the quote's first line, wherever the text wraps it.
  const showMark = mark !== null && highlight.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-placed for each new highlight and mode
  useLayoutEffect(() => {
    const element = column.current;
    if (!element || !showMark) {
      setMarkTop(null);
      return;
    }
    const place = () => {
      const first = element.querySelector("[data-quote-highlight]");
      setMarkTop(first ? markTopFor(first, element) : null);
      setMarkRoom(marginRoom(element));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showMark, highlight, source]);

  // Each open request goes to its quote, else to its cited Unit, else the top; so does
  // switching between the formatted file and its source. Opening the Document again
  // without either leaves the reader where they were.
  useLayoutEffect(() => {
    const container = scroller.current;
    const switched = appliedMode.current !== source;
    if (!container || (appliedRequest.current === target.request && !switched)) return;
    const first = appliedRequest.current === null;
    appliedRequest.current = target.request;
    appliedMode.current = source;
    const quoted = container.querySelector<HTMLElement>("[data-quote-highlight]");
    const unit =
      citedHeading !== null && citedHeading >= 0
        ? container.querySelector(`[data-heading="${citedHeading}"]`)
        : cited
          ? container.querySelector(`[data-unit="${cited.first.page}"]`)
          : null;
    if (quoted) scrollToElement(container, quoted, container.clientHeight / 3);
    else if (unit) scrollToElement(container, unit, 24);
    else if (target.quote || target.pageFrom !== undefined || first || switched) {
      container.scrollTop = 0;
    }
  }, [target.request, target.quote, target.pageFrom, cited, citedHeading, source]);

  const onScroll = () => {
    const container = scroller.current;
    if (!container || !outline) return;
    const top = container.getBoundingClientRect().top + 48;
    let heading: number | null = null;
    for (const element of container.querySelectorAll<HTMLElement>("[data-heading]")) {
      if (element.getBoundingClientRect().top <= top) heading = Number(element.dataset.heading);
    }
    setCurrent(heading);
  };

  return (
    <div className="flex min-h-0 flex-1">
      {outline && (
        <UnitOutline
          entries={outline}
          current={current}
          onGo={(heading) => {
            const container = scroller.current;
            const element = container?.querySelector(`[data-heading="${heading}"]`);
            if (container && element) scrollToElement(container, element, 24);
            setCurrent(heading);
          }}
        />
      )}
      <div
        ref={scroller}
        data-testid="viewer-text"
        data-view={blocks ? (source ? "source" : "formatted") : code ? "code" : "plain"}
        data-quote-tone={quoteTone(target.citation)}
        onScroll={onScroll}
        className="viewer-backdrop viewer-text-backdrop min-h-0 min-w-0 flex-1 overflow-auto select-text"
      >
        <article className="viewer-page viewer-text-page">
          <div ref={column} className="relative">
            {blocks && !source ? (
              <MarkdownBlocks blocks={blocks} source={text} highlight={highlight} />
            ) : (
              <pre className={`document-plain ${blocks || code ? "document-plain--code" : ""}`}>
                <PlainText
                  source={text}
                  units={units}
                  highlight={highlight}
                  headings={blocks ? sectionStarts : null}
                />
              </pre>
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
      </div>
    </div>
  );
}

/** Scrolls `container` so `element` is `offset` pixels below its top. */
function scrollToElement(container: HTMLElement, element: Element, offset: number): void {
  const top =
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop;
  container.scrollTop = Math.max(0, top - offset);
}

/**
 * A file's text as written, each Unit in a span the viewer can scroll to; a
 * Markdown file's sections also carry their heading's index, for the outline.
 */
function PlainText({
  source,
  units,
  highlight,
  headings,
}: {
  source: string;
  units: readonly SourceUnit[];
  highlight: readonly TextRange[];
  headings: ReadonlyMap<number, number> | null;
}) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const unit of units) {
    if (unit.start > at) {
      parts.push(
        <Slice
          key={`gap${at}`}
          source={source}
          start={at}
          end={unit.start}
          highlight={highlight}
        />,
      );
    }
    parts.push(
      <span key={unit.page} data-unit={unit.page} data-heading={headings?.get(unit.page)}>
        <Slice source={source} start={unit.start} end={unit.end} highlight={highlight} />
      </span>,
    );
    at = unit.end;
  }
  parts.push(
    <Slice key={`gap${at}`} source={source} start={at} end={source.length} highlight={highlight} />,
  );
  return <>{parts}</>;
}
