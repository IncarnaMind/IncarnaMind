import { renderAsync } from "docx-preview";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Document } from "../../../core/api";
import { type DocxResult, extractDocx } from "../../../core/documents/formats/docx";
import { ProblemMark } from "../components/ProblemLine";
import { useT } from "../i18n";
import type { ViewerTarget } from "../store";
import { useCitedArea, useCitedAreaFailure } from "./citedArea";
import {
  type DocxComment,
  fixSymbols,
  NOTE_GAP,
  NOTE_WIDTH,
  placeComments,
  takeComments,
} from "./docxPages";
import { markQuote, textNodes, unmarkQuote } from "./domQuote";
import { FileStates } from "./FileStates";
import "./officeFonts.css";
import { CitationMark, quoteMarkOf, quoteTone } from "./quoteMark";
import { domSelection, useSelectionReader } from "./selectedText";
import { OutlineButton, type OutlineEntry, UnitOutline } from "./UnitOutline";
import { useDocumentFile } from "./useDocumentFile";
import { ViewerHeader } from "./ViewerHeader";
import { confirmDrawn, type DrawnTarget, drawnTargetOf } from "./wordPlaces";

// A footnote's number, set as a superscript in the text, isn't in the text a quote is checked against.
function withoutFootnoteNumbers<T>(body: HTMLElement, read: () => T): T {
  const numbers = [...body.querySelectorAll<HTMLElement>("sup")].filter((sup) =>
    /^\s*\d{1,3}\s*$/.test(sup.textContent ?? ""),
  );
  for (const sup of numbers) sup.dataset.quoteSkip = "";
  try {
    return read();
  } finally {
    for (const sup of numbers) delete sup.dataset.quoteSkip;
  }
}

/** docx-preview's class prefix: a paragraph in style "Heading2" is `p.docx_heading2`. */
const CLASS_NAME = "docx";

/** A style id as docx-preview turns it into a class name. */
const styleClass = (id: string) =>
  `${CLASS_NAME}_${id.replace(/[ .]+/g, "-").replace(/[&]+/g, "and").toLowerCase()}`;

/** Space around the pages, and between a quote's line and its mark, in CSS pixels. */
const PADDING = 24;
const MARK_GAP = 12;
/** Room the mark, without its label, keeps from the page's right edge. */
const MARK_ROOM = 40;
/** The gap a mark keeps from a comment's note in the margin. */
const NOTE_MARK_GAP = 4;

interface Loaded {
  bytes: Uint8Array;
  docx: DocxResult;
}

/**
 * The zoom that fits the drawn pages to the width there is beside the
 * outline, if it is open, never larger than they are; with the comments'
 * margin beside them, if they have comments, as Word shows it.
 */
function fitZoom(outer: HTMLElement | null, body: HTMLElement, notes: boolean): number {
  const page = body.querySelector<HTMLElement>(`section.${CLASS_NAME}`);
  if (!outer || !page || page.offsetWidth === 0) return 1;
  const width = page.offsetWidth + (notes ? NOTE_GAP + NOTE_WIDTH : 0);
  return Math.min(1, Math.max(0.05, (outer.clientWidth - 2 * PADDING) / width));
}

const read = async (bytes: Uint8Array): Promise<Loaded> => ({
  bytes,
  docx: await extractDocx(bytes),
});

/**
 * A Word Document (ADR-0011): drawn page-like by docx-preview (Apache-2.0),
 * its pages split only where the file breaks them, so they are not Word's
 * pages: a Citation points at the section a quote sits under, which the
 * outline lists. Opened at a Citation, it goes to the cited section and
 * highlights the quote in it, else in a comment anchored there, in its note
 * in the margin (#76), with the Citation's
 * mark in the page's margin beside it. Images come as
 * `data:` URLs, so the app's Content-Security-Policy stays as it is.
 */
export function DocxView({ document, target }: { document: Document; target: ViewerTarget }) {
  const { loaded, reload } = useDocumentFile(document.id, document.contentHash, read);
  return (
    <FileStates
      document={document}
      loaded={loaded}
      quote={target.quote}
      reload={reload}
      ready={(value) => <DocxPages loaded={value} target={target} />}
    />
  );
}

