/**
 * An outside agent's immediate write to a Note it made (#3371, #3839): while at least one tab
 * holds that Note, one elected tab takes the core's update onto its kept Undo stack as one step
 * (bracketed by `stopCapturing`) and atomically claims ownership from core (`claimAgentChange`),
 * so ⌘Z runs newest first across the User's typing and the agent's writes without any second tab
 * or window holding a duplicate step. If another copy writes over the step's Blocks, it leaves
 * this tab's history.
 */
import * as Y from "yjs";
import {
  MIND_CONTENT_FIELD,
  MIND_REVISIONS_FIELD,
  MIND_TEXT_ORIGINS_FIELD,
} from "../../../core/api";
import { agentOwnChangeRequestId } from "../../../shared/agentOwnChanges";
import { originMaps } from "../../../shared/blockOrigins";
import { core } from "../core";
import type { WordsInLine } from "../lineNames";
import { EDIT_FROM_CORE, FROM_CORE, takeEditUpdates } from "../mindCopies";
import {
  followStepsInHistory,
  type NoteSteps,
  offerHistoryUndo,
  type UndoStack,
  type UndoStep,
} from "./editorUndo";
import { historyEditor } from "./keptHistories";
import { stepsWrittenIn } from "./othersWords";

interface CopyHandle {
  mindId: string;
  doc: Y.Doc;
  history: UndoStack;
}

interface Captured {
  history: UndoStack;
  step: UndoStep;
  steps: NoteSteps;
}

const MAX_REMEMBERED_STEPS = 200;

const copiesByMind = new Map<string, Set<CopyHandle>>();
const electedByStep = new Map<string, CopyHandle>();
const capturedByStep = new Map<string, Captured>();
/** Steps this window handled (claimed or lost claim race), so `agentNotes` won't also offer core Undo. */
const handledSteps = new Set<string>();

function rememberElected(stepId: string, copy: CopyHandle): void {
  electedByStep.set(stepId, copy);
  while (electedByStep.size > MAX_REMEMBERED_STEPS) {
    const oldest = electedByStep.keys().next().value;
    if (oldest === undefined) break;
    electedByStep.delete(oldest);
  }
}

function rememberHandled(stepId: string): void {
  handledSteps.add(stepId);
  while (handledSteps.size > MAX_REMEMBERED_STEPS) {
    const oldest = handledSteps.values().next().value;
    if (oldest === undefined) break;
    handledSteps.delete(oldest);
  }
}

function electOwner(mindId: string, stepId: string): CopyHandle | null {
  const copies = copiesByMind.get(mindId);
  const existing = electedByStep.get(stepId);
  if (existing && copies?.has(existing)) return existing;
  if (!copies || copies.size === 0) return null;
  let shown: CopyHandle | null = null;
  let first: CopyHandle | null = null;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  for (const copy of copies) {
    first ??= copy;
    const editor = historyEditor(copy.history);
    if (!editor) continue;
    shown ??= copy;
    if (editor.isFocused || (active !== null && editor.view.dom.contains(active))) {
      rememberElected(stepId, copy);
      return copy;
    }
  }
  const winner = shown ?? first;
  if (winner) rememberElected(stepId, winner);
  return winner;
}

function forgetCaptured(stepId: string, entry: Captured): void {
  if (capturedByStep.get(stepId) === entry) capturedByStep.delete(stepId);
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
 * Registers a tab's kept `history` for outside-agent immediate changes (`ownChanges`) on `mindId`,
 * until the returned function is called. At most one open tab in this window captures each step
 * and claims it from core; all other open tabs apply the update as a plain core update.
 */
export function takeAgentOwnChanges(mindId: string, doc: Y.Doc, history: UndoStack): () => void {
  const copy: CopyHandle = { mindId, doc, history };
  const copies = copiesByMind.get(mindId) ?? new Set<CopyHandle>();
  copies.add(copy);
  copiesByMind.set(mindId, copies);

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
    if (electOwner(mindId, cause.request) !== copy) {
      Y.applyUpdate(doc, update, FROM_CORE);
      return;
    }
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
    capturedByStep.set(cause.request, entry);
    rememberHandled(cause.request);
    Promise.resolve(core.claimAgentChange(cause.request)).then(
      (claimed) => {
        if (!claimed) steps.drop();
      },
      () => {
        steps.drop();
      },
    );
  });

  return () => {
    stopTaking();
    note.unobserveDeep(touched);
    doc.off("afterTransaction", settled);
    toDrop.clear();
    copies.delete(copy);
    if (copies.size === 0 && copiesByMind.get(mindId) === copies) copiesByMind.delete(mindId);
    for (const [stepId, owner] of electedByStep) {
      if (owner === copy) electedByStep.delete(stepId);
    }
    for (const item of [...tracked]) {
      item.stop();
      forgetCaptured(item.stepId, item.entry);
    }
    tracked.clear();
  };
}

/**
 * Links an `agents.noteChanged` step to the single tab history that captured it, offering
 * Undo on the app's stack for outside-text ⌘Z. Returns true when this window already handled the
 * step (either owns it or lost the cross-window claim race), so `agentNotes` does not also offer
 * core Undo.
 */
export function bindCapturedAgentStep(stepId: string, said: WordsInLine): boolean {
  const entry = capturedByStep.get(stepId);
  const handled = handledSteps.delete(stepId);
  electedByStep.delete(stepId);
  if (!entry) return handled;
  capturedByStep.delete(stepId);
  if (entry.history.undoStack.at(-1) === entry.step) {
    offerHistoryUndo(entry.history, said, undefined, undefined, undefined, { silent: true });
    return true;
  }
  return entry.steps.state() !== "gone" || handled;
}
