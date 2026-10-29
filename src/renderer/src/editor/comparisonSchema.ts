import { mergeAttributes, Node, type NodeViewRenderer } from "@tiptap/core";
import {
  COMPARISON_CELL_NODE,
  COMPARISON_ROW_NODE,
  COMPARISON_TABLE_NODE,
} from "../../../core/api";
import { MIND_BLOCK_GROUP } from "./questionSchema";

export interface ComparisonViews {
  view: NodeViewRenderer | null;
}

/** Kept in the HTML as `data-…`, so a table copied within IncarnaMind keeps what it holds. */
function dataAttribute(name: string, json = false) {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const raw = element.getAttribute(`data-${name}`);
      if (raw === null || !json) return raw;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[name];
      if (value === null || value === undefined) return {};
      return { [`data-${name}`]: json ? JSON.stringify(value) : String(value) };
    },
  };
}

/**
 * A comparison table (#98): a top-level Block of rows, one per Document, whose
 * cells are the Answers to its Questions (`ComparisonTableAttributes`). Its
 * cells are written by the core, never typed in.
 */
export const ComparisonTable = Node.create<ComparisonViews>({
  name: COMPARISON_TABLE_NODE,
  group: MIND_BLOCK_GROUP,
  content: `${COMPARISON_ROW_NODE}+`,
  isolating: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { view: null };
  },

  addAttributes() {
    return {
      title: dataAttribute("title"),
      questions: dataAttribute("questions", true),
      providerId: dataAttribute("provider-id"),
      modelId: dataAttribute("model-id"),
      instruction: dataAttribute("instruction"),
    };
  },

  // Ahead of a plain table's rules, which would take it too.
  parseHTML() {
    return [{ tag: `table[data-type="${COMPARISON_TABLE_NODE}"]`, priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "table",
      mergeAttributes(HTMLAttributes, { "data-type": COMPARISON_TABLE_NODE }),
      ["tbody", {}, 0],
    ];
  },

  addNodeView() {
    return this.options.view;
  },
});

/** A comparison table's row: one Document. */
export const ComparisonRow = Node.create<ComparisonViews>({
  name: COMPARISON_ROW_NODE,
  content: `${COMPARISON_CELL_NODE}+`,
  isolating: true,

  addOptions() {
    return { view: null };
  },

  addAttributes() {
    return {
      documentId: dataAttribute("document-id"),
      documentName: dataAttribute("document-name"),
    };
  },

  parseHTML() {
    return [{ tag: `tr[data-type="${COMPARISON_ROW_NODE}"]`, priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["tr", mergeAttributes(HTMLAttributes, { "data-type": COMPARISON_ROW_NODE }), 0];
  },

  addNodeView() {
    return this.options.view;
  },
});

/** A comparison table's cell: its Answer, with its Citations, or why there is none. */
export const ComparisonCell = Node.create<ComparisonViews>({
  name: COMPARISON_CELL_NODE,
  content: "block+",
  isolating: true,

  addOptions() {
    return { view: null };
  },

  addAttributes() {
    return {
      questionId: dataAttribute("question-id"),
      status: dataAttribute("status"),
      problem: dataAttribute("problem"),
      message: dataAttribute("message"),
      resetsAt: dataAttribute("resets-at"),
    };
  },

  parseHTML() {
    return [{ tag: `td[data-type="${COMPARISON_CELL_NODE}"]`, priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["td", mergeAttributes(HTMLAttributes, { "data-type": COMPARISON_CELL_NODE }), 0];
  },

  addNodeView() {
    return this.options.view;
  },
});
