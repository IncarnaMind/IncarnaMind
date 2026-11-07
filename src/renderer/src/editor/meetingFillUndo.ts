/**
 * A Meeting's fill, written by the core while its Note shows in an editor, is one step of that
 * editor's own Undo (#2527): ⌘Z in the Note takes back the fill and nothing else, ⇧⌘Z puts it
 * back, and the fill's line at the written place follows that step (../meetingFillSteps). Each
 * copy of the Note takes it as its own step.
 *
 * The step leaves the editor's history once the fill moves on without it: another copy or window
 * changes the fill's Blocks (⌘Z here would delete their words with it), the core takes it back,
 * or fills anew. Its Undo is then the core's (`undoMeetingFill`), which keeps the Blocks the User
 * typed in.
 */
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import type { MeetingFill } from "../../../core/api";
import { isPartialMeetingFill, meetingFillCause } from "../../../shared/meetingFill";
import { holdFillSteps } from "../meetingFillSteps";
import { useMeetings } from "../meetings";
import { EDIT_FROM_CORE, FROM_CORE, takeEditUpdates } from "../mindCopies";
import { pageUndoPlace } from "../undo";
import {
  asOneStep,
  followSteps,
  type NoteSteps,
  offerEditorUndo,
  type UndoStep,
  undoStackOf,
} from "./editorUndo";
import { editorDoc } from "./proposalReview";

export function takeFillInEditor(editor: Editor, meetingId: string): () => void {
  const doc = editorDoc(editor);
  const stack = undoStackOf(editor);
  if (!doc || !stack) return () => undefined;
  stack.addTrackedOrigin(EDIT_FROM_CORE);
  let held: { steps: NoteSteps; release(): void } | null = null;
  /** This editor's Undo and Redo of the fill the core hasn't followed yet. */
  let following = 0;
  const letGo = () => {
    if (!held) return;
    const { steps, release } = held;
    held = null;
    release();
    steps.drop();
  };

  const stopTaking = takeEditUpdates(meetingFillCause(meetingId).requestId, doc, (update) => {
    letGo();
    const before = stack.undoStack.at(-1);
    asOneStep(editor, () => Y.applyUpdate(doc, update, EDIT_FROM_CORE));
    const step = stack.undoStack.at(-1);
    if (!step || step === before) return;
    const steps = followSteps(editor, [step]);
    if (!steps) return;
    const unhold = holdFillSteps(meetingId, editor, steps, letGo);
    // The core keeps the fill's state, for Try again and for when the Note opens again.
    let undone = false;
    const stopFollowing = steps.observe(() => {
      const now = steps.state() === "undone";
      if (now === undone) return;
      undone = now;
      following++;
      void useMeetings
        .getState()
        .followFillUndo(meetingId, now)
        .finally(() => {
          following--;
        });
    });
    const withdraw = offerEditorUndo(
      editor,
      (t) => {
        const fill = fillOf(useMeetings.getState().meetings, meetingId);
        return t(
          fill && isPartialMeetingFill(fill) ? "meetings.fill.partial" : "meetings.fill.filled",
        );
      },
      pageUndoPlace,
    );
    held = {
      steps,
      release: () => {
        stopFollowing();
        unhold();
        withdraw();
      },
    };
  });

  const touched = (transaction: Y.Transaction) => {
    if (
      held &&
      transaction.origin === FROM_CORE &&
      changesWithin(transaction, held.steps.inNote())
    ) {
      letGo();
    }
  };
  doc.on("afterTransaction", touched);

  const stopWatching = useMeetings.subscribe((state, before) => {
    const fill = fillOf(state.meetings, meetingId);
    const was = fillOf(before.meetings, meetingId);
    if (!held || fill === was || (was?.state !== "filled" && was?.state !== "undone")) return;
    const fillingAnew = fill?.state !== "filled" && fill?.state !== "undone";
    const undoneElsewhere =
      fill?.state === "undone" &&
      was.state !== "undone" &&
      following === 0 &&
      held.steps.state() !== "undone";
    if (fillingAnew || undoneElsewhere) letGo();
  });

  return () => {
    stopTaking();
    doc.off("afterTransaction", touched);
    stopWatching();
    letGo();
  };
}

const fillOf = (
  meetings: readonly { id: string; fill: MeetingFill | null }[],
  meetingId: string,
): MeetingFill | null => meetings.find((each) => each.id === meetingId)?.fill ?? null;

/** Whether the transaction changed what the steps inserted, or anything inside it. */
function changesWithin(transaction: Y.Transaction, steps: readonly UndoStep[]): boolean {
  if (steps.length === 0) return false;
  const inserted = (item: Y.Item | null): boolean => {
    for (let at = item; at; at = at.parent instanceof Y.AbstractType ? at.parent._item : null) {
      const { id } = at;
      if (steps.some((step) => Y.isDeleted(step.insertions, id))) return true;
    }
    return false;
  };
  for (const type of transaction.changed.keys()) if (inserted(type._item)) return true;
  let deleted = false;
  Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
    if (!deleted && struct instanceof Y.Item && inserted(struct)) deleted = true;
  });
  return deleted;
}
