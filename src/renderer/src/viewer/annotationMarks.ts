/**
 * Draws a Document's highlights in its page and puts a small note mark beside
 * each (#327). Views that draw their file as DOM mark it here, through the
 * same matcher a Citation's wash uses; views that draw React text get the
 * ranges (`annotationRangesIn`). The note mark opens its note on hover or
 * focus (`AnnotationNoteLayer`).
 */
import type { Annotation, AnnotationColour } from "../../../core/api";
import { findQuote, type TextRange } from "../../../shared/quoteMatch";
import { markText, textNodes } from "./domQuote";

/** The words of `text` that fall inside a highlight, with the highlight that holds them. */
export interface AnnotationRange extends TextRange {
  id: string;
  colour: AnnotationColour;
  /** Whether the highlight has a note, which its mark opens rather than adds. */
  hasNote: boolean;
}

/** Where each highlight's quote is in `text`, in order; one whose words aren't there is left out. */
export function annotationRangesIn(
  text: string,
  annotations: readonly Annotation[],
): AnnotationRange[] {
  const ranges: AnnotationRange[] = [];
  for (const annotation of annotations) {
    if (annotation.quote.trim() === "") continue;
    for (const range of findQuote(text, annotation.quote) ?? []) {
      ranges.push({
        ...range,
        id: annotation.id,
        colour: annotation.colour,
        hasNote: annotation.note !== null,
      });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** A note's mark, which opens its note on hover or focus: a button, so the keyboard reaches it. */
export function noteMarkElement(
  annotation: Annotation,
  doc: globalThis.Document,
  label: string,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.dataset.annotationNote = annotation.id;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.className = "annotation-note-mark";
  button.dataset.hasNote = annotation.note === null ? "false" : "true";
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-[11px]"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3h8L19 7.5v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5z"/><path d="M14 3v5h5M8.5 12h7M8.5 15.5h5"/></svg>';
  return button;
}

/** Marks each highlight's quote in `root`, a note mark after it; returns where each was marked. */
export function markAnnotationsInDom(
  root: Element,
  annotations: readonly Annotation[],
  labelOf: (annotation: Annotation) => string,
): Map<string, HTMLElement[]> {
  const marked = new Map<string, HTMLElement[]>();
  for (const annotation of annotations) {
    if (annotation.quote.trim() === "") continue;
    const marks = markText(textNodes(root), annotation.quote, {
      className: `annotation-highlight annotation-highlight--${annotation.colour}`,
      data: { annotationId: annotation.id, colour: annotation.colour },
    });
    if (marks && marks.length > 0) marked.set(annotation.id, marks);
  }
  for (const [id, marks] of marked) {
    const last = marks.at(-1);
    const annotation = annotations.find((each) => each.id === id);
    if (!last || !annotation) continue;
    last.after(noteMarkElement(annotation, root.ownerDocument, labelOf(annotation)));
  }
  return marked;
}

/** Takes the highlights and note marks out of `root`, leaving the file's text as it was. */
export function unmarkAnnotationsInDom(root: Element): void {
  for (const button of root.querySelectorAll("[data-annotation-note]")) button.remove();
  for (const mark of root.querySelectorAll("mark[data-annotation-id]")) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}
