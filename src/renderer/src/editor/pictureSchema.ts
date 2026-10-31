import { mergeAttributes, Node, type NodeViewRenderer } from "@tiptap/core";
import { PICTURE_NODE } from "../../../core/api";

export interface PictureOptions {
  /** Draws the picture, with the alt text the User writes for it. */
  view: NodeViewRenderer | null;
}

const number = (name: string) => ({
  default: null,
  parseHTML: (element: HTMLElement) => {
    const value = Number(element.getAttribute(name));
    return Number.isFinite(value) && value > 0 ? value : null;
  },
});

/**
 * A picture pasted or dropped into a Note (#1937): a Block of its own, kept
 * in the Note's data as a `data:` URL, with the size it is drawn at and the
 * alt text the User writes. A Question, a check, a suggestion and an edit
 * never read it, and only a Question the User selects it for sends it.
 */
export const Picture = Node.create<PictureOptions>({
  name: PICTURE_NODE,
  group: "block",
  atom: true,
  selectable: true,
  // The Block handle moves it, as it moves a chart: one drag layer (tests/renderer/conformanceStatic).
  draggable: false,

  addOptions() {
    return { view: null };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      width: number("width"),
      height: number("height"),
    };
  },

  parseHTML() {
    return [{ tag: `img[data-type="${PICTURE_NODE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(HTMLAttributes, { "data-type": PICTURE_NODE, class: "mind-picture" }),
    ];
  },

  renderText({ node }) {
    return typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  },

  addNodeView() {
    return this.options.view;
  },
});
