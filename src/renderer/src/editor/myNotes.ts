/**
 * My notes (#138): a meeting's Note after the call with only what the User typed showing, in the
 * same editor and document, so an edit there is the same line in Notes. A line whose words are
 * all AI text (`GENERATED_MARK`), as the fill writes them, an Answer, and what holds only such
 * lines are hidden; a line the User typed into shows whole, its AI words grey as in Notes.
 *
 * A table's cell, or row, is never hidden on its own, so the cells that show stay under their
 * headers: its AI lines are, and the whole table when all of it is AI text. The line the cursor is
 * in stays shown until the cursor leaves it, even once its last typed word is gone.
 *
 * Nothing the User does here reaches a hidden line:
 * - a selection across hidden lines, or a selected Block holding some, is a
 *   `VisibleTextSelection`, whose ranges are the parts that show: Delete, typing, paste, cut and a
 *   mark act on those, and a copy holds only them;
 * - Enter in a line whose item holds hidden lines after it starts the next item, after them;
 * - Backspace or Delete next to hidden lines joins with the nearest line that shows;
 * - such a selection isn't dragged, and the cursor never rests in a hidden line;
 * - any other change of the User's that would touch a hidden line, or move it to another parent,
 *   is refused (`filterTransaction`): the Mind's document, another copy and Undo always apply;
 * - Undo and Redo don't run the fill's own step, put it back when Yjs reached it past an empty
 *   step, and say so when a step changed hidden lines only.
 */
