import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Document } from "../../../core/api";
import { readWebPage, type WebPage } from "../../../core/documents/formats/web";
import type { XmlNode } from "../../../core/documents/formats/xml";
import { documentImageUrl } from "../../../shared/documentViewer";
import type { MessageKey } from "../../../shared/i18n";
import { useLanguage, useT } from "../i18n";
import type { ViewerTarget } from "../store";
import { pageDate } from "../webPages";
import { useCitedArea } from "./citedArea";
import { loadDocumentPicture } from "./documentPicture";
import { markQuote, textNodes, unmarkQuote } from "./domQuote";
import { FileStates } from "./FileStates";
import { PdfView } from "./PdfView";
import { CitationMark, marginRoom, markTopFor, quoteMarkOf, quoteTone } from "./quoteMark";
import { domSelection, useSelectionReader } from "./selectedText";
import { OutlineButton, type OutlineEntry, UnitOutline } from "./UnitOutline";
import { useDocumentFile } from "./useDocumentFile";
import { ViewerHeader } from "./ViewerHeader";
import { WebLookBar, WebLookLine } from "./WebLook";

const read = (bytes: Uint8Array): WebPage => readWebPage(new TextDecoder().decode(bytes));

/** Any other element is drawn as its content alone. */
const DRAWN = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "hr",
  "br",
  "strong",
  "em",
  "code",
  "sub",
  "sup",
  "s",
  "mark",
]);

const count = (value: string | undefined, below = 1000) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < below ? String(number) : null;
};

/** A picture the page shows from its own saved files (#756): "pictures/<hash>.png". */
const SAVED_PICTURE = /^pictures\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|avif)$/;

/** Where a snapshot is drawn: its Document, and what stops its pictures' loading. */
interface DrawContext {
  documentId: string;
  signal: AbortSignal;
  t: (key: MessageKey) => string;
  /** Pictures shown so far, numbered as the page shows them. */
  pictures: number;
}

/** The page the viewer draws into (the name `Document` is the Library's). */
type Page = HTMLElement["ownerDocument"];

/** A labelled box for a picture that isn't shown: its description, and why. */
function placeholder(owner: Page, alt: string, note: string, t: DrawContext["t"]): HTMLElement {
  const element = owner.createElement("span");
  element.className = "document-image-placeholder";
  element.dataset.quoteSkip = "";
  const label = owner.createElement("span");
  label.className = "document-image-placeholder-label";
  label.textContent = alt || t("viewer.markdown.image");
  const why = owner.createElement("span");
  why.className = "document-image-placeholder-note";
  why.textContent = note;
  element.append(label, why);
  return element;
}

/**
 * A picture saved with the page, read from its file once drawn; a box of its
 * size meanwhile, so the page doesn't move as it comes in.
 */
function savedPicture(
  owner: Page,
  src: string,
  alt: string,
  size: { width: string | null; height: string | null },
  context: DrawContext,
): HTMLElement {
  const picture = owner.createElement("img");
  picture.alt = alt;
  picture.className = "document-image document-web-picture";
  picture.dataset.quoteSkip = "";
  picture.dataset.testid = "web-picture";
  context.pictures += 1;
  picture.dataset.figure = String(context.pictures);
  if (size.width && size.height) {
    picture.style.aspectRatio = `${size.width} / ${size.height}`;
    picture.style.width = `min(100%, ${size.width}px)`;
  }
  loadDocumentPicture(context.documentId, src, context.signal).then(
    (url) => {
      if (!context.signal.aborted) picture.src = url;
    },
    () => {
      if (context.signal.aborted) return;
      picture.replaceWith(
        placeholder(owner, alt, context.t("viewer.markdown.imageMissing"), context.t),
      );
    },
  );
  return picture;
}

/**
 * Draws a snapshot's article with DOM calls, never as markup: only the
 * elements in `DRAWN`, links to web addresses (which open in the browser),
 * the pictures saved with the page, from its own files, and a placeholder
 * for each picture that wasn't saved, which isn't fetched.
 */
