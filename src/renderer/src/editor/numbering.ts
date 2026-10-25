import { type Editor, Extension, wrappingInputRule } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode, type ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { isInTable } from "@tiptap/pm/tables";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  DEEPEST_LEVEL,
  isNumberingScheme,
  itemLevel,
  type NumberingScheme,
  numberingMarker,
} from "../../../shared/numbering";
import { asOneStep, undoStackOf } from "./editorUndo";

/**
 * A numbered list's scheme (#1419; DESIGN.md › Lists › Numbering styles), the level its outermost
 * list starts at, and whether it goes on from the list before. All three are optional, so a Mind
 * saved before reads as a "1. a. i." list from level 0, starting again.
 */
export const NUMBERING_ATTRIBUTE = "numbering";
export const START_LEVEL_ATTRIBUTE = "startLevel";
export const CONTINUES_ATTRIBUTE = "continues";

/** In px: a level's gutter, a wide marker's step, and the room between a marker and its text. */
const LEVEL_INDENT = 48;
const WIDE_STEP = 12;
const MARKER_GAP = 8;

export const schemeOf = (list: ProseMirrorNode): NumberingScheme => {
  const scheme = list.attrs[NUMBERING_ATTRIBUTE];
  return isNumberingScheme(scheme) ? scheme : "default";
};
export const startLevelOf = (list: ProseMirrorNode): number => {
  const level = Number(list.attrs[START_LEVEL_ATTRIBUTE]);
  return Number.isInteger(level) && level > 0 ? level : 0;
};

const KEY = new PluginKey<DecorationSet>("numbering");

export interface NumberingStorage {
  /**
   * The marker typed just now (`text`) while it becomes a list ("marker"), then while that list
   * is the last change ("list").
   */
  typed: { step: "marker" | "list"; text: string } | null;
  /** Opens a list item's right-click menu at the pointer (see `ListMenu`, which sets it). */
  openMenu: ((at: { x: number; y: number }) => void) | null;
}

declare module "@tiptap/core" {
  interface Storage {
    numbering: NumberingStorage;
  }
}

/** Opens the Numbering menu under the paragraph the caret is in, from ⌘K. */
export const NUMBERING_OPEN = "numbering-open";

export const requestNumbering = (editor: Editor): boolean =>
  editor.view.dom.dispatchEvent(new CustomEvent(NUMBERING_OPEN));

let measure: ((text: string) => number) | null = null;
const markerWidth = (text: string) => measure?.(text) ?? 0;

const isList = (node: ProseMirrorNode) =>
  node.type.name === "orderedList" || node.type.name === "bulletList";

function markers(doc: ProseMirrorNode): DecorationSet {
  return DecorationSet.create(doc, markerDecorations(doc));
}

/** Each numbered item's marker, by the position of its first paragraph, in order. */
export function drawnMarkers(doc: ProseMirrorNode): { pos: number; marker: string }[] {
  return markerDecorations(doc).flatMap((decoration) => {
    const marker: unknown = decoration.spec.marker;
    return typeof marker === "string" ? [{ pos: decoration.from, marker }] : [];
  });
}