import { type CommandProps, type Editor, Extension } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode, type ResolvedPos, Slice } from "@tiptap/pm/model";
import {
  AllSelection,
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  SelectionRange,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  Transform,
} from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { redo, undo, ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import { ANSWER_BLOCK, GENERATED_MARK } from "../../../core/api";

interface Range {
  from: number;
  to: number;
}

interface MyNotesState {
  on: boolean;
  /** The hidden nodes, outermost, in document order. */
  hidden: readonly Range[];
  /** Whether a line that shows holds words. */
  typed: boolean;
  /** Where the line the cursor keeps shown starts, though its words are AI text only now. */
  keptAt: number | null;
  decorations: DecorationSet;
}

const KEY = new PluginKey<MyNotesState>("myNotes");
const OFF: MyNotesState = {
  on: false,
  hidden: [],
  typed: true,
  keptAt: null,
  decorations: DecorationSet.empty,
};

/** The items a line in a list sits in: Enter there starts the next one. */
const ITEMS = new Set(["listItem", "taskItem"]);

/** A line of AI text only, as the core reads the fill's lines: its words all carry the mark. */
function aiOnly(line: ProseMirrorNode): boolean {
  const generated = line.type.schema.marks[GENERATED_MARK];
  let words = false;
  let typed = false;
  line.forEach((child) => {
    if (!child.isText || !child.text?.trim()) return;
    words = true;
    if (!generated?.isInSet(child.marks)) typed = true;
  });
  return words && !typed;
}

const tableRole = (node: ProseMirrorNode): unknown => node.type.spec.tableRole;

/** Whether `node` hides: `kept`, the line the cursor keeps shown, never does. */
function hides(node: ProseMirrorNode, kept: ProseMirrorNode | null): boolean {
  if (node === kept) return false;
  if (node.type.name === ANSWER_BLOCK) return true;
  if (node.isTextblock) return aiOnly(node);
  const role = tableRole(node);
  if (role === "row" || role === "cell" || role === "header_cell") return false;
  if (role === "table") {
    let words = false;
    let typed = false;
    node.descendants((line) => {
      if (!line.isTextblock) return true;
      if (line === kept || line.textContent.trim() === "") return false;
      words = true;
      typed ||= !aiOnly(line);
      return false;
    });
    return words && !typed;
  }
  if (node.isLeaf || node.childCount === 0) return false;
  let all = true;
  node.forEach((child) => {
    all &&= hides(child, kept);
  });
  return all;
}

export function hiddenIn(doc: ProseMirrorNode, kept: ProseMirrorNode | null = null): Range[] {
  const ranges: Range[] = [];
  const visit = (parent: ProseMirrorNode, start: number) => {
    parent.forEach((child, offset) => {
      const pos = start + offset;
      if (hides(child, kept)) ranges.push({ from: pos, to: pos + child.nodeSize });
      else if (!child.isTextblock && !child.isLeaf) visit(child, pos + 1);
    });
  };
  visit(doc, 0);
  return ranges;
}

/** `slice` without what hides: a cell keeps its place, emptied, as the page shows it. */
function shownSlice(slice: Slice): Slice {
  const keep = (fragment: Fragment): Fragment => {
    const children: ProseMirrorNode[] = [];
    fragment.forEach((child) => {
      if (hides(child, null)) return;
      if (child.isTextblock || child.isLeaf) {
        children.push(child);
        return;
      }
      const inner = keep(child.content);
      const kept = child.type.validContent(inner)
        ? child.copy(inner)
        : child.type.createAndFill(child.attrs, inner);
      if (kept) children.push(kept);
    });
    return Fragment.from(children);
  };
  return new Slice(keep(slice.content), slice.openStart, slice.openEnd);
}

const within = (hidden: readonly Range[], pos: number) =>
  hidden.find((range) => pos > range.from && pos < range.to);

function typedIn(doc: ProseMirrorNode, hidden: readonly Range[]): boolean {
  let found = false;
  doc.descendants((node, pos) => {
    if (found || hidden.some((range) => pos >= range.from && pos < range.to)) return false;
    if (!node.isTextblock) return true;
    found = node.textContent.trim() !== "";
    return false;
  });
  return found;
}

function stateFor(
  doc: ProseMirrorNode,
  kept: { pos: number; node: ProseMirrorNode } | null,
): MyNotesState {
  const hidden = hiddenIn(doc, kept?.node ?? null);
  return {
    on: true,
    hidden,
    typed: typedIn(doc, hidden),
    keptAt: kept && aiOnly(kept.node) ? kept.pos : null,
    decorations: DecorationSet.create(
      doc,
      hidden.map((range) => Decoration.node(range.from, range.to, { class: "my-notes-hidden" })),
    ),
  };
}

/** The document as My notes shows it: the hidden nodes taken out. */
function shownDoc(doc: ProseMirrorNode, hidden: readonly Range[]): Transform {
  const shown = new Transform(doc);
  for (const range of [...hidden].reverse()) shown.delete(range.from, range.to);
  return shown;
}

/** The text position nearest `pos` in `dir` that shows, or null. */
function shownTextNear(
  doc: ProseMirrorNode,
  hidden: readonly Range[],
  pos: number,
  dir: 1 | -1,
): Selection | null {
  let at = pos;
  for (;;) {
    const found = Selection.findFrom(doc.resolve(at), dir, true);
    if (!found) return null;
    const range = within(hidden, found.from);
    if (!range) return found;
    at = dir > 0 ? range.to : range.from;
  }
}

/**
 * The parts of [from, to] that show, one for each line's words: a hidden line, and the structure
 * around one, are never part of them, so nothing replacing them moves a hidden line.
 */
function shownRanges(
  doc: ProseMirrorNode,
  hidden: readonly Range[],
  from: number,
  to: number,
): SelectionRange[] {
  const parts: SelectionRange[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (hidden.some((range) => pos >= range.from && pos < range.to)) return false;
    if (!node.isTextblock) return true;
    const start = Math.max(from, pos + 1);
    const end = Math.min(to, pos + node.nodeSize - 1);
    if (start < end) parts.push(new SelectionRange(doc.resolve(start), doc.resolve(end)));
    return false;
  });
  return parts.length > 0 ? parts : [new SelectionRange(doc.resolve(from), doc.resolve(from))];
}

