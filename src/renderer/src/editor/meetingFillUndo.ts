/**
 * A Meeting's fill, written by the core while its Note shows in an editor, is one step of that
 * editor's own Undo (#2527): ⌘Z in the Note takes back the fill and nothing else, ⇧⌘Z puts it
 * back, and the fill's line at the written place follows that step (../meetingFillSteps). Each
 * copy of the Note takes it as its own step.
 *
 * The step leaves the editor's history once the fill moves on without it: another copy or window
 * changes the words in the fill's Blocks (⌘Z here would delete them with it), the core takes it
 * back, or fills anew. Its Undo is then the core's (`undoMeetingFill`), which keeps the Blocks the User
 * typed in.
 *
 * An editor that closes with the step still on top, as a tab switch closes it, hands the fill to its
 * tab (#3099): the tab's next editor starts with no history, so the line stays there with the core's
 * Undo, on the app's stack under what the User does next, until the fill moves on or the tab closes.
 *
 * ⌘Z reaches the fill's Undo on the app's stack only while the fill's text shows, in an editor drawn
 * in its tab, on Notes (#3099). In another tab, on the Transcript or on My notes, which says where to
 * undo it (#138), the Undo keeps its place and ⌘Z passes over it.
 */
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { type MeetingFill, MIND_CONTENT_FIELD } from "../../../core/api";
import { isPartialMeetingFill, meetingFillCause } from "../../../shared/meetingFill";
import {
  drawnInTab,
  endHandedLine,
  endHandOver,
  fillLineHandedTo,
  type HandedUndo,
  handedOver,
  handFillOver,
  holdFillSteps,
  showHandedFill,
} from "../meetingFillSteps";
import { useMeetings } from "../meetings";
import { meetingNoteViewFor, useMeetingNoteViews } from "../meetingViews";
import { EDIT_FROM_CORE, FROM_CORE, takeEditUpdates } from "../mindCopies";
import { useAppStore } from "../store";
import { pageUndoPlace, type Undoable, useUndo } from "../undo";
import {
  asOneStep,
  followSteps,
  type NoteSteps,
  offerEditorUndo,
  type UndoStep,
  undoStackOf,
} from "./editorUndo";
import { editorDoc } from "./proposalReview";

export function takeFillInEditor(editor: Editor, meetingId: string, tabId?: string): () => void {
  const doc = editorDoc(editor);
  const stack = undoStackOf(editor);
  if (!doc || !stack) return () => undefined;
  stack.addTrackedOrigin(EDIT_FROM_CORE);
  let held: { steps: NoteSteps; release(): void } | null = null;
  /** This editor's Undo and Redo of the fill the core hasn't followed yet. */
  let following = 0;
  /** The fill's Undo this editor put on the app's stack. */
  let offered: Undoable | undefined;
  const textShows = () => {
    const mindId = useMeetings.getState().meetings.find((each) => each.id === meetingId)?.mindId;
    return !tabId || !mindId || meetingNoteViewFor(tabId, mindId) === "notes";
  };
  /** ⌘Z reaches the fill's Undo, this editor's or its tab's, while `shown`, and passes over it else. */
  const showFill = (shown: boolean) => {
    if (offered) useUndo.getState().setAside(offered, !shown);
    if (tabId) showHandedFill(meetingId, tabId, shown);
  };
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
    const withdraw = offerEditorUndo(editor, saidOf(meetingId), pageUndoPlace);
    offered = withdraw.change;
    showFill(textShows());
    held = {
      steps,
      release: () => {
        stopFollowing();
        unhold();
        withdraw();
      },
    };
  });

  const note = doc.getXmlFragment(MIND_CONTENT_FIELD);
  // What the core sets on the fill's words afterwards, as a check's result, leaves it here.
  const touched = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    if (held && transaction.origin === FROM_CORE && wordsChangedIn(events, held.steps.inNote())) {
      letGo();
    }
  };
  note.observeDeep(touched);

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

  let handed = false;
  const handOver = () => {
    if (handed || !held || !tabId || held.steps.state() !== "done" || !held.steps.onTop()) return;
    handed = true;
    // A closing tab leaves the layout before its editor ends.
    if (!tabOpen(tabId)) return;
    handFillOver(meetingId, tabId, coreUndoInPlaceOf(meetingId, offered));
    watchHandOvers();
  };
  // A tab switch may end the editor before this effect or after it: the first hands over, while the
  // editor's history is still whole and its Undo still on the app's stack, to take its place there.
  editor.on("destroy", handOver);
  const actedHere = (event: { type: "undo" | "redo" }) => {
    if (event.type === "undo" && tabId) endHandedLine(meetingId, tabId);
  };
  const afterHandOver = tabId !== undefined && fillLineHandedTo(meetingId, tabId);
  if (afterHandOver) stack.on("stack-item-added", actedHere);
  const undrawn = tabId
    ? drawnInTab(editor, meetingId, tabId, () => stack.undoStack.length === 0)
    : () => undefined;

  let shows = textShows();
  const stopViewing = useMeetingNoteViews.subscribe(() => {
    if (textShows() === shows) return;
    shows = !shows;
    showFill(shows);
  });
  if (tabId) showHandedFill(meetingId, tabId, shows);

  return () => {
    handOver();
    editor.off("destroy", handOver);
    if (afterHandOver) stack.off("stack-item-added", actedHere);
    stopViewing();
    undrawn();
    if (tabId) showHandedFill(meetingId, tabId, false);
    stopTaking();
    note.unobserveDeep(touched);
    stopWatching();
    letGo();
  };
}

