/**
 * What the User selected in a viewer, as the core cites it (`citeSelection`,
 * #101). On a PDF, a part for each page: the words of its text layer as the
 * page's stored text has them (pdf.js's runs, a line break at each `<br>` it
 * puts after a line), and how many of the page's lines with text come before
 * and after them. In a view that draws its text as DOM, the words with those
 * around them; in a text or Markdown file, the file's own characters.
 */
import { createContext, useContext, useEffect } from "react";
import type { SelectedPart } from "../../../core/api";
import type { SourceUnit } from "../../../core/documents/formats/text";
import { piecesOf, textNodes } from "./domQuote";

/** What a view reads of a selection: the parts the core cites, and the words as shown where the view draws its file's markup. */
export interface ReadSelection {
  parts: SelectedPart[];
  shown?: string;
}

/** How a view reads what is selected in it (`pdfSelection`, `domSelection`), for its tab's selection menu. */
export type SelectionReader = (range: Range) => ReadSelection;

export const SelectionReaderContext = createContext<(reader: SelectionReader | null) => void>(
  () => undefined,
);

/** Lends the view's reader to its tab's selection menu while the view is there. */
export function useSelectionReader(reader: SelectionReader): void {
  const lend = useContext(SelectionReaderContext);
  useEffect(() => {
    lend(reader);
    return () => lend(null);
  }, [lend, reader]);
}

const linesWithText = (lines: readonly string[]) =>
  lines.filter((line) => line.trim() !== "").length;

function pagePart(layer: Element, range: Range, unit: number): SelectedPart | null {
  let text = "";
  let start = -1;
  let end = -1;
  const walker = layer.ownerDocument.createTreeWalker(
    layer,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeName === "BR") {
      text += "\n";
      continue;
    }
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const data = (node as Text).data;
    if (range.intersectsNode(node)) {
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : data.length;
      if (from < to) {
        if (start < 0) start = text.length + from;
        end = text.length + to;
      }
    }
    text += data;
  }
  if (start < 0) return null;
  return {
    unit,
    text: text.slice(start, end),
    // The line the selection starts in, and the one it ends in, are its own.
    linesBefore: linesWithText(text.slice(0, start).split("\n").slice(0, -1)),
    linesAfter: linesWithText(text.slice(end).split("\n").slice(1)),
  };
}

/** The parts of `range` on a PDF's pages, drawn in `root`, in order; none if it holds no text there. */
export function pdfSelection(range: Range, root: Element): ReadSelection {
  const parts: SelectedPart[] = [];
  for (const page of root.querySelectorAll<HTMLElement>("section[data-page-number]")) {
    const layer = page.querySelector(".textLayer");
    if (!layer || !range.intersectsNode(layer)) continue;
    const part = pagePart(layer, range, Number(page.dataset.pageNumber));
    if (part && part.text.trim() !== "") parts.push(part);
  }
  return { parts };
}

const AROUND = 80;

function clipOf(node: Text, range: Range): [number, number] | null {
  if (!range.intersectsNode(node)) return null;
  const from = node === range.startContainer ? range.startOffset : 0;
  const to = node === range.endContainer ? range.endOffset : node.data.length;
  return from < to ? [from, to] : null;
}

function partsOf(
  text: string,
  spans: readonly { unit: number | null; start: number; end: number }[],
): SelectedPart[] {
  const parts: SelectedPart[] = spans
    .map(({ unit, start, end }) => ({ unit, text: text.slice(start, end) }))
    .filter((part) => part.text.trim() !== "");
  const first = parts[0];
  const last = parts.at(-1);
  const start = spans[0]?.start ?? 0;
  const end = spans.at(-1)?.end ?? 0;
  if (first) first.before = text.slice(Math.max(0, start - AROUND), start);
  if (last) last.after = text.slice(end, end + AROUND);
  return parts;
}

/**
 * The parts of `range` in a view that draws a Document's text as DOM (Word,
 * slides, web pages): its text nodes under `root`, but those marked
 * `data-quote-skip`, a line break between blocks; a part for each Unit
 * `unitOf` names, or one where it names none.
 */
export function domSelection(
  range: Range,
  root: Element,
  unitOf: (node: Node) => number | null = () => null,
): ReadSelection {
  const nodes = textNodes(root);
  const pieces = piecesOf(nodes);
  const spans: { unit: number | null; start: number; end: number }[] = [];
  let text = "";
  nodes.forEach((node, index) => {
    const clip = clipOf(node, range);
    if (clip) {
      const unit = unitOf(node);
      const last = spans.at(-1);
      if (last && last.unit === unit) last.end = text.length + clip[1];
      else spans.push({ unit, start: text.length + clip[0], end: text.length + clip[1] });
    }
    text += node.data + (pieces[index]?.breakAfter ? "\n" : "");
  });
  return { parts: partsOf(text, spans) };
}

/**
 * The parts of `range` in a text or Markdown file drawn from its `source`,
 * each piece of it marked with where it starts there (`data-at`): the file's
 * own characters, markup included, a part for each of its `units`; and the
 * words as shown.
 */
export function sourceSelection(
  range: Range,
  root: Element,
  source: string,
  units: readonly SourceUnit[],
): ReadSelection {
  let start = -1;
  let end = -1;
  const read = new Map<Element, number>();
  for (const node of textNodes(root)) {
    const piece = node.parentElement?.closest<HTMLElement>("[data-at]");
    if (!piece) continue;
    const before = read.get(piece) ?? 0;
    read.set(piece, before + node.data.length);
    const clip = clipOf(node, range);
    if (!clip) continue;
    const at = Number(piece.dataset.at) + before;
    if (start < 0) start = at + clip[0];
    end = at + clip[1];
  }
  const spans = units.flatMap((unit) => {
    const from = Math.max(start, unit.start);
    const to = Math.min(end, unit.end);
    return start >= 0 && from < to ? [{ unit: unit.page, start: from, end: to }] : [];
  });
  return { parts: partsOf(source, spans), shown: shownIn(range, root) };
}

// As the view shows the words, a line break between two blocks, as `domSelection` reads them.
function shownIn(range: Range, root: Element): string {
  const nodes = textNodes(root);
  const pieces = piecesOf(nodes);
  let shown = "";
  let broken = false;
  nodes.forEach((node, index) => {
    const clip = clipOf(node, range);
    if (!clip) return;
    shown += `${broken && shown !== "" ? "\n" : ""}${node.data.slice(clip[0], clip[1])}`;
    broken = pieces[index]?.breakAfter === true;
  });
  return shown;
}

/** Where the selection ends on screen, for its menu: its last line's end. */
export function selectionEnd(range: Range): DOMRect {
  const lines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  const last = lines.at(-1) ?? range.getBoundingClientRect();
  return new DOMRect(last.right, last.top, 0, last.height);
}
