/**
 * A Meeting's fill, written by the core while its Note shows in an editor, is one step of that
 * editor's own Undo (#2527): ⌘Z in the Note takes back the fill and nothing else, ⇧⌘Z puts it
 * back, and the fill's line at the written place follows that step (../meetingFillSteps). A Note
 * that wasn't open when it filled is taken back by the core (`undoMeetingFill`).
 */
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { isPartialMeetingFill, meetingFillCause } from "../../../shared/meetingFill";
import { holdFillSteps } from "../meetingFillSteps";
import { useMeetings } from "../meetings";
import { EDIT_FROM_CORE, takeEditUpdates } from "../mindCopies";
import { pageUndoPlace } from "../undo";
import { asOneStep, followSteps, offerEditorUndo, undoStackOf } from "./editorUndo";
import { editorDoc } from "./proposalReview";

/** While the editor shows the Meeting's Note, the fill it writes is one step of its Undo. */
export function takeFillInEditor(editor: Editor, meetingId: string): () => void {
  const doc = editorDoc(editor);
  const stack = undoStackOf(editor);
  if (!doc || !stack) return () => undefined;
  stack.addTrackedOrigin(EDIT_FROM_CORE);
  let release: (() => void) | null = null;
  const stop = takeEditUpdates(meetingFillCause(meetingId).requestId, doc, (update) => {
    const before = stack.undoStack.at(-1);
    asOneStep(editor, () => Y.applyUpdate(doc, update, EDIT_FROM_CORE));
    const step = stack.undoStack.at(-1);
    if (!step || step === before) return;
    const steps = followSteps(editor, [step]);
    if (!steps) return;
    release?.();
    release = holdFillSteps(meetingId, steps);
    offerEditorUndo(
      editor,
      (t) => {
        const fill = useMeetings.getState().meetings.find((each) => each.id === meetingId)?.fill;
        return t(
          fill && isPartialMeetingFill(fill) ? "meetings.fill.partial" : "meetings.fill.filled",
        );
      },
      pageUndoPlace,
    );
  });
  return () => {
    stop();
    release?.();
  };
}
