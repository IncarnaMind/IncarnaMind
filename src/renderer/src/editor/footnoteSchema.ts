import {
  type Editor,
  Extension,
  InputRule,
  mergeAttributes,
  Node,
  type NodeViewRenderer,
} from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
} from "@tiptap/pm/state";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type CitationAttributes,
  FOOTNOTE_NODE,
  QUESTION_BLOCK,
  WORD_ATOM_NODE,
} from "../../../core/api";
import { citationReference } from "../../../shared/citations";
import { noteCopies } from "./noteCopies";
import { asOwnUndoStep } from "./selectionCommands";

/**
 * What a footnote's text holds: text with its marks, line breaks, Citations,
 * and, in a Word file's note, what the import keeps as is (#746).
 */
export const FOOTNOTE_CONTENT = `(text | hardBreak | ${CITATION_NODE} | ${WORD_ATOM_NODE})*`;

export interface FootnoteOptions {
  /** Draws the footnote's marker: its number, and what clicking it does. */
  view: NodeViewRenderer | null;
}

/** A footnote's text as plain text: a Citation in it as its reference, a line break as a new line. */
export function footnoteText(node: ProseMirrorNode): string {
  let text = "";
  node.forEach((child) => {
    if (child.isText) text += child.text ?? "";
    else if (child.type.name === CITATION_NODE) {
      text += citationReference(child.attrs as CitationAttributes);
    } else if (child.type.name === "hardBreak") text += "\n";
  });
  return text;
}

/** The marker of a footnote typed as Pandoc writes one inline, "^[…]", or with full-width brackets. */
const TYPED_FOOTNOTE = /\^[[【]([^[\]【】]+)[\]】]$/;

/**
 * A footnote the User writes (`FOOTNOTE_NODE`): an inline node at its marker,
 * which holds the footnote's text. The editor shows only the marker; the
 * text is edited in a popover at the marker or in the footnote area at the
 * end of the Mind (`FootnoteText`), and copied with the marker, as HTML or
 * as "^[…]" in plain text. Typing "^[…]" makes one.
 */