/**
 * A text selection across hidden lines: its ranges are the parts that show, so what replaces it
 * replaces those, and its content, which a copy or a cut takes, holds only them.
 */
export class VisibleTextSelection extends TextSelection {
  constructor(
    $anchor: ResolvedPos,
    $head: ResolvedPos,
    readonly hidden: readonly Range[],
  ) {
    super($anchor, $head);
    const from = Math.min($anchor.pos, $head.pos);
    const to = Math.max($anchor.pos, $head.pos);
    Object.defineProperty(this, "ranges", { value: shownRanges($anchor.doc, hidden, from, to) });
  }

  // `from` and `to` are the first range's, as a selection of several ranges has them.
  override content(): Slice {
    const doc = this.$anchor.doc;
    const from = Math.min(this.anchor, this.head);
    const to = Math.max(this.anchor, this.head);
    const shown = shownDoc(
      doc,
      this.hidden.filter((range) => range.from >= from && range.to <= to),
    );
    return shown.doc.slice(shown.mapping.map(from), shown.mapping.map(to, -1), true);
  }
}

/** The selection as My notes keeps it, or null when it is right as it is. */
function shownSelection(
  state: EditorState,
  hidden: readonly Range[],
  before: Selection,
): Selection | null {
  const { doc, selection } = state;
  if (selection instanceof AllSelection) {
    const start = shownTextNear(doc, hidden, 0, 1);
    const end = shownTextNear(doc, hidden, doc.content.size, -1);
    return start && end ? spanning(doc, hidden, start.from, end.to) : null;
  }
  if (selection instanceof NodeSelection) {
    if (within(hidden, selection.from + 1)) {
      return shownTextNear(doc, hidden, selection.from, 1) ?? shownTextNear(doc, hidden, 0, 1);
    }
    const { from, to } = selection;
    if (!hidden.some((range) => range.from >= from && range.to <= to)) return null;
    const start = shownTextNear(doc, hidden, from, 1);
    const end = shownTextNear(doc, hidden, to, -1);
    return start && end && start.from >= from && end.to <= to
      ? spanning(doc, hidden, start.from, end.to)
      : null;
  }
  if (!(selection instanceof TextSelection)) return null;
  const dir = selection.head >= before.head ? 1 : -1;
  const out = (pos: number, toward: 1 | -1) =>
    within(hidden, pos)
      ? (
          shownTextNear(doc, hidden, pos, toward) ??
          shownTextNear(doc, hidden, pos, toward === 1 ? -1 : 1)
        )?.head
      : pos;
  const head = out(selection.head, dir);
  const anchor = out(selection.anchor, selection.anchor <= selection.head ? 1 : -1);
  if (head === undefined || anchor === undefined) return null;
  const want = spanning(doc, hidden, anchor, head);
  const same =
    want.anchor === selection.anchor &&
    want.head === selection.head &&
    want instanceof VisibleTextSelection === selection instanceof VisibleTextSelection;
  return same ? null : want;
}

function spanning(
  doc: ProseMirrorNode,
  hidden: readonly Range[],
  anchor: number,
  head: number,
): TextSelection {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  const across = hidden.some((range) => range.from >= from && range.to <= to);
  return across
    ? new VisibleTextSelection(doc.resolve(anchor), doc.resolve(head), hidden)
    : TextSelection.create(doc, anchor, head);
}

/**
 * Whether a change moved a hidden line under another parent, as lifting a list item onto its
 * hidden siblings does: its parent no longer starts where the change maps the old one's start.
 */
function movesHidden(tr: Transaction, hidden: readonly Range[]): boolean {
  return hidden.some((range) => {
    const $was = tr.before.resolve(range.from);
    if ($was.depth === 0) return false;
    const now = tr.mapping.mapResult(range.from);
    if (now.deleted) return false;
    const $now = tr.doc.resolve(now.pos);
    return $now.depth === 0 || $now.before() !== tr.mapping.map($was.before());
  });
}

