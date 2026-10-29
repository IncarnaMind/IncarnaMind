import type { NodeViewRenderer } from "@tiptap/core";
import type { MessageKey } from "../../../shared/i18n";
import { translateNow } from "../i18n";

/**
 * Draws a break as a faint line across the text with what it is in
 * `ink-meta` (DESIGN.md, the Word look): a page break, or a Word file's
 * section break. In the line, as a box is: beside a block of its own,
 * ProseMirror's cursor marks would leave a gap.
 */
export function drawBreak(dom: HTMLElement, name: MessageKey): void {
  const label = translateNow(name);
  dom.className = "page-break";
  dom.contentEditable = "false";
  dom.setAttribute("role", "separator");
  dom.setAttribute("aria-label", label);
  dom.title = label;
  const text = document.createElement("span");
  text.className = "page-break-label";
  text.textContent = label;
  dom.replaceChildren(text);
}

/** A page break in the text (`PageBreak`). */
export const pageBreakView: NodeViewRenderer = ({ node: initial }) => {
  const dom = document.createElement("span");
  dom.dataset.testid = "page-break";
  drawBreak(dom, "wordAtom.kind.pageBreak");
  return {
    dom,
    update: (next) => next.type === initial.type,
    ignoreMutation: () => true,
  };
};