function markerDecorations(doc: ProseMirrorNode): Decoration[] {
  const decorations: Decoration[] = [];
  let before: number[] | null = null;
  const draw = (
    list: ProseMirrorNode,
    at: number,
    depth: number,
    outer: { scheme: NumberingScheme; startLevel: number },
    numbers: number[],
  ) => {
    const level = itemLevel(depth, outer.startLevel);
    const ordered = list.type.name === "orderedList";
    if (ordered) {
      const start = Number(list.attrs.start);
      numbers[level] = (Number.isInteger(start) && start > 0 ? start : 1) - 1;
      numbers.length = level + 1;
      for (let parent = 0; parent < level; parent++) numbers[parent] ||= 1;
    }
    list.forEach((item, offset) => {
      const itemAt = at + 1 + offset;
      if (ordered) {
        numbers[level] = (numbers[level] ?? 0) + 1;
        numbers.length = level + 1;
        const first = item.firstChild;
        if (first?.isTextblock) {
          const marker = numberingMarker(outer.scheme, level, numbers);
          const gutter = LEVEL_INDENT * (level + 1);
          const over = markerWidth(marker) + MARKER_GAP - gutter;
          const extra = over > 0 ? WIDE_STEP * Math.ceil(over / WIDE_STEP) : 0;
          decorations.push(
            Decoration.node(
              itemAt + 1,
              itemAt + 1 + first.nodeSize,
              { "data-marker": marker },
              { marker },
            ),
          );
          if (extra > 0) {
            decorations.push(
              Decoration.node(itemAt, itemAt + item.nodeSize, {
                style: `--marker-room: ${extra}px`,
              }),
            );
          }
        }
      }
      item.forEach((child, childOffset) => {
        const childAt = itemAt + 1 + childOffset;
        if (child.type.name === "orderedList") {
          draw(child, childAt, depth + 1, outer, [...numbers]);
        } else if (child.type.name === "bulletList" || child.type.name === "taskList") {
          drawNested(child, childAt);
        }
      });
    });
  };
  // A numbered list under a bullet or a to-do starts a numbered list of its own (#1419).
  const drawNested = (list: ProseMirrorNode, at: number) => {
    list.forEach((item, itemOffset) => {
      const itemAt = at + 1 + itemOffset;
      item.forEach((child, childOffset) => {
        const childAt = itemAt + 1 + childOffset;
        if (child.type.name === "orderedList") {
          draw(child, childAt, 0, { scheme: schemeOf(child), startLevel: startLevelOf(child) }, []);
        } else if (child.type.name === "bulletList" || child.type.name === "taskList") {
          drawNested(child, childAt);
        }
      });
    });
  };
  doc.descendants((node, pos, parent) => {
    if (node.type.name === "bulletList" || node.type.name === "taskList") return true;
    if (node.type.name !== "orderedList") return true;
    const nested = parent?.type.name === "listItem" || parent?.type.name === "taskItem";
    if (nested && listParent(doc, pos) === "orderedList") return false;
    const continues = node.attrs[CONTINUES_ATTRIBUTE] === true && before !== null;
    const numbers: number[] = continues && before ? [...before] : [];
    const outer = { scheme: schemeOf(node), startLevel: startLevelOf(node) };
    if (continues && before) {
      const level = itemLevel(0, outer.startLevel);
      const shifted = { ...node.attrs, start: (before[level] ?? 0) + 1 };
      draw(node.type.create(shifted, node.content), pos, 0, outer, numbers);
    } else {
      draw(node, pos, 0, outer, numbers);
    }
    if (!nested) before = numbers.length > 0 ? numbers : before;
    return false;
  });
  return decorations;
}

const listParent = (doc: ProseMirrorNode, pos: number): string | null => {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === "orderedList" || name === "bulletList" || name === "taskList") return name;
  }
  return null;
};

/**
 * The first markers that begin a list when typed at the start of an empty line, as Word's
 * AutoFormat reads them, and the scheme and level each draws in. Chinese ones end in their own
 * punctuation, so they need no space.
 */
const FIRST_MARKERS: Readonly<Record<string, { scheme: NumberingScheme; level: number }>> = {
  "a. ": { scheme: "default", level: 1 },
  "i. ": { scheme: "default", level: 2 },
  "1.1 ": { scheme: "outline", level: 1 },
  "1.1. ": { scheme: "outline", level: 1 },
  "(a) ": { scheme: "clauses", level: 0 },
  "(i) ": { scheme: "clauses", level: 1 },
  "(A) ": { scheme: "clauses", level: 2 },
  "一、": { scheme: "chinese", level: 0 },
  "（一）": { scheme: "chinese", level: 1 },
  "（1）": { scheme: "chinese", level: 3 },
};
const TYPED_PATTERN = /^(?:\d{1,4}\. |1\.1\.? |[ai]\. |\([aiA]\) |一、|（一）|（1）)$/;

