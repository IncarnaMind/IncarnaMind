import { mergeAttributes, Node, type NodeViewRenderer } from "@tiptap/core";
import { CALCULATED_FIGURE_NODE } from "../../../core/api";
import { readCalculatedFigureAttributes } from "../../../shared/calculatedFigures";

export interface CalculatedFigureOptions {
  view: NodeViewRenderer | null;
}

export const CalculatedFigure = Node.create<CalculatedFigureOptions>({
  name: CALCULATED_FIGURE_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { view: null };
  },

  addAttributes() {
    return {
      id: { default: null, rendered: false, parseHTML: () => null },
      figure: { default: null, rendered: false, parseHTML: () => null },
      analysisId: { default: null, rendered: false, parseHTML: () => null },
      claimCheck: { default: null, rendered: false, parseHTML: () => null },
    };
  },

  parseHTML() {
    return [
      {
        tag: `span[data-type="${CALCULATED_FIGURE_NODE}"]`,
        getAttrs: (element: HTMLElement) => {
          const raw = element.getAttribute("data-figure");
          if (raw === null) return false;
          let figure: unknown;
          try {
            figure = JSON.parse(raw);
          } catch {
            return false;
          }
          return (
            readCalculatedFigureAttributes({
              id: element.getAttribute("data-id"),
              figure,
              analysisId: element.getAttribute("data-analysis-id"),
            }) ?? false
          );
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = readCalculatedFigureAttributes(node.attrs);
    if (!attrs) return ["span", {}, ""];
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": CALCULATED_FIGURE_NODE,
        "data-id": attrs.id,
        "data-figure": JSON.stringify(attrs.figure),
        ...(attrs.analysisId !== null && { "data-analysis-id": attrs.analysisId }),
      }),
      attrs.figure.shown,
    ];
  },

  renderText({ node }) {
    return readCalculatedFigureAttributes(node.attrs)?.figure.shown ?? "";
  },

  addNodeView() {
    return this.options.view;
  },
});
