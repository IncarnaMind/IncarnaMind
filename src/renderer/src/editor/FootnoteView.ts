import type { NodeViewRenderer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Decoration } from "@tiptap/pm/view";
import { BLOCK_ID_ATTRIBUTE } from "../../../core/api";
import { footnoteNumberOf } from "./citationNumbers";
import { footnoteText, openFootnote } from "./footnoteSchema";
import { noteMarker } from "./noteLabels";

/** How a footnote's marker is named to the User: its number as it shows, and the start of its text. */
export type FootnoteLabel = (shown: string, text: string, endnote: boolean) => string;

/** A footnote's text as its marker's tooltip shows it: one line, cut short. */
const preview = (node: ProseMirrorNode) => {
  const text = footnoteText(node).replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/**
 * A footnote's marker in the text: its number, raised, as in print. It shares
 * its numbering with the Citations' markers (see `CitationNumbers`), which
 * gives it the number. Clicking it opens its text at the marker
 * (`FootnotePopover`); by keyboard, the arrows select it and Enter opens it
 * (`FootnoteKeys`). Its text isn't drawn here: the editor treats it as one
 * thing, and it is edited in the popover or the footnote area.
 *
 * A plain view, not a React one: a React view of a node with content would
 * draw the content too.
 */
export function footnoteView(label: () => FootnoteLabel): NodeViewRenderer {
  return ({ node: initial, decorations: initialDecorations, editor }) => {
    let node = initial;
    let number = footnoteNumberOf(initialDecorations as readonly Decoration[]);
    const dom = document.createElement("sup");
    dom.className = "footnote";
    dom.contentEditable = "false";
    dom.dataset.testid = "footnote";
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "footnote-marker";
    marker.dataset.testid = "footnote-marker";
    // Keep the editor's selection and focus where they are until the popover takes it.
    marker.addEventListener("mousedown", (event) => event.preventDefault());
    marker.addEventListener("click", () => {
      const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
      if (typeof id === "string") openFootnote(editor, id);
    });
    dom.append(marker);

    const draw = () => {
      const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
      if (typeof id === "string") dom.dataset.footnoteId = id;
      dom.dataset.number = String(number);
      const endnote = node.attrs.endnote === true;
      dom.classList.toggle("footnote--endnote", endnote);
      const shown = noteMarker(editor, number, endnote);
      marker.textContent = shown;
      const name = label()(shown, preview(node), endnote);
      marker.setAttribute("aria-label", name);
      marker.title = name;
    };
    draw();

    return {
      dom,
      update(next: ProseMirrorNode, nextDecorations: readonly Decoration[]) {
        if (next.type !== node.type) return false;
        node = next;
        number = footnoteNumberOf(nextDecorations);
        draw();
        return true;
      },
      // The marker's clicks are its own: the editor doesn't select the node under them.
      stopEvent: (event: Event) => event.target instanceof Node && marker.contains(event.target),
      ignoreMutation: () => true,
    };
  };
}