function typedMarker(text: string): { scheme: NumberingScheme; level: number; start: number } {
  const first = FIRST_MARKERS[text];
  return first
    ? { ...first, start: 1 }
    : { scheme: "default", level: 0, start: Number.parseInt(text, 10) };
}

export const Numbering = Extension.create<object, NumberingStorage>({
  name: "numbering",
  // Ahead of the ordered list's own "1. ", which knows no scheme.
  priority: 1000,

  addGlobalAttributes() {
    return [
      {
        types: ["orderedList"],
        attributes: {
          [NUMBERING_ATTRIBUTE]: {
            default: null,
            parseHTML: (element: HTMLElement) => {
              const value = element.getAttribute("data-numbering");
              return isNumberingScheme(value) ? value : null;
            },
            renderHTML: (attributes: Record<string, unknown>) =>
              isNumberingScheme(attributes[NUMBERING_ATTRIBUTE])
                ? { "data-numbering": attributes[NUMBERING_ATTRIBUTE] }
                : {},
          },
          // Absent (null), not 0 or false, when unset: the editor's Yjs binding writes any value
          // it holds, so a default would rewrite every list the core wrote.
          [START_LEVEL_ATTRIBUTE]: {
            default: null,
            parseHTML: (element: HTMLElement) =>
              Number(element.getAttribute("data-start-level")) || null,
            renderHTML: (attributes: Record<string, unknown>) => {
              const level = Number(attributes[START_LEVEL_ATTRIBUTE]) || 0;
              return level > 0
                ? { "data-start-level": String(level), style: `--start-level: ${level}` }
                : {};
            },
          },
          [CONTINUES_ATTRIBUTE]: {
            default: null,
            parseHTML: (element: HTMLElement) => element.hasAttribute("data-continues") || null,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes[CONTINUES_ATTRIBUTE] === true ? { "data-continues": "" } : {},
          },
        },
      },
    ];
  },

  addStorage() {
    return { typed: null, openMenu: null };
  },

  addKeyboardShortcuts() {
    // A list that starts deeper has a level to step out to before the list ends.
    const stepOut = () =>
      emptyItemAt(this.editor) && asOneStep(this.editor, () => raiseFromStartLevel(this.editor));
    // In a table, Tab moves between cells.
    const inTable = () => isInTable(this.editor.state);
    // Before the list item's own Tab and Shift-Tab, which can't nest a first item or lift an item
    // of a list that starts deeper, as ⌘] and ⌘[ (`changeIndent`) do too.
    return {
      Enter: stepOut,
      Backspace: stepOut,
      Tab: () => !inTable() && asOneStep(this.editor, () => deepenList(this.editor)),
      "Shift-Tab": () =>
        !inTable() && asOneStep(this.editor, () => raiseFromStartLevel(this.editor)),
    };
  },

  addInputRules() {
    const editor = this.editor;
    const storage = this.storage;
    const type = editor.schema.nodes.orderedList;
    if (!type) return [];
    return [
      wrappingInputRule({
        find: TYPED_PATTERN,
        type,
        getAttributes: (match) => {
          const typed = typedMarker(match[0]);
          storage.typed = { step: "marker", text: match[0] };
          // In a list, a nested list takes its level and scheme from the list it is in.
          const { $from } = editor.state.selection;
          for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type.name === "listItem") return { start: typed.start };
          }
          return {
            start: typed.start,
            [NUMBERING_ATTRIBUTE]: typed.scheme === "default" ? null : typed.scheme,
            [START_LEVEL_ATTRIBUTE]: typed.level || null,
          };
        },
        joinPredicate: (match, node) => {
          // A typed first marker means that number, so under another list it begins a new one.
          const typed = typedMarker(match[0]);
          return (
            schemeOf(node) === typed.scheme &&
            startLevelOf(node) === typed.level &&
            node.childCount + (Number(node.attrs.start) || 1) === typed.start
          );
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const storage = this.storage;
    return [
      new Plugin<DecorationSet>({
        key: KEY,
        // Tiptap dispatches the typed text, then the list: a step of its own between them lets ⌘Z
        // straight after put the typed marker back, and take back no more.
        appendTransaction: (transactions, _before, state) => {
          const typed = storage.typed;
          if (!typed || !transactions.some((tr) => tr.docChanged)) return null;
          if (typed.step === "marker") {
            if (!transactions.some((tr) => tr.getMeta("inputRule"))) return null;
            undoStackOf(editor)?.stopCapturing();
            storage.typed = { ...typed, step: "list" };
            return null;
          }
          storage.typed = null;
          undoStackOf(editor)?.stopCapturing();
          const undone = transactions.some(
            (tr) => tr.getMeta(ySyncPluginKey)?.isUndoRedoOperation === true,
          );
          const { selection } = state;
          const { $from } = selection;
          if (!undone || !selection.empty || !$from.parent.textContent.startsWith(typed.text)) {
            return null;
          }
          return state.tr.setSelection(
            TextSelection.create(state.doc, $from.start() + typed.text.length),
          );
        },
        state: {
          init: (_, state) => markers(state.doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(KEY) ? markers(tr.doc) : old),
        },
        props: {
          decorations: (state) => KEY.getState(state),
          handleDOMEvents: {
            contextmenu: (view, event) => {
              const open = storage.openMenu;
              if (!open || !view.editable) return false;
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              const $at = at && view.state.doc.resolve(at.pos);
              const inItem = $at && listItemDepth($at) > 0;
              if (!$at || !inItem) return false;
              event.preventDefault();
              const { from, to } = view.state.selection;
              if ($at.pos < from || $at.pos > to) {
                view.dispatch(view.state.tr.setSelection(TextSelection.near($at)));
              }
              view.focus();
              open({ x: event.clientX, y: event.clientY });
              return true;
            },
          },
        },
        view: (view) => {
          const canvas = document.createElement("canvas").getContext("2d");
          let font = "";
          measure = (text) => {
            if (!canvas) return 0;
            if (canvas.font !== font) canvas.font = font;
            return canvas.measureText(text).width;
          };
          // Drawn again once the page's font is known, as markers are measured in it.
          if (typeof requestAnimationFrame !== "function") return {};
          const frame = requestAnimationFrame(() => {
            const style = getComputedStyle(view.dom);
            font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(KEY, true));
          });
          return { destroy: () => cancelAnimationFrame(frame) };
        },
      }),
    ];
  },
});

/** The outermost numbered list the selection is in, with where it starts; null outside one. */
export function numberedListAt(editor: Editor): { node: ProseMirrorNode; pos: number } | null {
  const { $from } = editor.state.selection;
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "orderedList") found = { node, pos: $from.before(depth) };
    else if (node.type.name === "bulletList" && found) break;
  }
  return found;
}

