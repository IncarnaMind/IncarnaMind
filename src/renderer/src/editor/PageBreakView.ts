import type { NodeViewRenderer } from "@tiptap/core";
import { translateNow } from "../i18n";

const NAMES = {
  pageBreak: "wordAtom.kind.pageBreak",
  sectionBreak: "wordAtom.kind.sectionBreak",
} as const;

type BreakKind = keyof typeof NAMES;

const isBreakKind = (value: string | undefined): value is BreakKind =>
  value === "pageBreak" || value === "sectionBreak";

/**
 * Draws a break as a faint line across the text with what it is in
 * `ink-meta` (DESIGN.md, the Word look): a page break, or a Word file's
 * section break. Its name is drawn, not text, so selecting and copying the
 * line around it never picks it up.
 */
export function drawBreak(dom: HTMLElement, kind: BreakKind): void {
  dom.className = "page-break";
  dom.contentEditable = "false";
  dom.setAttribute("role", "separator");
  const text = document.createElement("span");
  text.className = "page-break-label";
  dom.replaceChildren(text);
  nameBreak(dom, kind);
}

function nameBreak(dom: HTMLElement, kind: BreakKind): void {
  const label = translateNow(NAMES[kind]);
  dom.dataset.break = kind;
  dom.setAttribute("aria-label", label);
  dom.title = label;
  const text = dom.querySelector<HTMLElement>(".page-break-label");
  if (text) text.dataset.label = label;
}

/** Names every break drawn in `root` anew, in the interface's language now. */
export function relabelBreaks(root: HTMLElement): void {
  for (const dom of root.querySelectorAll<HTMLElement>(".page-break")) {
    const kind = dom.dataset.break;
    if (isBreakKind(kind)) nameBreak(dom, kind);
  }
}

/** A page break in the text (`PageBreak`). */
export const pageBreakView: NodeViewRenderer = ({ node: initial }) => {
  const dom = document.createElement("span");
  dom.dataset.testid = "page-break";
  drawBreak(dom, "pageBreak");
  return {
    dom,
    update: (next) => next.type === initial.type,
    ignoreMutation: () => true,
  };
};