/**
 * The drawn paragraph or table at a place in a Word file ("w:p#12"), found by its place
 * among those drawn and confirmed by its text (`drawnTargetOf`, `confirmDrawn`):
 * docx-preview draws each in order in the pages' articles, headers and footers apart.
 */
function drawnAt(body: HTMLElement, place: string, target: DrawnTarget): HTMLElement | null {
  const tag = place.startsWith("w:tbl#") ? "table" : "p";
  const drawn = [...body.querySelectorAll<HTMLElement>(`section.${CLASS_NAME} > article ${tag}`)];
  const index = confirmDrawn(
    drawn.map((each) => each.textContent ?? ""),
    target,
  );
  return index === null ? null : (drawn[index] ?? null);
}

interface MarkPlace {
  top: number;
  left: number;
  /** The page's margin past the text, which the mark's label must fit in. */
  room: number;
}

function DocxPages({ loaded, target }: { loaded: Loaded; target: ViewerTarget }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const styles = useRef<HTMLDivElement>(null);
  // A comment's note in the margin is read alone; its text isn't the page's.
  useSelectionReader(
    useCallback((range) => {
      const body = host.current;
      if (!body) return { parts: [] };
      const at = range.commonAncestorContainer;
      const note = (at instanceof Element ? at : at.parentElement)?.closest(".docx-note");
      return withoutFootnoteNumbers(body, () => domSelection(range, note ?? body));
    }, []),
  );
  const [rendered, setRendered] = useState<"no" | "yes" | "failed">("no");
  const [failure, setFailure] = useState("");
  const [zoom, setZoom] = useState(1);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [marks, setMarks] = useState<HTMLElement[]>([]);
  const [place, setPlace] = useState<MarkPlace | null>(null);
  const mark = useMemo(() => quoteMarkOf(target.citation), [target.citation]);
  const comments = useRef<DocxComment[]>([]);
  const t = useT();
  const { docx } = loaded;
  // Where the paragraph a Mind's caret was in is among those drawn (#736).
  const [placed, setPlaced] = useState<{ place: string; target: DrawnTarget | null } | null>(null);
  useEffect(() => {
    const place = target.wordPlace;
    if (!place) return;
    let current = true;
    drawnTargetOf(loaded.bytes, place).then(
      (drawn) => {
        if (current) setPlaced({ place, target: drawn });
      },
      (error: unknown) => console.error("viewer.docx.wordPlace", error),
    );
    return () => {
      current = false;
    };
  }, [loaded.bytes, target.wordPlace]);

  // Draw the pages once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawn again only for new bytes
  useEffect(() => {
    const body = host.current;
    const style = styles.current;
    if (!body || !style) return;
    let cancelled = false;
    renderAsync(loaded.bytes, body, style, {
      className: CLASS_NAME,
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      experimental: true,
      // Everything Word puts on its pages: headers, footers, footnotes and endnotes.
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      // Images and fonts as data: URLs: the app's policy allows those, not blob: ones.
      useBase64URL: true,
      renderChanges: false,
      // Comments become notes in the margin (takeComments); their text stays highlighted.
      renderComments: true,
      renderAltChunks: false,
      trimXmlDeclaration: true,
    }).then(
      () => {
        if (cancelled) return;
        // Links open in the User's browser (the main process sends new windows there).
        for (const link of body.querySelectorAll<HTMLAnchorElement>("a[href]")) {
          if (/^(?:https?:|mailto:)/i.test(link.href)) {
            link.target = "_blank";
            link.rel = "noreferrer";
          } else link.removeAttribute("href");
        }
        fixSymbols(style, body);
        comments.current = takeComments(body, CLASS_NAME, (author) =>
          t("viewer.docx.comment", { author }),
        );
        body.classList.toggle("docx-view--notes", comments.current.length > 0);
        // Fitted before anything is placed or scrolled to.
        setZoom(fitZoom(scroller.current, body, comments.current.length > 0));
        setRendered("yes");
      },
      (error: unknown) => {
        if (cancelled) return;
        setFailure(error instanceof Error ? error.message : String(error));
        setRendered("failed");
      },
    );
    return () => {
      cancelled = true;
      comments.current = [];
      body.replaceChildren();
      style.replaceChildren();
      // docx-preview names the comments' highlight for the whole page.
      globalThis.CSS?.highlights?.delete(`${CLASS_NAME}-comments`);
    };
  }, [loaded.bytes]);

  // The comments' notes, beside the pages, placed again as the pages zoom.
  useLayoutEffect(() => {
    const wrapper = host.current?.querySelector<HTMLElement>(`.${CLASS_NAME}-wrapper`);
    if (!wrapper || rendered !== "yes" || comments.current.length === 0) return;
    placeComments(wrapper, comments.current, zoom);
  }, [rendered, zoom]);

  /** The heading elements docx-preview drew, in order: those with text, as the outline lists them. */
  const headingElements = useCallback((): HTMLElement[] => {
    const body = host.current;
    if (!body || docx.headingStyles.length === 0) return [];
    const selector = docx.headingStyles.map((id) => `p.${CSS.escape(styleClass(id))}`).join(",");
    return [...body.querySelectorAll<HTMLElement>(selector)].filter(
      (element) => (element.textContent ?? "").trim() !== "",
    );
  }, [docx]);

  // The pages keep fitting the viewer's width as it is resized.
  useLayoutEffect(() => {
    const outer = scroller.current;
    const body = host.current;
    if (!outer || !body || rendered !== "yes") return;
    const observer = new ResizeObserver(() =>
      setZoom(fitZoom(outer, body, comments.current.length > 0)),
    );
    observer.observe(outer);
    return () => observer.disconnect();
  }, [rendered]);

  /**
   * The cited section, as a range of the drawn document, from its heading to
   * the next one, with its heading (null for the text before any heading).
   */
  const citedSection = useCallback((): { range: Range; heading: HTMLElement | null } | null => {
    const body = host.current;
    const unit = target.pageFrom;
    if (!body || unit === undefined) return null;
    const headings = headingElements();
    if (headings.length !== docx.headings.length) return null; // drawn otherwise than read
    const cited = docx.units.find((each) => each.page === unit);
    if (!cited || cited.label?.notes) return null;
    // The heading the cited Unit is under, and the one after the Units cited.
    const last = target.pageTo ?? unit;
    let start = -1;
    let end = -1;
    docx.headings.forEach((heading, index) => {
      if (heading.unit <= unit) start = index;
      if (end < 0 && heading.unit > last) end = index;
    });
    const range = body.ownerDocument.createRange();
    const heading = headings[start] ?? null;
    if (heading) range.setStartBefore(heading);
    else range.setStart(body, 0);
    const next = headings[end];
    if (next) range.setEndBefore(next);
    else range.setEnd(body, body.childNodes.length);
    return { range, heading };
  }, [docx, headingElements, target.pageFrom, target.pageTo]);

  // A cited page drawn to save it (#133): the cited section.
  const citedArea = useCallback(() => citedSection()?.range ?? null, [citedSection]);
  useCitedArea(rendered === "yes", citedArea);
  useCitedAreaFailure(rendered === "failed" ? failure : null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each open request goes there again
  useEffect(() => {
    const body = host.current;
    if (!body || rendered !== "yes") return;
    unmarkQuote(body);
    for (const comment of comments.current) unmarkQuote(comment.note);
    const quote = target.quote;
    const section = citedSection();
    let found: HTMLElement[] | null = null;
    if (quote) {
      const inNotes = (list: readonly DocxComment[]) => {
        for (const comment of list) {
          const marked = markQuote(textNodes(comment.note), quote);
          if (marked) return marked;
        }
        return null;
      };
      const anchoredInSection = section
        ? comments.current.filter((comment) => section.range.intersectsNode(comment.anchor))
        : [];
      const find = () =>
        target.pageFrom === undefined
          ? (markQuote(textNodes(body), quote) ?? inNotes(comments.current))
          : ((section && markQuote(textNodes(body, section.range), quote)) ??
            inNotes(anchoredInSection));
      found = find();
      if (!found) found = withoutFootnoteNumbers(body, find);
    }
    setMarks(found ?? []);
    if (section?.heading) setCurrent(headingElements().indexOf(section.heading));
    // Go to the quote, or else to the cited section, or the paragraph a Mind's caret is in
    // (#736), or the top.
    const container = scroller.current;
    if (!container) return;
    const at =
      placed && placed.place === target.wordPlace && placed.target
        ? drawnAt(body, placed.place, placed.target)
        : null;
    const anchor = found?.[0] ?? section?.heading ?? at;
    if (anchor) {
      const top =
        anchor.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      const above = found || anchor === at ? container.clientHeight / 3 : PADDING;
      container.scrollTop = Math.max(0, top - above);
    } else container.scrollTop = 0;
  }, [rendered, citedSection, target.request, target.quote, target.wordPlace, placed]);

  // The Citation's mark: in the page's right margin, level with the quote's first line; for a
  // quote in a comment's note, in the margin between the page's text and the note (#76).
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again when the pages zoom
  useLayoutEffect(() => {
    const first = marks[0];
    const box = content.current;
    if (!mark || !first || !box) {
      setPlace(null);
      return;
    }
    const placeMark = () => {
      const origin = box.getBoundingClientRect();
      const line = first.getClientRects()[0] ?? first.getBoundingClientRect();
      const note = first.closest<HTMLElement>(".docx-note");
      if (note) {
        const limit = note.getBoundingClientRect().left - NOTE_MARK_GAP;
        const commented = comments.current.find((comment) => comment.note === note);
        const page = commented?.anchor.closest(`section.${CLASS_NAME}`);
        const text = (page?.querySelector(":scope > article") ?? page)?.getBoundingClientRect();
        const left = Math.min((text?.right ?? limit) + MARK_GAP, limit - MARK_ROOM);
        setPlace({
          top: line.top - origin.top + line.height / 2 - 9,
          left: left - origin.left,
          room: limit - left,
        });
        return;
      }
      const page = first.closest(`section.${CLASS_NAME}`)?.getBoundingClientRect();
      const paragraph = first.closest("p, td, li")?.getBoundingClientRect() ?? line;
      const pageRight = page?.right ?? paragraph.right + MARK_GAP + MARK_ROOM;
      setPlace({
        top: line.top - origin.top + line.height / 2 - 9,
        left: Math.min(paragraph.right + MARK_GAP, pageRight - MARK_ROOM) - origin.left,
        room: pageRight - paragraph.right - MARK_GAP - 6,
      });
    };
    placeMark();
    const observer = new ResizeObserver(placeMark);
    observer.observe(box);
    return () => observer.disconnect();
  }, [marks, mark, zoom]);

  // The outline's entry for the section in view.
  const onScroll = () => {
    const container = scroller.current;
    if (!container || !outlineOpen) return;
    const top = container.getBoundingClientRect().top + 48;
    let index: number | null = null;
    headingElements().forEach((element, at) => {
      if (element.getBoundingClientRect().top <= top) index = at;
    });
    setCurrent(index);
  };

  const outline: OutlineEntry[] = useMemo(
    () =>
      docx.headings.map((heading, index) => ({
        key: index,
        title: heading.text,
        depth: Math.min(heading.level - 1, 3),
      })),
    [docx],
  );
  const goTo = (index: number) => {
    const container = scroller.current;
    const element = headingElements()[index];
    if (!container || !element) return;
    container.scrollTop =
      element.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      PADDING;
    setCurrent(index);
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
          data-testid="viewer-docx"
          data-rendered={rendered}
          data-quote-tone={quoteTone(target.citation)}
          onScroll={onScroll}
          className="viewer-backdrop relative min-w-0 flex-1 overflow-auto"
        >
          {rendered === "failed" && (
            <p role="alert" className="px-6 py-8 text-center text-ui text-ink">
              <ProblemMark />
              {failure}
            </p>
          )}
          <div ref={content} className="relative">
            <div ref={styles} />
            <div ref={host} className="docx-view" style={{ zoom }} />
            {mark && place && (
              <CitationMark
                mark={mark}
                room={place.room}
                style={{ top: place.top, left: place.left }}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
