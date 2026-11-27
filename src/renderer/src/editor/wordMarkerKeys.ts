import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { WORD_ATOM_NODE } from "../../../core/api";
import {
  INVISIBLE_WORD_ATOMS,
  readWordAtom,
  wordFingerprint,
  wordSourceOf,
} from "../../../shared/wordFiles";

/** A Word file's marker that shows nothing, such as where a bookmark starts or ends. */
const unseen = (node: ProseMirrorNode) =>
  node.type.name === WORD_ATOM_NODE && INVISIBLE_WORD_ATOMS.has(readWordAtom(node.attrs).kind);

/** Whether a marker ends what it marks ("w:bookmarkEnd#3"), rather than starting it. */
const ends = (node: ProseMirrorNode) => /End(?:#|$)/.test(readWordAtom(node.attrs).source ?? "");

/** A line Enter splits after words added before all of its own from the Word file. */
interface FileWordsSplit {
  id: string;
  /** Where the line's content starts, which the split leaves where it was. */
  start: number;
  before: string;
  after: string;
}

interface WordMarkerKeysStorage {
  /** While Enter splits a line it moved the cursor to the start of: put it back past the markers. */
  movedToStart: boolean;
  /** While Enter splits a line whose own words all come after the cursor: they go on as the line. */
  fileWords: FileWordsSplit | null;
}

/**
 * Takes out of `copy`, a Yjs copy of `line`, everything shown before `cut`, as the line's
 * children are synced: a run of text is one text, any other node an element. False when the copy
 * doesn't hold them that way.
 */
function withoutShownBefore(copy: Y.XmlElement, line: ProseMirrorNode, cut: number): boolean {
  const children = copy.toArray();
  const cutTexts = new Map<Y.XmlText, number>();
  const removed: number[] = [];
  let index = -1;
  let inText = false;
  let fits = true;
  line.forEach((child, offset) => {
    if (!child.isText || !inText) index++;
    inText = child.isText;
    const each = children[index];
    if (child.isText ? !(each instanceof Y.XmlText) : !(each instanceof Y.XmlElement)) fits = false;
    if (offset >= cut) return;
    if (each instanceof Y.XmlText) {
      cutTexts.set(each, (cutTexts.get(each) ?? 0) + Math.min(child.nodeSize, cut - offset));
    } else if (!unseen(child)) removed.push(index);
  });
  if (!fits || index !== children.length - 1) return false;
  for (const [text, length] of cutTexts) {
    if (length < text.length) text.delete(0, length);
    else removed.push(children.indexOf(text));
  }
  for (const at of removed.sort((a, b) => b - a)) copy.delete(at, 1);
  return true;
}

/**
 * The line Enter splits at the cursor, when what shows before the cursor was added to it and all
 * of its own words come after: the line without it is the paragraph exactly as the Word file gave
 * it, by the fingerprint the import recorded. Null for any other split.
 */
function fileWordsSplit(state: EditorState, $from: ResolvedPos): FileWordsSplit | null {
  const line = $from.parent;
  const id = line.attrs.id;
  const binding = ySyncPluginKey.getState(state)?.binding;
  if (typeof id !== "string" || !binding) return null;
  const source = wordSourceOf(binding.doc, id);
  if (!source) return null;
  let element: Y.XmlElement | null = null;
  for (const [type, node] of binding.mapping as Map<unknown, unknown>)
    if (node === line && type instanceof Y.XmlElement) element = type;
  if (!element) return null;
  const copies = new Y.Doc().getXmlFragment();
  copies.insert(0, [element.clone()]);
  const copy = copies.get(0);
  const cut = $from.parentOffset;
  if (!(copy instanceof Y.XmlElement) || !withoutShownBefore(copy, line, cut)) return null;
  if (wordFingerprint(copy) !== source.f) return null;
  return {
    id,
    start: $from.start(),
    before: line.textBetween(0, cut, ""),
    after: line.textBetween(cut, line.content.size, ""),
  };
}

/**
 * After that split, the part below holds the line's own words and the part above only what was
 * added: the line goes on below, with its id (and so where it came from in the file), its
 * attributes and the markers that were with its words, and the part above is the new one.
 */
function fileWordsBelow(state: EditorState, split: FileWordsSplit): Transaction | null {
  const { $head, empty } = state.selection;
  const above = state.doc.resolve(split.start).parent;
  const below = $head.parent;
  if (!empty || $head.parentOffset !== 0 || above === below || above.type !== below.type) {
    return null;
  }
  if (above.attrs.id !== split.id || above.textContent !== split.before) return null;
  if (below.textContent !== split.after) return null;
  const tr = state.tr;
  const found: { node: ProseMirrorNode; at: number }[] = [];
  above.forEach((child, offset) => {
    if (unseen(child)) found.push({ node: child, at: split.start + offset });
  });
  for (const { node, at } of [...found].reverse()) tr.delete(at, at + node.nodeSize);
  const markers = found.map((each) => each.node);
  const belowAt = tr.mapping.map($head.before());
  tr.insert(belowAt + 1, markers);
  const fresh = typeof below.attrs.id === "string" && below.attrs.id !== split.id;
  tr.setNodeMarkup(split.start - 1, undefined, {
    ...below.attrs,
    id: fresh ? below.attrs.id : null,
  });
  tr.setNodeMarkup(belowAt, undefined, above.attrs);
  const words = markers.reduce((size, each) => size + each.nodeSize, belowAt + 1);
  return tr.setSelection(TextSelection.create(tr.doc, words));
}

/**
 * Enter beside a Word file's unseen markers splits on the side that keeps each with the words it
 * marks: a click at the start of a clause puts the cursor after where its bookmark starts, and
 * Enter there would leave the bookmark a cross-reference names on the new line before the clause,
 * where Word keeps it with the clause (#746). An arrow can select a marker, which Enter would
 * otherwise delete. Enter after words typed at the start of a clause makes them the new line, and
 * the clause goes on below as itself, so the file has a new clause before it rather than its own
 * words rewritten.
 */
export const WordMarkerKeys = Extension.create<object, WordMarkerKeysStorage>({
  name: "wordMarkerKeys",
  // Before Enter splits the Block.
  priority: 1000,

  addStorage() {
    return { movedToStart: false, fileWords: null };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { state, view } = editor;
        const { selection } = state;
        const storage = this.storage;
        const marker =
          selection instanceof NodeSelection && unseen(selection.node) ? selection.node : null;
        if (!selection.empty && !marker) return false;
        const { $from, $to } = selection;
        const line = $from.parent;
        if (!line.isTextblock) return false;
        let shownBefore = false;
        let shownAfter = false;
        line.forEach((child, offset) => {
          if (unseen(child)) return;
          if (offset < $from.parentOffset) shownBefore = true;
          if (offset + child.nodeSize > $to.parentOffset) shownAfter = true;
        });
        let at: number | null = null;
        if (!shownBefore && (marker || $from.parentOffset > 0)) at = $from.start();
        else if (!shownAfter && (marker || $to.parentOffset < line.content.size)) at = $from.end();
        else if (marker) at = ends(marker) ? $to.pos : $from.pos;
        if (at === null) {
          storage.fileWords = shownBefore && shownAfter ? fileWordsSplit(state, $from) : null;
          if (storage.fileWords) {
            // The split comes in this same key press, or not at all.
            queueMicrotask(() => {
              storage.fileWords = null;
            });
          }
          return false;
        }
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)));
        if (at === $from.start()) {
          storage.movedToStart = true;
          queueMicrotask(() => {
            storage.movedToStart = false;
          });
        }
        // Enter as anywhere else splits the Block where the cursor is now.
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        appendTransaction(transactions, _before, state) {
          if (!transactions.some((each) => each.docChanged)) return null;
          const split = storage.fileWords;
          if (split) {
            storage.fileWords = null;
            return fileWordsBelow(state, split);
          }
          if (!storage.movedToStart) return null;
          storage.movedToStart = false;
          // The cursor goes on in front of the words, past the markers that start them, where a
          // click there puts it.
          const { $head, empty } = state.selection;
          if (!empty || $head.parentOffset !== 0) return null;
          let past = $head.pos;
          $head.parent.forEach((child, offset) => {
            if (offset === past - $head.start() && unseen(child) && !ends(child))
              past += child.nodeSize;
          });
          return past === $head.pos
            ? null
            : state.tr.setSelection(TextSelection.create(state.doc, past));
        },
      }),
    ];
  },
});