const setListAttributes = (editor: Editor, attributes: Record<string, unknown>): boolean => {
  const list = numberedListAt(editor);
  if (!list) return false;
  const tr = editor.state.tr.setNodeMarkup(list.pos, undefined, {
    ...list.node.attrs,
    ...attributes,
  });
  editor.view.dispatch(tr);
  return true;
};

/**
 * Numbers the whole list the caret is in, or the selected paragraphs, in `scheme`; one Undo step.
 */
export function setNumbering(editor: Editor, scheme: NumberingScheme): boolean {
  return asOneStep(editor, () => {
    if (!numberedListAt(editor)) editor.chain().focus().toggleOrderedList().run();
    return setListAttributes(editor, { [NUMBERING_ATTRIBUTE]: scheme });
  });
}

export const restartNumbering = (editor: Editor): boolean =>
  asOneStep(editor, () => setListAttributes(editor, { start: 1, [CONTINUES_ATTRIBUTE]: null }));

/** Whether the list the caret is in can go on from a numbered list before it, and doesn't yet. */
export function canContinueNumbering(editor: Editor): boolean {
  const list = numberedListAt(editor);
  if (!list || list.node.attrs[CONTINUES_ATTRIBUTE] === true) return false;
  // A numbered list under a bullet or a to-do starts fresh, so it has nothing above it to go on.
  if (listParent(editor.state.doc, list.pos) !== null) return false;
  let earlier = false;
  editor.state.doc.nodesBetween(0, list.pos, (node, pos, parent) => {
    if (earlier || pos >= list.pos) return false;
    if (node.type.name === "orderedList" && parent?.type.name !== "listItem") earlier = true;
    return !earlier;
  });
  return earlier;
}