/** What the fill's Undo says: the line's own words. */
const saidOf =
  (meetingId: string): Undoable["said"] =>
  (t) => {
    const fill = fillOf(useMeetings.getState().meetings, meetingId);
    return t(fill && isPartialMeetingFill(fill) ? "meetings.fill.partial" : "meetings.fill.filled");
  };

/**
 * The core's Undo of the fill on the app's stack, in the place of the editor's (`inPlaceOf`) so it
 * stays under what the User did since, and passed over until an editor of the tab shows the fill.
 */
function coreUndoInPlaceOf(meetingId: string, inPlaceOf: Undoable | undefined): HandedUndo {
  const change: Undoable = {
    said: saidOf(meetingId),
    name: (t) =>
      t(
        useMeetings.getState().meetings.find((each) => each.id === meetingId)?.kind === "memo"
          ? "memos.fill.undoName"
          : "meetings.fill.undoName",
      ),
    undo: () => useMeetings.getState().undoFill(meetingId),
    shownAt: pageUndoPlace,
  };
  useUndo.getState().offer(change, inPlaceOf);
  useUndo.getState().setAside(change, true);
  return {
    show: (shown) => useUndo.getState().setAside(change, !shown),
    withdraw: () => useUndo.getState().withdraw(change),
  };
}

const tabOpen = (tabId: string) =>
  useAppStore
    .getState()
    .layout?.groups.some((group) => group.tabs.some((tab) => tab.id === tabId)) === true;

let watching = false;

/** A handed-over fill goes once it is taken back, filled anew or gone, or its tab closes. */
function watchHandOvers(): void {
  if (watching) return;
  watching = true;
  useMeetings.subscribe((state) => {
    for (const { meetingId } of handedOver()) {
      if (fillOf(state.meetings, meetingId)?.state !== "filled") endHandOver(meetingId);
    }
  });
  useAppStore.subscribe(({ layout }) => {
    const kept = handedOver();
    if (!layout || kept.length === 0) return;
    const open = new Set(layout.groups.flatMap((group) => group.tabs.map((tab) => tab.id)));
    for (const { meetingId, tabId } of kept) {
      if (!open.has(tabId)) endHandOver(meetingId, tabId);
    }
  });
}

const fillOf = (
  meetings: readonly { id: string; fill: MeetingFill | null }[],
  meetingId: string,
): MeetingFill | null => meetings.find((each) => each.id === meetingId)?.fill ?? null;

/**
 * Whether the events added or took out words or Blocks in what the steps inserted: not an
 * attribute or a mark, as a check's result sets.
 */
function wordsChangedIn(
  events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
  steps: readonly UndoStep[],
): boolean {
  if (steps.length === 0) return false;
  const inserted = (item: Y.Item | null): boolean => {
    for (let at = item; at; at = at.parent instanceof Y.AbstractType ? at.parent._item : null) {
      const { id } = at;
      if (steps.some((step) => Y.isDeleted(step.insertions, id))) return true;
    }
    return false;
  };
  return events.some((event) => {
    // A text's own changes come as its delta: a mark is a retain with attributes.
    if (event.target instanceof Y.Text) {
      return (
        inserted(event.target._item) &&
        event.delta.some((op) => op.insert !== undefined || op.delete !== undefined)
      );
    }
    const { added, deleted } = event.changes;
    return [...added, ...deleted].some(inserted);
  });
}