export const Footnote = Node.create<FootnoteOptions>({
  name: FOOTNOTE_NODE,
  group: "inline",
  inline: true,
  // One thing to the cursor, Backspace and arrows: its text is edited elsewhere.
  atom: true,
  selectable: true,
  draggable: false,
  content: FOOTNOTE_CONTENT,

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
      endnote: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-endnote") === "true" ? true : null,
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.endnote === true ? { "data-endnote": "true" } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: `sup[data-type="${FOOTNOTE_NODE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(HTMLAttributes, { "data-type": FOOTNOTE_NODE }), 0];
  },

  renderText({ node }) {
    return `^[${footnoteText(node)}]`;
  },

  addNodeView() {
    return this.options.view;
  },

  addInputRules() {
    return [
      new InputRule({
        find: TYPED_FOOTNOTE,
        handler: ({ state, range, match }) => {
          const [typed, text] = match;
          if (!typed || !text) return null;
          // The rule runs as "]" is typed, before it is in the text, or as an input method commits it.
          const written = state.doc.textBetween(range.from, range.to, undefined, "\uFFFC");
          if (written !== typed && written !== typed.slice(0, -1)) return null;
          const $from = state.doc.resolve(range.from);
          if (!canHoldFootnote($from)) return null;
          // The words between the brackets, with their marks.
          const at = $from.parentOffset + 2;
          const content = $from.parent.content.cut(at, at + text.length);
          const footnote = state.schema.nodes[FOOTNOTE_NODE]?.create(
            { [BLOCK_ID_ATTRIBUTE]: crypto.randomUUID() },
            content,
          );
          if (!footnote) return null;
          state.tr.replaceWith(range.from, range.to, footnote);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [openFootnotePlugin(), noteCopies()];
  },
});

/**
 * A footnote's marker by keyboard: the arrows select it, as one thing, and
 * Enter opens its text, rather than splitting the line where it is.
 */
export const FootnoteKeys = Extension.create({
  name: "footnoteKeys",
  // Before Enter splits the Block.
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const id = selectedFootnote(editor.state);
        if (!id) return false;
        openFootnote(editor, id);
        return true;
      },
    };
  },
});

/** Whether a footnote can go at this place: in text, not in a Question, nor in a footnote. */
export function canHoldFootnote($pos: ResolvedPos): boolean {
  const type = $pos.doc.type.schema.nodes[FOOTNOTE_NODE];
  if (!type || !$pos.parent.inlineContent) return false;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === QUESTION_BLOCK || name === FOOTNOTE_NODE) return false;
  }
  return $pos.parent.canReplaceWith($pos.index(), $pos.index(), type);
}

/** Where a new footnote would go: after the selection, or null if it can't go there. */
export function footnotePlace(state: EditorState): number | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && selection.node.type.name === FOOTNOTE_NODE) return null;
  return canHoldFootnote(selection.$to) ? selection.to : null;
}

/** Whether "Insert footnote" can act here: add one after the selection, or open the one selected. */
export function canInsertFootnote(state: EditorState): boolean {
  return selectedFootnote(state) !== null || footnotePlace(state) !== null;
}

/** The ID of the footnote the selection is on, if it is on one. */
function selectedFootnote(state: EditorState): string | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== FOOTNOTE_NODE) {
    return null;
  }
  const id: unknown = selection.node.attrs[BLOCK_ID_ATTRIBUTE];
  return typeof id === "string" ? id : null;
}

/**
 * Adds a footnote after the selection, as an Undo step of its own, and opens
 * it to be written; with a footnote selected, opens that one. Returns its ID,
 * or null if there is no place for one here.
 */
export function insertFootnote(editor: Editor): string | null {
  const selected = selectedFootnote(editor.state);
  if (selected) {
    openFootnote(editor, selected);
    return selected;
  }
  const at = footnotePlace(editor.state);
  const type = editor.schema.nodes[FOOTNOTE_NODE];
  if (at === null || !type) return null;
  const id = crypto.randomUUID();
  const footnote = type.create({ [BLOCK_ID_ATTRIBUTE]: id });
  const inserted = asOwnUndoStep(editor, () =>
    editor.commands.command(({ tr }) => {
      tr.insert(at, footnote);
      // The cursor goes on after the marker, where the writing goes on once the footnote is written.
      tr.setSelection(TextSelection.create(tr.doc, at + footnote.nodeSize));
      return true;
    }),
  );
  if (!inserted) return null;
  openFootnote(editor, id);
  return id;
}

/** A footnote in the editor's document, by its ID: where it is and the node. */
export function findFootnote(
  doc: ProseMirrorNode,
  id: string,
): { pos: number; node: ProseMirrorNode } | null {
  let found: { pos: number; node: ProseMirrorNode } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === FOOTNOTE_NODE && node.attrs[BLOCK_ID_ATTRIBUTE] === id) {
      found = { pos, node };
      return false;
    }
    // Footnotes are inline: only nodes with inline content, or with Blocks in them, can hold one.
    return !node.isLeaf;
  });
  return found;
}

/**
 * The footnote whose text is open in the popover at its marker, if any:
 * which one is kept in the editor's state, so one opens at a time and
 * whatever opens one (the marker, Insert footnote, the slash menu) agrees.
 */
const openKey = new PluginKey<string | null>("openFootnote");

function openFootnotePlugin(): Plugin<string | null> {
  return new Plugin<string | null>({
    key: openKey,
    state: {
      init: () => null,
      apply: (tr, open) => {
        const asked: unknown = tr.getMeta(openKey);
        if (asked === undefined) return open;
        return typeof asked === "string" ? asked : null;
      },
    },
  });
}

/** The ID of the footnote open in its popover, or null. */
export const openFootnoteOf = (state: EditorState): string | null =>
  openKey.getState(state) ?? null;

/** Opens a footnote's text in the popover at its marker. */
export function openFootnote(editor: Editor, id: string): void {
  if (editor.view.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(openKey, id));
}

/** Closes the footnote popover. */
export function closeFootnote(editor: Editor): void {
  if (editor.view.isDestroyed || openFootnoteOf(editor.state) === null) return;
  editor.view.dispatch(editor.state.tr.setMeta(openKey, null));
}

/**
 * Puts the cursor in the text right after a footnote's marker, and the focus
 * back in the Mind: where the User was writing when they opened it.
 */
export function returnToFootnote(editor: Editor, id: string): void {
  if (editor.isDestroyed) return;
  const found = findFootnote(editor.state.doc, id);
  if (found) {
    const after = TextSelection.create(editor.state.doc, found.pos + found.node.nodeSize);
    editor.view.dispatch(editor.state.tr.setSelection(after).scrollIntoView());
  }
  focusNow(editor);
}

/**
 * Gives the editor the focus at once, not at the next frame as its focus
 * command does: the keys pressed right after, as the User goes on typing, go to it.
 */
export function focusNow(editor: Editor): void {
  if (!editor.isDestroyed && !editor.view.hasFocus()) editor.view.focus();
}
