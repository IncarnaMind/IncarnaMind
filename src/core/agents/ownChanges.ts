/**
 * An outside agent's changes to a Note it wrote apply at once (#3371), each one step of Undo. No
 * window made them, so no editor's history holds them: the core keeps them, a Yjs Undo of their
 * own per Note, and a window's ⌘Z takes them back, last first, as it does its own. A step of a
 * Note whose document has left memory since can't be taken back; the Checkpoint saved before it
 * can still be restored.
 */
import * as Y from "yjs";
import { originMaps } from "../../shared/blockOrigins";
import { MIND_CONTENT_FIELD, MIND_REVISIONS_FIELD, MIND_TEXT_ORIGINS_FIELD } from "../api";
import type { MindContent } from "../mindContent";

interface NoteSteps {
  doc: Y.Doc;
  manager: Y.UndoManager;
  /** What the agent's changes are written with: the one origin `manager` takes steps of. */
  origin: object;
  /** The steps ⌘Z takes back, the last one last; and those ⇧⌘Z does again. */
  done: string[];
  undone: string[];
}

export type OwnChanges = ReturnType<typeof createOwnChanges>;

export function createOwnChanges(
  content: Pick<MindContent, "read" | "edit" | "isLoaded">,
  newId: () => string,
) {
  const notes = new Map<string, NoteSteps>();

  const docOf = (mindId: string): Y.Doc | null =>
    content.read(mindId, (blocks) => blocks.doc ?? null);

  const stepsOf = (mindId: string): NoteSteps | null => {
    const doc = docOf(mindId);
    if (!doc) return null;
    const kept = notes.get(mindId);
    if (kept?.doc === doc) return kept;
    kept?.manager.destroy();
    const origin = {};
    const manager = new Y.UndoManager(
      [
        doc.getXmlFragment(MIND_CONTENT_FIELD),
        ...originMaps(doc),
        doc.getMap(MIND_TEXT_ORIGINS_FIELD),
        doc.getMap(MIND_REVISIONS_FIELD),
      ],
      { captureTimeout: 0, trackedOrigins: new Set([origin]) },
    );
    const steps: NoteSteps = { doc, manager, origin, done: [], undone: [] };
    notes.set(mindId, steps);
    doc.once("destroy", () => {
      if (notes.get(mindId) === steps) notes.delete(mindId);
      manager.destroy();
    });
    return steps;
  };

  /** The Note's steps, while its document is the one in memory now. */
  const live = (mindId: string): NoteSteps | null => {
    const steps = notes.get(mindId);
    if (!steps || !content.isLoaded(mindId) || docOf(mindId) !== steps.doc) return null;
    return steps;
  };

  const mindOf = (stepId: string, stack: "done" | "undone"): string | null => {
    for (const [mindId, steps] of notes) if (steps[stack].at(-1) === stepId) return mindId;
    return null;
  };

  /** Takes a step back, or does it again, then stores and sends what that changed. */
  const move = (stepId: string, from: "done" | "undone"): boolean => {
    const mindId = mindOf(stepId, from);
    const steps = mindId === null ? null : live(mindId);
    if (mindId === null || !steps) return false;
    // Outside any other transaction: Yjs files a step taken back only in a transaction of its own.
    const moved = from === "done" ? steps.manager.undo() !== null : steps.manager.redo() !== null;
    content.edit(mindId, () => undefined);
    if (!moved) return false;
    steps[from].pop();
    steps[from === "done" ? "undone" : "done"].push(stepId);
    return true;
  };

  return {
    /**
     * Changes the Note in one Yjs transaction that is one step of its Undo, the steps undone before
     * it forgotten. Returns what `change` gave, and the step's id; null when it changed nothing.
     */
    write<T>(
      mindId: string,
      change: (blocks: Y.XmlFragment) => T,
    ): { value: T; step: string | null } {
      const steps = stepsOf(mindId);
      const before = steps?.manager.undoStack.length ?? 0;
      const value = content.edit(mindId, change, steps?.origin);
      if (!steps || steps.manager.undoStack.length === before) return { value, step: null };
      const step = newId();
      steps.done.push(step);
      steps.undone = [];
      return { value, step };
    },

    /** Takes a step back: only the Note's last one done, while its document is in memory. */
    undo: (stepId: string): boolean => move(stepId, "done"),

    /** Does a step again: only the Note's last one taken back, before the agent's next change. */
    redo: (stepId: string): boolean => move(stepId, "undone"),
  };
}
