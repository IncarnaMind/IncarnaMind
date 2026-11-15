/**
 * Someone else's words in what the User made (#3115): once the core or another copy of the Note
 * adds or takes out words or Blocks inside a Block a step of this copy's history inserted, and the
 * step's Undo or Redo would delete that Block, taking those words with it, the step leaves the
 * history, and ⌘Z goes on to the User's own step before it. A paragraph that isn't empty is never
 * deleted by Undo, which takes back only the User's own words in it, so its step stays; so does a
 * step whose Block was deleted whole, which has nothing of anyone's left in it. Marks and
 * attributes, as a check's result sets, leave every step in place. As shown as hidden: the history
 * a tab keeps (../tabCopies).
 */
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../../core/api";
import { FROM_CORE } from "../mindCopies";
import { takeOutOfHistory, type UndoStack, type UndoStep } from "./editorUndo";

interface Guard {
  holders: number;
  stop(): void;
}

const guards = new WeakMap<object, Guard>();

/** Keeps the history's steps clear of what others write in them, until the function this returns. */
export function keepOthersWords(doc: Y.Doc, history: UndoStack): () => void {
  const guard = guards.get(history) ?? guardOf(doc, history);
  guard.holders++;
  let holding = true;
  return () => {
    if (!holding) return;
    holding = false;
    guard.holders--;
    if (guard.holders === 0) guard.stop();
  };
}

function guardOf(doc: Y.Doc, history: UndoStack): Guard {
  const note = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const touched = new Set<UndoStep>();
  const written = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    if (transaction.origin !== FROM_CORE) return;
    const steps = [...history.undoStack, ...history.redoStack];
    const deletes = (item: Y.Item) => !item.deleted && history.deleteFilter(item);
    for (const step of stepsWrittenIn(events, steps, deletes)) touched.add(step);
  };
  // Once every observer has run: an editor of the copy draws the change in its own, and redrawing
  // the editor before then, as a step's line going does, writes its older Note back over the change.
  const settled = () => {
    if (touched.size === 0) return;
    const steps = new Set(touched);
    touched.clear();
    takeOutOfHistory(history, steps);
  };
  note.observeDeep(written);
  doc.on("afterTransaction", settled);
  const guard: Guard = {
    holders: 0,
    stop: () => {
      note.unobserveDeep(written);
      doc.off("afterTransaction", settled);
      if (guards.get(history) === guard) guards.delete(history);
    },
  };
  guards.set(history, guard);
  return guard;
}

/**
 * The steps that inserted what the events added or took out words or Blocks in: an item the step
 * inserted, which `counts`, holds the change. An attribute or a mark is no change of words.
 */
export function stepsWrittenIn(
  events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
  steps: readonly UndoStep[],
  counts: (item: Y.Item) => boolean,
): Set<UndoStep> {
  const found = new Set<UndoStep>();
  if (steps.length === 0) return found;
  const from = (item: Y.Item | null) => {
    for (let at = item; at; at = at.parent instanceof Y.AbstractType ? at.parent._item : null) {
      const { id } = at;
      const by = steps.filter((step) => !found.has(step) && Y.isDeleted(step.insertions, id));
      if (by.length > 0 && counts(at)) for (const step of by) found.add(step);
    }
  };
  for (const event of events) {
    // A text's own changes come as its delta: a mark is a retain with attributes.
    if (event.target instanceof Y.Text) {
      if (event.delta.some((op) => op.insert !== undefined || op.delete !== undefined)) {
        from(event.target._item);
      }
      continue;
    }
    const { added, deleted } = event.changes;
    for (const item of [...added, ...deleted]) from(item);
  }
  return found;
}