export const continueNumbering = (editor: Editor): boolean =>
  canContinueNumbering(editor) &&
  asOneStep(editor, () => setListAttributes(editor, { [CONTINUES_ATTRIBUTE]: true }));

/**
 * What the Numbering menus show at the caret: its list's scheme, null outside a numbered list, and
 * whether Restart at 1 and Continue numbering would change anything.
 */
export function numberingState(editor: Editor): {
  scheme: NumberingScheme | null;
  canRestart: boolean;
  canContinue: boolean;
} {
  const list = numberedListAt(editor);
  return {
    scheme: list ? schemeOf(list.node) : null,
    canRestart:
      list !== null &&
      (Number(list.node.attrs.start) !== 1 || list.node.attrs[CONTINUES_ATTRIBUTE] === true),
    canContinue: canContinueNumbering(editor),
  };
}

function listItemDepth($at: ResolvedPos): number {
  for (let depth = $at.depth; depth > 1; depth--) {
    if ($at.node(depth).type.name === "listItem" && isList($at.node(depth - 1))) return depth;
  }
  return 0;
}

function emptyItemAt(editor: Editor): boolean {
  const { selection } = editor.state;
  const { $from } = selection;
  return (
    selection.empty &&
    $from.parent.content.size === 0 &&
    $from.depth > 1 &&
    $from.node(-1).type.name === "listItem" &&
    $from.node(-1).childCount === 1
  );
}

function outerItemAt(editor: Editor) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 1; depth--) {
    if ($from.node(depth).type.name !== "listItem") continue;
    const list = $from.node(depth - 1);
    const outer =
      list.type.name === "orderedList" && $from.node(depth - 2).type.name !== "listItem";
    if (!outer) return null;
    return { list, listPos: $from.before(depth - 1), index: $from.index(depth - 1) };
  }
  return null;
}

function selectedItems(list: ProseMirrorNode, listPos: number, from: number, to: number): number {
  let count = 0;
  let at = listPos + 1;
  list.forEach((item) => {
    if (at < to && at + item.nodeSize > from) count++;
    at += item.nodeSize;
  });
  return count;
}

const itemsOf = (list: ProseMirrorNode): ProseMirrorNode[] => {
  const items: ProseMirrorNode[] = [];
  list.forEach((item) => {
    items.push(item);
  });
  return items;
};

const sizeOf = (items: readonly ProseMirrorNode[], upto: number) =>
  items.slice(0, upto).reduce((sum, item) => sum + item.nodeSize, 0);

/**
 * Tab where an item can't nest (the first item of a list): only that item, or every selected item
 * from it, goes a level deeper, as in Word, in a list of its own that starts a level deeper. The
 * items after them stay a list where they were. False when the item nests as usual.
 */
export function deepenList(editor: Editor): boolean {
  const at = outerItemAt(editor);
  if (!at || at.index > 0) return false;
  const { list, listPos } = at;
  const level = startLevelOf(list);
  if (level >= DEEPEST_LEVEL) return true;
  const deeper = { ...list.attrs, [START_LEVEL_ATTRIBUTE]: level + 1 };
  const { from, to } = editor.state.selection;
  const count = Math.max(1, selectedItems(list, listPos, from, to));
  if (count >= list.childCount) {
    editor.view.dispatch(editor.state.tr.setNodeMarkup(listPos, undefined, deeper));
    return true;
  }
  const items = itemsOf(list);
  const tr = editor.state.tr.replaceWith(listPos, listPos + list.nodeSize, [
    list.type.create(
      { ...deeper, start: 1, [CONTINUES_ATTRIBUTE]: null },
      Fragment.fromArray(items.slice(0, count)),
    ),
    list.type.create(list.attrs, Fragment.fromArray(items.slice(count))),
  ]);
  const movedEnd = listPos + sizeOf(items, count);
  tr.setSelection(
    TextSelection.between(tr.doc.resolve(from), tr.doc.resolve(Math.min(to, movedEnd)), 1),
  );
  editor.view.dispatch(tr);
  return true;
}