function draw(
  nodes: readonly XmlNode[],
  parent: HTMLElement,
  blocks: ReadonlyMap<XmlNode, number>,
  context: DrawContext,
): void {
  const owner = parent.ownerDocument;
  for (const node of nodes) {
    if (typeof node === "string") {
      parent.append(owner.createTextNode(node));
      continue;
    }
    const name = node.name.toLowerCase();
    let element: HTMLElement | null = null;
    let inner: HTMLElement | null = null;
    if (name === "img") {
      const alt = node.attrs.alt?.trim() ?? "";
      const src = node.attrs.src ?? "";
      parent.append(
        SAVED_PICTURE.test(src)
          ? savedPicture(
              owner,
              src,
              alt,
              { width: count(node.attrs.width, 20_000), height: count(node.attrs.height, 20_000) },
              context,
            )
          : placeholder(owner, alt, context.t("viewer.web.pictureNotSaved"), context.t),
      );
      continue;
    }
    if (name === "a") {
      const href = node.attrs.href ?? "";
      if (/^https?:\/\//i.test(href)) {
        const link = owner.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noreferrer";
        element = link;
      }
    } else if (name === "table") {
      element = owner.createElement("div");
      element.className = "document-table";
      inner = owner.createElement("table");
      element.append(inner);
    } else if (DRAWN.has(name)) {
      element = owner.createElement(name);
      const start = name === "ol" ? count(node.attrs.start) : null;
      if (start) element.setAttribute("start", start);
      for (const span of name === "td" || name === "th" ? ["colspan", "rowspan"] : []) {
        const value = count(node.attrs[span]);
        if (value) element.setAttribute(span, value);
      }
    }
    const block = blocks.get(node);
    if (element && block !== undefined) element.dataset.block = String(block);
    draw(node.children, inner ?? element ?? parent, blocks, context);
    if (element) parent.append(element);
  }
}

/**
 * Opened at a Citation, the quote is highlighted only in the cited section.
 * A target without a place searches the page. A page kept as it looks can be shown as it looked,
 * in the PDF view, until the User goes back to its text or opens a Citation.
 */
export function WebView({ document, target }: { document: Document; target: ViewerTarget }) {
  const { loaded, reload } = useDocumentFile(document.id, document.contentHash, read);
  const [lookShownFor, setLookShownFor] = useState<number | null>(null);
  const look = document.web?.look;
  if (look?.status === "saved" && lookShownFor === target.request) {
    return (
      <PdfView
        document={document}
        target={{ documentId: document.id, request: target.request }}
        source={documentImageUrl(document.id, look.path)}
        banner={<WebLookBar look={look} onShowText={() => setLookShownFor(null)} />}
      />
    );
  }
  return (
    <FileStates
      document={document}
      loaded={loaded}
      quote={target.quote}
      reload={reload}
      ready={(page) => (
        <WebPageContent
          page={page}
          document={document}
          target={target}
          onShowLook={() => setLookShownFor(target.request)}
        />
      )}
    />
  );
}

