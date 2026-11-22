/**
 * A Meeting's fill, written by the core while its Note shows in an editor, is one step of that
 * editor's own Undo (#2527): ⌘Z in the Note takes back the fill and nothing else, ⇧⌘Z puts it
 * back, and the fill's line at the written place follows that step (../meetingFillSteps). Each
 * copy of the Note takes it as its own step.
 *
 * The step leaves the history once the fill moves on without it: another copy or window changes
 * the words in the fill's Blocks, its paragraphs too, unlike a step of the User's (./othersWords),
 * the core takes it back, or fills anew. Its Undo is then the core's (`undoMeetingFill`), which keeps
 * the Blocks the User typed in.
 *
 * In a tab, the step is the history's the tab keeps for the Note (#3115): a tab switch ends only
 * the editor, and the tab's next editor finds the step where it was, its line with it while the
 * step is on top. A fill written while no editor of the tab shows the Note is no step of the tab's.
 *
 * ⌘Z reaches the fill's Undo on the app's stack only while the fill's text shows, in an editor drawn
 * in its tab, on Notes (#3099). In another tab, on the Transcript or on My notes, which says where to
 * undo it (#138), the Undo keeps its place and ⌘Z passes over it.
 */
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { type MeetingFill, MIND_CONTENT_FIELD } from "../../../core/api";
import { isPartialMeetingFill, meetingFillCause } from "../../../shared/meetingFill";
import { holdFillSteps } from "../meetingFillSteps";
import { useMeetings } from "../meetings";
import { meetingNoteViewFor, useMeetingNoteViews } from "../meetingViews";
import { EDIT_FROM_CORE, FROM_CORE, takeEditUpdates } from "../mindCopies";
import { pageUndoPlace, type Undoable } from "../undo";
import {
  asOneStep,
  type EditorUndoOffer,
  followSteps,
  historyOwnerOf,
  type NoteSteps,
  offerEditorUndo,
  undoStackOf,
} from "./editorUndo";
import { keptHistory, onHistoryEnd } from "./keptHistories";
import { stepsWrittenIn } from "./othersWords";
import { editorDoc } from "./proposalReview";

/** A copy's hold on a Meeting's fill, for as long as its editor lives, or its tab. */
interface Taking {
  /** Editors taking the fill's updates for it now: two while a tab moves to another group. */
  editors: number;
  /** Takes the fill's update in, through `editor`, as one step of the copy's history. */
  taken(editor: Editor, update: Uint8Array): void;
  end(): void;
}

/** Each copy's hold on each Meeting's fill, by Meeting and by what holds the copy's steps. */
const takings = new Map<string, Map<object, Taking>>();

export function takeFillInEditor(editor: Editor, meetingId: string, tabId?: string): () => void {
  const doc = editorDoc(editor);
  const stack = undoStackOf(editor);
  if (!doc || !stack) return () => undefined;
  stack.addTrackedOrigin(EDIT_FROM_CORE);
  const owner = historyOwnerOf(editor);
  const byOwner = takings.get(meetingId) ?? new Map<object, Taking>();
  takings.set(meetingId, byOwner);
  const taking = byOwner.get(owner) ?? holdFill(editor, owner, meetingId, tabId, doc, byOwner);
  taking.editors++;
  const stopTaking = takeEditUpdates(meetingFillCause(meetingId).requestId, doc, (update) =>
    taking.taken(editor, update),
  );
  return () => {
    stopTaking();
    taking.editors--;
    // A tab that keeps the Note's history keeps the fill's step in it until the tab closes.
    if (taking.editors === 0 && !keptHistory(owner)) taking.end();
  };
}

