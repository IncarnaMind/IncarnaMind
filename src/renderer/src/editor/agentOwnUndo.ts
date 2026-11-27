/**
 * An outside agent's immediate write to a Note it made (#3371, #3839): while a tab holds that
 * Note, the core's update lands on the tab's kept Undo stack as one step (bracketed by
 * `stopCapturing`), so ⌘Z in the Note runs newest first across the User's typing and the agent's
 * writes. If another copy writes over the step's Blocks, it leaves this tab's history.
 */
import * as Y from "yjs";
import {
  MIND_CONTENT_FIELD,
  MIND_REVISIONS_FIELD,
  MIND_TEXT_ORIGINS_FIELD,
} from "../../../core/api";
import { agentOwnChangeRequestId } from "../../../shared/agentOwnChanges";
import { originMaps } from "../../../shared/blockOrigins";
import type { WordsInLine } from "../lineNames";
import { EDIT_FROM_CORE, FROM_CORE, takeEditUpdates } from "../mindCopies";
import {
  followStepsInHistory,
  type NoteSteps,
  offerHistoryUndo,
  type UndoStack,
  type UndoStep,
} from "./editorUndo";
import { stepsWrittenIn } from "./othersWords";

interface Captured {
  history: UndoStack;
  step: UndoStep;
  steps: NoteSteps;
}

const capturedByStep = new Map<string, Set<Captured>>();

function forgetCaptured(stepId: string, entry: Captured): void {
  const set = capturedByStep.get(stepId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) capturedByStep.delete(stepId);
}

function textTouchedByStep(
  events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
  steps: readonly UndoStep[],
): boolean {
  for (const event of events) {
    if (!(event.target instanceof Y.Text)) continue;
    if (!event.delta.some((op) => op.insert !== undefined || op.delete !== undefined)) continue;
    for (let item = event.target._start; item; item = item.right) {
      if (steps.some((step) => Y.isDeleted(step.insertions, item.id))) return true;
    }
  }
  return false;
}

/**
 * Captures outside-agent immediate changes (`ownChanges`) for `mindId` onto the tab's kept
 * `history` as one step each, until the returned function is called.
 */
export function takeAgentOwnChanges(mindId: string, doc: Y.Doc, history: UndoStack): () => void {
  const tracked = new Set<{ stepId: string; entry: Captured; stop: () => void }>();
  const toDrop = new Set<NoteSteps>();
  const note = doc.getXmlFragment(MIND_CONTENT_FIELD);

  const touched = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    if (tracked.size === 0 || transaction.origin !== FROM_CORE) return;
    for (const item of [...tracked]) {
      const inNote = item.entry.steps.inNote();
      if (inNote.length === 0) continue;
      if (
        stepsWrittenIn(events, inNote, () => true).size > 0 ||
        textTouchedByStep(events, inNote)
      ) {
        toDrop.add(item.entry.steps);
      }
    }
  };
  const settled = () => {
    if (toDrop.size === 0) return;
    const dropping = [...toDrop];
    toDrop.clear();
    for (const steps of dropping) steps.drop();
  };
  note.observeDeep(touched);
  doc.on("afterTransaction", settled);

  const stopTaking = takeEditUpdates(agentOwnChangeRequestId(mindId), doc, (update, cause) => {
    history.addTrackedOrigin(EDIT_FROM_CORE);
    history.addToScope([
      ...originMaps(doc),
      doc.getMap(MIND_TEXT_ORIGINS_FIELD),
      doc.getMap(MIND_REVISIONS_FIELD),
    ]);
    history.stopCapturing();
    const before = history.undoStack.at(-1);
    try {
      Y.applyUpdate(doc, update, EDIT_FROM_CORE);
    } finally {
      history.stopCapturing();
    }
    const step = history.undoStack.at(-1);
    if (!step || step === before) return;
    const steps = followStepsInHistory(history, [step]);
    if (!steps) return;
    const entry: Captured = { history, step, steps };
    const record: { stepId: string; entry: Captured; stop: () => void } = {
      stepId: cause.request,
      entry,
      stop: () => undefined,
    };
    const cleanup = () => {
      record.stop();
      tracked.delete(record);
      forgetCaptured(cause.request, entry);
    };
    record.stop = steps.observe(() => {
      if (!steps.held()) cleanup();
    });
    tracked.add(record);
    const set = capturedByStep.get(cause.request) ?? new Set<Captured>();
    set.add(entry);
    capturedByStep.set(cause.request, set);
  });

  return () => {
    stopTaking();
    note.unobserveDeep(touched);
    doc.off("afterTransaction", settled);
    toDrop.clear();
    for (const item of [...tracked]) {
      item.stop();
      forgetCaptured(item.stepId, item.entry);
    }
    tracked.clear();
  };
}

/**
 * Links an `agents.noteChanged` step to the tab history(s) that already captured it, offering
 * Undo on the app's stack for outside-text ⌘Z. Returns true when at least one tab owns the step.
 */
export function bindCapturedAgentStep(stepId: string, said: WordsInLine): boolean {
  const entries = capturedByStep.get(stepId);
  if (!entries || entries.size === 0) return false;
  capturedByStep.delete(stepId);
  let bound = false;
  for (const entry of entries) {
    if (entry.history.undoStack.at(-1) === entry.step) {
      offerHistoryUndo(entry.history, said, undefined, undefined, undefined, { silent: true });
      bound = true;
    } else if (entry.steps.state() !== "gone") {
      bound = true;
    }
  }
  return bound;
}