/**
 * Shift-Tab on an item of a list that starts deeper than the first level: the item, or every
 * selected item from it, comes up one level, as lifting an item out of a nested list does. The
 * items before them stay where they were, and those after them nest under the last one, so each
 * keeps its level. False at the first level, where the item leaves the list as usual. Lists at
 * different levels are never joined.
 */
export function raiseFromStartLevel(editor: Editor): boolean {
  const at = outerItemAt(editor);
  if (!at) return false;
  const level = startLevelOf(at.list);
  if (level === 0) return false;
  const { list, listPos, index } = at;
  const { from, to } = editor.state.selection;
  const items = itemsOf(list);
  const count = Math.min(items.length - index, Math.max(1, selectedItems(list, listPos, from, to)));
  const before = items.slice(0, index);
  const raised = items.slice(index, index + count);
  const after = items.slice(index + count);
  const last = raised.at(-1);
  if (!last) return false;
  const nested = after.length
    ? [
        list.type.create(
          { ...list.attrs, start: 1, [START_LEVEL_ATTRIBUTE]: null, [CONTINUES_ATTRIBUTE]: null },
          Fragment.fromArray(after),
        ),
      ]
    : [];
  const raisedItems = [
    ...raised.slice(0, -1),
    last.type.create(last.attrs, last.content.append(Fragment.from(nested))),
  ];
  const lists = [
    ...(before.length ? [list.type.create(list.attrs, Fragment.fromArray(before))] : []),
    list.type.create(
      {
        ...list.attrs,
        start: 1,
        [START_LEVEL_ATTRIBUTE]: level - 1 || null,
        [CONTINUES_ATTRIBUTE]: null,
      },
      Fragment.fromArray(raisedItems),
    ),
  ];
  // Up beside the list after it, at its level and in its scheme, it goes on in that list: a first
  // item taken a level deeper (`deepenList`) and brought back is one list again, still continuing.
  const next = editor.state.doc.resolve(listPos + list.nodeSize).nodeAfter;
  const joins =
    next?.type === list.type &&
    startLevelOf(next) === level - 1 &&
    schemeOf(next) === schemeOf(list);
  const joined = lists.at(-1);
  if (joins && next && joined) {
    const continues =
      next.attrs[CONTINUES_ATTRIBUTE] === true || joined.attrs[CONTINUES_ATTRIBUTE] === true;
    const attrs = continues ? { ...joined.attrs, [CONTINUES_ATTRIBUTE]: true } : joined.attrs;
    lists[lists.length - 1] = list.type.create(attrs, joined.content.append(next.content));
  }
  const raisedAt = listPos + (before.length ? (lists[0]?.nodeSize ?? 0) : 0);
  const oldItemStart = (offset: number) => listPos + 1 + sizeOf(items, offset);
  const newItemStart = (offset: number) => raisedAt + 1 + sizeOf(raised, offset);
  const newFrom = newItemStart(0) + (from - oldItemStart(index));
  const newTo = newItemStart(count - 1) + (to - oldItemStart(index + count - 1));
  const tr = editor.state.tr.replaceWith(
    listPos,
    listPos + list.nodeSize + (joins && next ? next.nodeSize : 0),
    lists,
  );
  const size = tr.doc.content.size;
  tr.setSelection(
    TextSelection.between(
      tr.doc.resolve(Math.min(newFrom, size)),
      tr.doc.resolve(Math.min(newTo, size)),
    ),
  );
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
