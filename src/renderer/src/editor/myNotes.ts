/**
 * My notes (#138): a meeting's Note after the call with only what the User typed showing, in the
 * same editor and document, so an edit there is the same line in Notes. A line whose words are
 * all AI text (`GENERATED_MARK`), as the fill writes them, an Answer, and what holds only such
 * lines are hidden; a line the User typed into shows whole, its AI words grey as in Notes.
 *
 * Nothing the User does here reaches a hidden line:
 * - a selection across hidden lines is a `VisibleTextSelection`, whose ranges are the parts that
 *   show: Delete, typing, paste, cut and a mark act on those, and a copy holds only them;
 * - Backspace or Delete next to hidden lines joins with the nearest line that shows;
 * - such a selection isn't dragged, and the cursor never rests in a hidden line;
 * - any other change of the User's that would is refused (`filterTransaction`): the Mind's
 *   document, another copy and Undo always apply;
 * - Undo and Redo don't run the fill's own step, and say so when a step changed hidden lines only.
 */
import { type CommandProps, type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos, Slice } from "@tiptap/pm/model";
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
  decorations: DecorationSet;
}

const KEY = new PluginKey<MyNotesState>("myNotes");
const OFF: MyNotesState = { on: false, hidden: [], typed: true, decorations: DecorationSet.empty };

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

function hides(node: ProseMirrorNode): boolean {
  if (node.type.name === ANSWER_BLOCK) return true;
  if (node.isTextblock) return aiOnly(node);
  if (node.isLeaf || node.childCount === 0) return false;
  let all = true;
  node.forEach((child) => {
    all &&= hides(child);
  });
  return all;
}

export function hiddenIn(doc: ProseMirrorNode): Range[] {
  const ranges: Range[] = [];
  const visit = (parent: ProseMirrorNode, start: number) => {
    parent.forEach((child, offset) => {
      const pos = start + offset;
      if (hides(child)) ranges.push({ from: pos, to: pos + child.nodeSize });
      else if (!child.isTextblock && !child.isLeaf) visit(child, pos + 1);
    });
  };
  visit(doc, 0);
  return ranges;
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

function stateFor(doc: ProseMirrorNode): MyNotesState {
  const hidden = hiddenIn(doc);
  return {
    on: true,
    hidden,
    typed: typedIn(doc, hidden),
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

/** The parts of [from, to] that show. */
function shownRanges(
  doc: ProseMirrorNode,
  hidden: readonly Range[],
  from: number,
  to: number,
): SelectionRange[] {
  const parts: [number, number][] = [];
  let start = from;
  for (const range of hidden) {
    if (range.to <= from || range.from >= to) continue;
    if (range.from > start) parts.push([start, range.from]);
    start = Math.max(start, range.to);
  }
  if (start < to) parts.push([start, to]);
  return parts.map(([a, b]) => new SelectionRange(doc.resolve(a), doc.resolve(b)));
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
    if (!within(hidden, selection.from + 1)) return null;
    return shownTextNear(doc, hidden, selection.from, 1) ?? shownTextNear(doc, hidden, 0, 1);
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
  return false;
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
          apply(tr, before, _old, state) {
            const asked: unknown = tr.getMeta(KEY);
            const on = typeof asked === "boolean" ? asked : before.on;
            if (!on) return OFF;
            if (before.on && !tr.docChanged) return before;
            return stateFor(state.doc);
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
            if (event.key !== "Backspace" && event.key !== "Delete") return false;
            return joinPastHidden(view, event.key === "Backspace", mine.hidden);
          },
          handleDOMEvents: {
            dragstart(view, event) {
              if (!(view.state.selection instanceof VisibleTextSelection)) return false;
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
  const done = run();
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
  addOptions: () => ({ fillNext: () => false, tell: () => undefined }),

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