function holdFill(
  first: Editor,
  owner: object,
  meetingId: string,
  tabId: string | undefined,
  doc: Y.Doc,
  byOwner: Map<object, Taking>,
): Taking {
  const stack = undoStackOf(first);
  let held: { steps: NoteSteps; release(): void } | null = null;
  /** This copy's Undo and Redo of the fill the core hasn't followed yet. */
  let following = 0;
  /** The fill's Undo this copy put on the app's stack. */
  let offered: EditorUndoOffer | undefined;
  const textShows = () => {
    const mindId = useMeetings.getState().meetings.find((each) => each.id === meetingId)?.mindId;
    return !tabId || !mindId || meetingNoteViewFor(tabId, mindId) === "notes";
  };
  const letGo = () => {
    if (!held) return;
    const { steps, release } = held;
    held = null;
    release();
    steps.drop();
  };

  const taken = (editor: Editor, update: Uint8Array) => {
    letGo();
    const before = stack?.undoStack.at(-1);
    asOneStep(editor, () => Y.applyUpdate(doc, update, EDIT_FROM_CORE));
    const step = stack?.undoStack.at(-1);
    if (!step || step === before) return;
    const steps = followSteps(editor, [step]);
    if (!steps) return;
    const unhold = holdFillSteps(meetingId, owner, steps, letGo);
    // The core keeps the fill's state, for Try again and for when the Note opens again.
    let undone = false;
    const stopFollowing = steps.observe(() => {
      // Taken out of the Note's history (./othersWords): its Undo is the core's.
      if (steps.state() === "gone") {
        letGo();
        return;
      }
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
      saidOf(meetingId),
      pageUndoPlace,
      undefined,
      undefined,
      {
        name: nameOf(meetingId),
        hidden: () => !textShows(),
      },
    );
    offered = withdraw;
    held = {
      steps,
      release: () => {
        stopFollowing();
        unhold();
        withdraw();
        offered = undefined;
      },
    };
  };
  const note = doc.getXmlFragment(MIND_CONTENT_FIELD);
  // What the core sets on the fill's words afterwards, as a check's result, leaves it here.
  const touched = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    if (!held || transaction.origin !== FROM_CORE) return;
    if (stepsWrittenIn(events, held.steps.inNote(), () => true).size > 0) letGo();
  };
  note.observeDeep(touched);

  const stopWatching = useMeetings.subscribe((state, before) => {
    const fill = fillOf(state.meetings, meetingId);
    const was = fillOf(before.meetings, meetingId);
    if (!held || fill === was || (was?.state !== "filled" && was?.state !== "undone")) return;
    const fillingAnew = following === 0 && fill?.state !== "filled" && fill?.state !== "undone";
    const undoneElsewhere =
      fill?.state === "undone" &&
      was.state !== "undone" &&
      following === 0 &&
      held.steps.state() !== "undone";
    if (fillingAnew || undoneElsewhere) letGo();
  });

  let shows = textShows();
  const stopViewing = useMeetingNoteViews.subscribe(() => {
    if (textShows() === shows) return;
    shows = !shows;
    offered?.recheck();
  });

  let ended = false;
  const stopEnd = onHistoryEnd(owner, () => taking.end());
  const taking: Taking = {
    editors: 0,
    taken,
    end: () => {
      if (ended) return;
      ended = true;
      stopEnd();
      stopViewing();
      note.unobserveDeep(touched);
      stopWatching();
      letGo();
      if (byOwner.get(owner) === taking) byOwner.delete(owner);
      if (byOwner.size === 0 && takings.get(meetingId) === byOwner) takings.delete(meetingId);
    },
  };
  byOwner.set(owner, taking);
  return taking;
}

/** What the fill's Undo says: the line's own words. */
const saidOf =
  (meetingId: string): Undoable["said"] =>
  (t) => {
    const fill = fillOf(useMeetings.getState().meetings, meetingId);
    return t(fill && isPartialMeetingFill(fill) ? "meetings.fill.partial" : "meetings.fill.filled");
  };

/** What the Edit menu calls the fill's Undo. */
const nameOf =
  (meetingId: string): NonNullable<Undoable["name"]> =>
  (t) =>
    t(
      useMeetings.getState().meetings.find((each) => each.id === meetingId)?.kind === "memo"
        ? "memos.fill.undoName"
        : "meetings.fill.undoName",
    );

const fillOf = (
  meetings: readonly { id: string; fill: MeetingFill | null }[],
  meetingId: string,
): MeetingFill | null => meetings.find((each) => each.id === meetingId)?.fill ?? null;