/** Whether a transaction does more than change the text inside lines. */
function structural(tr: Transaction): boolean {
  return tr.steps.some((step, index) => {
    if (step instanceof ReplaceAroundStep) return true;
    if (!(step instanceof ReplaceStep)) return false;
    const doc = tr.docs[index];
    if (!doc) return true;
    const $from = doc.resolve(step.from);
    if (!$from.sameParent(doc.resolve(step.to)) || !$from.parent.isTextblock) return true;
    const { slice } = step;
    let blocks = slice.openStart > 0 || slice.openEnd > 0;
    slice.content.forEach((node) => {
      blocks ||= !node.isInline;
    });
    return blocks;
  });
}

/** Whether a change of the User's would touch a hidden line. */
function reachesHidden(tr: Transaction, hidden: readonly Range[]): boolean {
  let ranges: Range[] = hidden.map((range) => ({ ...range }));
  for (const step of tr.steps) {
    let hit = false;
    step.getMap().forEach((oldStart, oldEnd) => {
      hit ||= ranges.some((range) => oldStart < range.to && oldEnd > range.from);
    });
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      hit ||= ranges.some((range) => step.from < range.to && step.to > range.from);
    }
    if (
      step instanceof AttrStep ||
      step instanceof AddNodeMarkStep ||
      step instanceof RemoveNodeMarkStep
    ) {
      hit ||= ranges.some((range) => step.pos >= range.from && step.pos < range.to);
    }
    if (hit) return true;
    const map = step.getMap();
    ranges = ranges
      .map((range) => ({ from: map.map(range.from, 1), to: map.map(range.to, -1) }))
      .filter((range) => range.from < range.to);
  }
  return structural(tr) && movesHidden(tr, hidden);
}

/**
 * Enter in a line whose item holds hidden lines after it, as the fill writes what it found under
 * a line: the next item starts after them, with the rest of the line, so they stay in theirs.
 */
function enterPastHidden(view: EditorView, hidden: readonly Range[]): boolean {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $from } = selection;
  if ($from.depth < 2 || !ITEMS.has($from.node(-1).type.name)) return false;
  const lineEnd = $from.after();
  const itemEnd = $from.end(-1);
  if (!hidden.some((range) => range.from >= lineEnd && range.to <= itemEnd)) return false;
  const line = $from.parent;
  const item = $from.node(-1);
  const next = item.type.createAndFill(
    null,
    line.type.create(null, line.content.cut($from.parentOffset)),
  );
  if (!next) return false;
  const tr = view.state.tr;
  tr.delete($from.pos, $from.end());
  const at = tr.mapping.map($from.after(-1));
  tr.insert(at, next);
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Backspace at a line's start, or Delete at its end, where the neighbouring line is hidden: the
 * nearest line that shows takes this one's words, as joining two lines does; with none, nothing.
 */
function joinPastHidden(view: EditorView, back: boolean, hidden: readonly Range[]): boolean {
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $from } = selection;
  const atEdge = back ? $from.parentOffset === 0 : $from.parentOffset === $from.parent.content.size;
  if (!atEdge || $from.depth === 0) return false;
  const edge = back ? $from.before() : $from.after();
  const next = Selection.findFrom(doc.resolve(edge), back ? -1 : 1, true);
  if (!next || !within(hidden, next.from)) return false;
  const other = shownTextNear(doc, hidden, edge, back ? -1 : 1);
  if (!other) return true;
  const into = back ? other.$from : $from;
  const $line = back ? $from : other.$from;
  const tr = view.state.tr;
  tr.deleteRange($line.before(), $line.after());
  tr.insert(into.pos, $line.parent.content);
  tr.setSelection(TextSelection.create(tr.doc, into.pos));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** The whole of a selection: a selection of several ranges has its first one's from and to. */