function WebPageContent({
  page,
  document,
  target,
  onShowLook,
}: {
  page: WebPage;
  document: Document;
  target: ViewerTarget;
  onShowLook(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  useSelectionReader(
    useCallback((range) => (host.current ? domSelection(range, host.current) : { parts: [] }), []),
  );
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  // Counts the highlights made, none while 0: the mark is placed again for each.
  const [highlighted, setHighlighted] = useState(0);
  const [markTop, setMarkTop] = useState<number | null>(null);
  const [markRoom, setMarkRoom] = useState(0);
  const mark = quoteMarkOf(target.citation);
  const blocks = useMemo(
    () => new Map<XmlNode, number>(page.blocks.map((block, index) => [block.element, index])),
    [page],
  );
  const outline: OutlineEntry[] = useMemo(
    () =>
      page.blocks.flatMap((block, index) =>
        block.level === null
          ? []
          : [{ key: index, title: block.text, depth: Math.min(block.level - 1, 3) }],
      ),
    [page],
  );
  const site = page.meta.siteName ?? document.web?.siteName ?? null;
  const leftOut = document.web?.picturesLeftOut ?? 0;
  const byline = [page.meta.author, page.meta.published && pageDate(page.meta.published, language)]
    .filter(Boolean)
    .join(" · ");

  useLayoutEffect(() => {
    const body = host.current;
    if (!body || !page.article) return;
    const loading = new AbortController();
    draw(page.article.children, body, blocks, {
      documentId: document.id,
      signal: loading.signal,
      t,
      pictures: 0,
    });
    return () => {
      loading.abort();
      body.replaceChildren();
    };
  }, [page, blocks, t, document.id]);

  /** The cited sections' first block, and their range as drawn, to the last one's last block. */
  const citedSections = useCallback((): { first: Element | null; range: Range | null } => {
    const body = host.current;
    if (!body) return { first: null, range: null };
    const cited = page.units.filter(
      (unit) =>
        target.pageFrom !== undefined &&
        unit.page >= target.pageFrom &&
        unit.page <= (target.pageTo ?? target.pageFrom),
    );
    const first = cited[0] && body.querySelector(`[data-block="${cited[0].blocks.first}"]`);
    const last = cited.at(-1) && body.querySelector(`[data-block="${cited.at(-1)?.blocks.last}"]`);
    if (!first || !last) return { first: first ?? null, range: null };
    const range = body.ownerDocument.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    return { first, range };
  }, [page, target.pageFrom, target.pageTo]);
  // A cited page drawn to save it (#133): the cited sections.
  const citedArea = useCallback(() => citedSections().range, [citedSections]);
  useCitedArea(true, citedArea);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each open request goes there again, and so does a page drawn again in another language
  useLayoutEffect(() => {
    const body = host.current;
    const container = scroller.current;
    if (!body || !container) return;
    unmarkQuote(body);
    for (const cited of body.querySelectorAll<HTMLElement>("[data-cited]")) {
      delete cited.dataset.cited;
    }
    const { first, range } = citedSections();
    const quote = target.quote;
    // A picture's quote is its text read, which the page doesn't show: the picture is outlined.
    const picture = target.figure
      ? body.querySelector<HTMLElement>(`[data-figure="${target.figure}"]`)
      : null;
    if (picture) picture.dataset.cited = "";
    const marks =
      quote && !picture
        ? target.pageFrom === undefined
          ? markQuote(textNodes(body), quote)
          : range && markQuote(textNodes(body, range), quote)
        : null;
    setHighlighted((count) => (marks ? count + 1 : 0));
    const anchor = marks?.[0] ?? picture ?? first ?? null;
    const top = anchor
      ? anchor.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop
      : 0;
    container.scrollTop = Math.max(0, top - (marks ? container.clientHeight / 3 : 24));
  }, [page, t, target.request, target.quote, target.pageFrom, target.pageTo, target.figure]);

  useLayoutEffect(() => {
    const element = column.current;
    if (!element || !mark || highlighted === 0) {
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
  }, [mark, highlighted]);

  const goTo = (key: number) => {
    const container = scroller.current;
    const element = host.current?.querySelector(`[data-block="${key}"]`);
    if (!container || !element) return;
    container.scrollTop =
      element.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      24;
    setCurrent(key);
  };

  const onScroll = () => {
    const container = scroller.current;
    if (!container || !outlineOpen) return;
    const top = container.getBoundingClientRect().top + 48;
    let heading: number | null = null;
    for (const entry of outline) {
      const element = host.current?.querySelector(`[data-block="${entry.key}"]`);
      if (element && element.getBoundingClientRect().top <= top) heading = entry.key;
    }
    setCurrent(heading);
  };

  return (
    <>
      <ViewerHeader
        leading={
          outline.length > 0 && (
            <OutlineButton open={outlineOpen} onToggle={() => setOutlineOpen((open) => !open)} />
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        {outlineOpen && <UnitOutline entries={outline} current={current} onGo={goTo} />}
        <div
          ref={scroller}
          data-testid="viewer-web"
          data-quote-tone={quoteTone(target.citation)}
          onScroll={onScroll}
          className="viewer-backdrop viewer-text-backdrop min-h-0 min-w-0 flex-1 overflow-auto select-text"
        >
          <article className="viewer-page viewer-text-page" lang={page.meta.language ?? undefined}>
            <div ref={column} className="relative">
              <header data-quote-skip="" className="document-web-header">
                {site && <p className="document-web-site">{site}</p>}
                <h1 data-testid="viewer-web-title" className="document-web-title">
                  {page.meta.title ?? document.name}
                </h1>
                {byline && <p className="document-web-byline">{byline}</p>}
                <WebLookLine document={document} onShow={onShowLook} />
                {leftOut > 0 && (
                  <p data-testid="viewer-web-left-out" className="document-web-byline">
                    {t(
                      leftOut === 1
                        ? "viewer.web.picturesLeftOut.one"
                        : "viewer.web.picturesLeftOut",
                      {
                        count: leftOut,
                      },
                    )}
                  </p>
                )}
              </header>
              <div ref={host} data-testid="viewer-web-article" className="document-markdown" />
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
    </>
  );
}
