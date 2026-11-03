import { type Editor, mergeAttributes, Node, type NodeViewRenderer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { FOOTNOTE_NODE, PAGE_BREAK_NODE, QUESTION_BLOCK } from "../../../core/api";
import { asOwnUndoStep } from "./selectionCommands";

/** ⌘↵ (Ctrl+Enter), as in Word: the note binds it itself (`PageBreak`). */
export const PAGE_BREAK_KEYS = "CmdOrCtrl+Enter";

export interface PageBreakOptions {
  /** Draws the break: a faint line across the text, with what it is. */
  view: NodeViewRenderer | null;
}

/** Where a page break can't go: Word has none in a table, and a Question or a footnote has no pages. */
const NO_PAGE_BREAK: ReadonlySet<string> = new Set([
  QUESTION_BLOCK,
  FOOTNOTE_NODE,
  "tableCell",
  "tableHeader",
]);

/** Where a page break would go: where the selection starts, or null if it can't go there. */
export function pageBreakPlace(state: EditorState): number | null {
  const { $from } = state.selection;
  const type = state.schema.nodes[PAGE_BREAK_NODE];
  if (!type || !$from.parent.inlineContent) return null;
  for (let depth = $from.depth; depth > 0; depth--) {
    if (NO_PAGE_BREAK.has($from.node(depth).type.name)) return null;
  }
  return $from.parent.canReplaceWith($from.index(), $from.index(), type) ? $from.pos : null;
}

export const canInsertPageBreak = (state: EditorState): boolean => pageBreakPlace(state) !== null;

/**
 * Puts a page break where the selection starts, as an Undo step of its own,
 * as Word's Ctrl+Enter does: the break ends the line, and what follows it
 * starts a paragraph of its own, on the next page, with the cursor there; at
 * a line's start, the break is a line of its own before it, so the line stays
 * the one it was (a Word file's paragraph, its XML). Nothing is replaced:
 * selected text stays, and starts the next page. False if there is no place
 * for one here.
 */
export function insertPageBreak(editor: Editor): boolean {
  const at = pageBreakPlace(editor.state);
  const type = editor.schema.nodes[PAGE_BREAK_NODE];
  const paragraph = editor.schema.nodes.paragraph;
  if (at === null || !type || !paragraph) return false;
  const { $from } = editor.state.selection;
  return asOwnUndoStep(editor, () =>
    editor.commands.command(({ tr }) => {
      if ($from.parentOffset === 0) {
        const line = paragraph.create(null, type.create());
        tr.insert($from.before(), line);
        tr.setSelection(TextSelection.near(tr.doc.resolve(at + line.nodeSize)));
      } else {
        tr.insert(at, type.create());
        tr.split(at + 1);
        tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3)));
      }
      tr.scrollIntoView();
      return true;
    }),
  );
}

/** The top-level paragraph a selected page break is all of, which deleting it deletes too. */
function lineOfBreak(state: EditorState): { from: number; to: number } | null {
  const { selection, doc } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== PAGE_BREAK_NODE) {
    return null;
  }
  const { $from } = selection;
  const line: ProseMirrorNode = $from.parent;
  if ($from.depth !== 1 || line.childCount !== 1 || doc.childCount < 2) return null;
  return { from: $from.before(), to: $from.after() };
}

/**
 * A page break (`PAGE_BREAK_NODE`, #746), in any Note: an inline node, so one
 * a Word file has inside a paragraph stays where it is, drawn as a line
 * across the text as Word draws it with its marks shown. It is selected as
 * one thing, by a click or the arrows, and Backspace or Delete removes it
 * like any Block, its line too when it is alone on one; ⌘Z brings it back.
 * ⌘↵ puts one in; where none can go, it is a line break, as it was.
 */
export const PageBreak = Node.create<PageBreakOptions>({
  name: PAGE_BREAK_NODE,
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
      source: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-word-source"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.source === "string" ? { "data-word-source": attributes.source } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-type="${PAGE_BREAK_NODE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": PAGE_BREAK_NODE })];
  },

  renderText() {
    return "\n";
  },

  addNodeView() {
    return this.options.view;
  },

  addKeyboardShortcuts() {
    const deleteLine = () => {
      const line = lineOfBreak(this.editor.state);
      if (!line) return false;
      this.editor.view.dispatch(this.editor.state.tr.delete(line.from, line.to).scrollIntoView());
      return true;
    };
    return {
      Backspace: deleteLine,
      Delete: deleteLine,
      "Mod-Enter": () => insertPageBreak(this.editor),
    };
  },
});
