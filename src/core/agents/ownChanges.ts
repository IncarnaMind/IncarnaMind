/**
 * An outside agent's changes to a Note it wrote apply at once (#3371), each one step of Undo. No
 * window made them, so no editor's history holds them: the core keeps them, and a window's ⌘Z
 * takes them back, last first, as it does its own. Each change has a Yjs Undo of its own: Yjs
 * passes over a step with nothing left to take back (what it changed was deleted since) to the one
 * before it, so with one Undo for them all a press could take back a change it didn't name. A step
 * of a Note whose document has left memory since can't be taken back; the Checkpoint saved before
 * it can still be restored.
 */
import * as Y from "yjs";
import { originMaps } from "../../shared/blockOrigins";
import {
  type AgentChangeStep,
  MIND_CONTENT_FIELD,
  MIND_REVISIONS_FIELD,
  MIND_TEXT_ORIGINS_FIELD,
} from "../api";
import type { MindContent } from "../mindContent";

interface Step {
  id: string;
  /** Holds this change alone: it tracks only the origin the change was written with. */
  manager: Y.UndoManager;
}

interface NoteSteps {
  doc: Y.Doc;
  /** The steps ⌘Z takes back, the last one last; and those ⇧⌘Z does again. */
  done: Step[];
  undone: Step[];
}

/** The most steps a Note keeps: each listens to every change of its Note while it is kept. */
const MAX_STEPS = 50;

export type OwnChanges = ReturnType<typeof createOwnChanges>;

export function createOwnChanges(
  content: Pick<MindContent, "read" | "edit" | "isLoaded" | "requireWritable">,
  newId: () => string,
) {
  const notes = new Map<string, NoteSteps>();

  const docOf = (mindId: string): Y.Doc | null =>
    content.read(mindId, (blocks) => blocks.doc ?? null);

  const forget = (steps: readonly Step[]) => {
    for (const step of steps) step.manager.destroy();
  };

  const stepsOf = (mindId: string): NoteSteps | null => {
    const doc = docOf(mindId);
    if (!doc) return null;
    const kept = notes.get(mindId);
    if (kept?.doc === doc) return kept;
    if (kept) forget([...kept.done, ...kept.undone]);
    const note: NoteSteps = { doc, done: [], undone: [] };
    notes.set(mindId, note);
    doc.once("destroy", () => {
      if (notes.get(mindId) === note) notes.delete(mindId);
      forget([...note.done, ...note.undone]);
    });
    return note;
  };

  /** The Note's steps and the one named, while its document is the one in memory now. */
  const find = (stepId: string, from: "done" | "undone") => {
    for (const [mindId, note] of notes) {
      const step = note[from].at(-1);
      if (step?.id !== stepId) continue;
      if (!content.isLoaded(mindId) || docOf(mindId) !== note.doc) return null;
      return { mindId, note, step };
    }
    return null;
  };

  /**
   * Takes the named step back, or does it again: only it, and only the Note's last one. A Note a
   * newer version wrote is refused before anything changes it.
   */
  const move = (stepId: string, from: "done" | "undone"): AgentChangeStep => {
    const found = find(stepId, from);
    if (!found) return "unavailable";
    const { mindId, note, step } = found;
    try {
      content.requireWritable(mindId);
    } catch (error) {
      // This version may never write it: the step goes, as the window's does on the refusal.
      note[from].pop();
      step.manager.destroy();
      throw error;
    }
    // Outside any other transaction: Yjs files a step taken back only in a transaction of its own.
    const moved = from === "done" ? step.manager.undo() : step.manager.redo();
    content.edit(mindId, () => undefined);
    note[from].pop();
    if (moved === null) {
      step.manager.destroy();
      return "nothing-left";
    }
    note[from === "done" ? "undone" : "done"].push(step);
    return "done";
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
      const note = stepsOf(mindId);
      if (!note) return { value: content.edit(mindId, change), step: null };
      const origin = {};
      const manager = new Y.UndoManager(
        [
          note.doc.getXmlFragment(MIND_CONTENT_FIELD),
          ...originMaps(note.doc),
          note.doc.getMap(MIND_TEXT_ORIGINS_FIELD),
          note.doc.getMap(MIND_REVISIONS_FIELD),
        ],
        { captureTimeout: 0, trackedOrigins: new Set([origin]) },
      );
      let value: T;
      try {
        value = content.edit(mindId, change, origin);
      } catch (error) {
        manager.destroy();
        throw error;
      }
      if (manager.undoStack.length === 0) {
        manager.destroy();
        return { value, step: null };
      }
      const id = newId();
      forget(note.undone.splice(0));
      note.done.push({ id, manager });
      forget(note.done.splice(0, Math.max(0, note.done.length - MAX_STEPS)));
      return { value, step: id };
    },

    /** Takes a step back: only the Note's last one done, while its document is in memory. */
    undo: (stepId: string): AgentChangeStep => move(stepId, "done"),

    /** Does a step again: only the Note's last one taken back, before the agent's next change. */
    redo: (stepId: string): AgentChangeStep => move(stepId, "undone"),
  };
}
