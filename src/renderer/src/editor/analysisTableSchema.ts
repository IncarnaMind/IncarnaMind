import { Extension, mergeAttributes, Node, type NodeViewRenderer } from "@tiptap/core";
import { ANALYSIS_TABLE_ATTRIBUTE, ANALYSIS_TABLE_NODE } from "../../../core/api";
import { readTableBinding } from "../../../shared/figureRuns";

/** The binding as an element's data attribute writes it, for a copy that keeps it. */
const bindingOf = (element: HTMLElement) => {
  const raw = element.getAttribute("data-analysis-table");
  if (raw === null) return null;
  try {
    return readTableBinding(JSON.parse(raw));
  } catch {
    return null;
  }
};

const written = (value: unknown) => {
  const binding = readTableBinding(value);
  return binding ? { "data-analysis-table": JSON.stringify(binding) } : {};
};

/** An Analysis's own table (#2378): its table Block names its run, which its cells are judged by. */
export const AnalysisTableBinding = Extension.create({
  name: "analysisTableBinding",
  addGlobalAttributes() {
    return [
      {
        types: ["table"],
        attributes: {
          [ANALYSIS_TABLE_ATTRIBUTE]: {
            default: null,
            parseHTML: bindingOf,
            renderHTML: (attributes: Record<string, unknown>) =>
              written(attributes[ANALYSIS_TABLE_ATTRIBUTE]),
          },
        },
      },
    ];
  },
});

export interface AnalysisTableMarkerOptions {
  view: NodeViewRenderer | null;
}

/** The marker that ends an Analysis table's caption line: one number in the one series (#2378). */
export const AnalysisTableMarker = Node.create<AnalysisTableMarkerOptions>({
  name: ANALYSIS_TABLE_NODE,
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
      [ANALYSIS_TABLE_ATTRIBUTE]: { default: null, rendered: false, parseHTML: bindingOf },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-type="${ANALYSIS_TABLE_NODE}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": ANALYSIS_TABLE_NODE,
        ...written(node.attrs[ANALYSIS_TABLE_ATTRIBUTE]),
      }),
    ];
  },

  renderText() {
    return "";
  },

  addNodeView() {
    return this.options.view;
  },
});
