import { mergeAttributes, Node, type NodeViewRenderer } from "@tiptap/core";
import { TABLE_OF_CONTENTS_NODE } from "../../../core/api";

export interface TableOfContentsOptions {
  /** Draws the Block: its entries, each jumping to its heading. */
  view: NodeViewRenderer | null;
}

/**
 * A table of contents (#1935): a Block drawn from the Note's headings, so it
 * keeps up to date without the Note storing a copy of them. A .docx export
 * writes Word's own.
 */
export const TableOfContents = Node.create<TableOfContentsOptions>({
  name: TABLE_OF_CONTENTS_NODE,
  group: "block",
  atom: true,
  selectable: true,

  addOptions() {
    return { view: null };
  },

  parseHTML() {
    return [{ tag: `div[data-type="${TABLE_OF_CONTENTS_NODE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": TABLE_OF_CONTENTS_NODE })];
  },

  addNodeView() {
    return this.options.view;
  },
});