const spanOf = (selection: Selection): Range => ({
  from: Math.min(selection.anchor, selection.head, selection.from),
  to: Math.max(selection.anchor, selection.head, selection.to),
});

/** The line the cursor is in, when it was in the same line before the transaction. */
function keptLine(
  tr: Transaction,
  old: EditorState,
  state: EditorState,
): { pos: number; node: ProseMirrorNode } | null {
  const $now = state.selection.$head;
  const $was = old.selection.$head;
  if (!$now.parent.isTextblock || !$was.parent.isTextblock || $now.depth === 0) return null;
  const pos = $now.before();
  return tr.mapping.map($was.before()) === pos ? { pos, node: $now.parent } : null;
}

export const MyNotes = Extension.create({
  name: "myNotes",
  // Before the editor's own keys, the AI text's input method handling and Find, which reads
  // what it hides.
  priority: 1100,

  addProseMirrorPlugins() {
    return [
      new Plugin<MyNotesState>({
        key: KEY,
        state: {
          init: () => OFF,
          apply(tr, before, old, state) {
            const asked: unknown = tr.getMeta(KEY);
            const on = typeof asked === "boolean" ? asked : before.on;
            if (!on) return OFF;
            const left = tr.selectionSet && before.keptAt !== null;
            if (before.on && !tr.docChanged && !left) return before;
            return stateFor(state.doc, before.on ? keptLine(tr, old, state) : null);
          },
        },
        filterTransaction(tr, state) {
          const mine = KEY.getState(state);
          if (!mine?.on || !tr.docChanged) return true;
          if (tr.getMeta(ySyncPluginKey) !== undefined) return true;
          if (tr.getMeta("appendedTransaction") !== undefined) return true;
          return !reachesHidden(tr, mine.hidden);
        },
        appendTransaction(_transactions, before, state) {
          const mine = KEY.getState(state);
          if (!mine?.on) return null;
          const want = shownSelection(state, mine.hidden, before.selection);
          return want ? state.tr.setSelection(want).setMeta("addToHistory", false) : null;
        },
        props: {
          decorations: (state) => KEY.getState(state)?.decorations ?? null,
          handleTextInput(view, _from, _to, text) {
            if (!(view.state.selection instanceof VisibleTextSelection)) return false;
            view.dispatch(view.state.tr.insertText(text).scrollIntoView());
            return true;
          },
          handleKeyDown(view, event) {
            const mine = KEY.getState(view.state);
            if (!mine?.on || event.altKey || event.metaKey || event.ctrlKey) return false;
            if (event.key === "Enter" && !event.shiftKey) {
              return enterPastHidden(view, mine.hidden);
            }
            if (event.key !== "Backspace" && event.key !== "Delete") return false;
            return joinPastHidden(view, event.key === "Backspace", mine.hidden);
          },
          // What a cell selection, or any other, copies holds only what shows.
          transformCopied: (slice, view) =>
            KEY.getState(view.state)?.on ? shownSlice(slice) : slice,
          handleDOMEvents: {
            dragstart(view, event) {
              const mine = KEY.getState(view.state);
              const { from, to } = spanOf(view.state.selection);
              if (!mine?.hidden.some((range) => range.from >= from && range.to <= to)) return false;
              event.preventDefault();
              return true;
            },
            // An input method over a selection across hidden lines starts at a cursor, the parts
            // that show deleted first: its own deletion would take the hidden lines with them.
            compositionstart(view) {
              const mine = KEY.getState(view.state);
              const selected = view.dom.ownerDocument.getSelection();
              const { anchorNode, focusNode } = selected ?? {};
              if (!mine?.on || !selected || selected.isCollapsed || !anchorNode || !focusNode) {
                return false;
              }
              if (!view.dom.contains(anchorNode) || !view.dom.contains(focusNode)) return false;
              const { doc } = view.state;
              const across = spanning(
                doc,
                mine.hidden,
                view.posAtDOM(anchorNode, selected.anchorOffset),
                view.posAtDOM(focusNode, selected.focusOffset),
              );
              if (across instanceof VisibleTextSelection) {
                view.dispatch(view.state.tr.setSelection(across).deleteSelection());
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

/** What Undo and Redo say in My notes, by the line's words. */
export type MyNotesStep = "fillUndo" | "fillRedo" | "undidHidden" | "redidHidden";

export interface MyNotesHistoryOptions {
  /** Whether the next Undo or Redo is the meeting fill's own step, which lives in hidden lines. */
  fillNext(editor: Editor, step: "undo" | "redo"): boolean;
  /** Where the editor's meeting fill stands in its history: in the Note, taken back, or neither. */
  fillState(editor: Editor): "done" | "undone" | null;
  tell(said: MyNotesStep): void;
}

function historyStep(
  editor: Editor,
  step: "undo" | "redo",
  options: MyNotesHistoryOptions,
): boolean {
  const before = editor.state;
  const run = () => (step === "undo" ? undo(before) : redo(before)) === true;
  const mine = KEY.getState(before);
  if (!mine?.on) return run();
  if (options.fillNext(editor, step)) {
    options.tell(step === "undo" ? "fillUndo" : "fillRedo");
    return true;
  }
  const shown = JSON.stringify(shownDoc(before.doc, mine.hidden).doc.toJSON());
  const fill = options.fillState(editor);
  const done = run();
  // Yjs passes over a step left empty, as when another copy deleted what was typed: it reached
  // the fill's, which is put back.
  const reached = step === "undo" ? fill === "done" : fill === "undone";
  if (done && reached && options.fillState(editor) !== fill) {
    if (step === "undo") redo(editor.state);
    else undo(editor.state);
    options.tell(step === "undo" ? "fillUndo" : "fillRedo");
    return true;
  }
  const now = KEY.getState(editor.state);
  if (done && now?.on) {
    const after = JSON.stringify(shownDoc(editor.state.doc, now.hidden).doc.toJSON());
    if (after === shown) options.tell(step === "undo" ? "undidHidden" : "redidHidden");
  }
  return done;
}

/**
 * The Note's Undo and Redo, as Collaboration's, which these take the place of, with My notes'
 * rules. After Collaboration, as a later extension's command of the same name is the one used.
 */
export const MyNotesHistory = Extension.create<MyNotesHistoryOptions>({
  name: "myNotesHistory",
  priority: 50,
  addOptions: () => ({ fillNext: () => false, fillState: () => null, tell: () => undefined }),

  addCommands() {
    const command =
      (step: "undo" | "redo") =>
      () =>
      ({ tr, state, dispatch }: CommandProps) => {
        tr.setMeta("preventDispatch", true);
        const manager = yUndoPluginKey.getState(state)?.undoManager;
        if (!manager || (step === "undo" ? manager.undoStack : manager.redoStack).length === 0) {
          return false;
        }
        if (!dispatch) return true;
        return historyStep(this.editor, step, this.options);
      };
    return { undo: command("undo"), redo: command("redo") };
  },
});

/** Shows the Note as My notes, or as Notes again. */
export function showMyNotes(editor: Editor, on: boolean): void {
  if (editor.isDestroyed || (KEY.getState(editor.state)?.on ?? false) === on) return;
  editor.view.dispatch(editor.state.tr.setMeta(KEY, on).setMeta("addToHistory", false));
}

/** What My notes hides now: nothing while the Note shows whole. */
export const myNotesHidden = (state: EditorState): readonly Range[] =>
  KEY.getState(state)?.hidden ?? [];

/** Whether the transaction showed or left My notes. */
export const myNotesToggled = (tr: Transaction): boolean => tr.getMeta(KEY) !== undefined;

/** My notes shows and no line in it holds words: the User typed none. */
export const myNotesEmpty = (state: EditorState): boolean => {
  const mine = KEY.getState(state);
  return !!mine?.on && !mine.typed;
};
