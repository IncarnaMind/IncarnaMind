/**
 * Edits the User asked for apply at once (#880), the window's side: the
 * editor that asked takes the core's updates in as its own change, then
 * accepts them, all one step of its Undo.
 */
import { type Editor, getSchema } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  ySyncPluginKey,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  type AgentNoteChange,
  type AskedChangeApplication,
  type AskedChangeTransition,
  BLOCK_ID_ATTRIBUTE,
  type EditCause,
  type EditWithAiResult,
  type LeftOutPart,
  MIND_CONTENT_FIELD,
  MIND_REVISIONS_FIELD,
  MIND_TEXT_ORIGINS_FIELD,
  type ProposalRef,
} from "../../core/api";
import { checkpointBeforeAccept, waitsForUser } from "../../shared/askedChanges";
import { originMaps } from "../../shared/blockOrigins";
import { summarizeProposalChanges } from "../../shared/changeSummary";
import { fingerprintOfMind } from "../../shared/mindState";
import {
  aiUseOfAccepted,
  outOfDateProposals,
  pendingProposals,
  proposalRequestOf,
  resolveProposals,
} from "../../shared/proposals";
import { nameOlderCitations } from "../../shared/signOffs";
import { type ChangeCounts, changeFact } from "./changeFacts";
import { core } from "./core";
import {
  type AppliedAction,
  type AppliedChange,
  type AppliedLine,
  appliedChanges,
  appliedLineIn,
  appliedLineKey,
  appliedText,
  type ChangedBlocks,
  type ChangePlace,
  changedBlocksOf,
  type KeptLine,
  placeOfChange,
  setAppliedLine,
} from "./editor/appliedEditLine";
import {
  anchorChanges,
  asItWas,
  planChanges,
  proposalKindOf,
  writeAccepted,
} from "./editor/arrivedChanges";
import {
  asOneStep,
  type FollowedSteps,
  followSteps,
  followStepsInHistory,
  historyOwnerOf,
  keepInSight,
  type NoteSteps,
  offerEditorUndo,
  offerHistoryUndo,
  onTakenOut,
  takeOutOfHistory,
  type UndoStack,
  type UndoStep,
  undoStackOf,
} from "./editor/editorUndo";
import { historyEditor, keptHistory, onHistoryEnd, onHistoryShown } from "./editor/keptHistories";
import { noteExtensions } from "./editor/noteSchema";
import {
  applyingIn,
  editorDoc,
  type PendingProposal,
  proposalsIn,
  resolveInEditor,
  rewrittenParagraphOf,
  setApplying,
} from "./editor/proposalReview";
import { blockAt } from "./editor/writingPlace";
import { speak } from "./editWithAi";
import { translateNow as t } from "./i18n";
import { EDIT_FROM_CORE, FROM_CORE, takeEditUpdates } from "./mindCopies";
import { rememberNamed } from "./namedChanges";
import { useAppStore } from "./store";
import { pageUndoPlace, type Undoable, UndoRefused, useUndo } from "./undo";

// An origin the editor's Undo tracks, and its copy sends to the core.
class AcceptingEdit {}

export interface Applying {
  requestId: string;
  mindId: string;
  /**
   * The editor that shows it: in a tab that keeps its Note's history, the one drawn now, or the
   * last one while the tab shows something else (#3115).
   */
  editor: Editor;
  /** The history its tab keeps, which it follows from editor to editor; null outside a tab. */
  kept: object | null;
  doc: Y.Doc;
  request: string | null;
  /** The request its Proposals are being written for, drawn as applying until it applies. */
  drawing: string | null;
  steps: UndoStep[];
  /** Later steps that belong to it: removing what it left out. */
  more: UndoStep[];
  /** Its steps as Undo and Redo move them, once it applied. */
  followed: FollowedSteps | null;
  leftOut: readonly LeftOutPart[];
  stopTaking(): void;
  forget(): void;
}

/** An edit held by a tab's kept history, whose editor may not be mounted while hidden (#3839). */
type KeptApplying = Omit<Applying, "editor"> & { editor: Editor | null };

const latest = new WeakMap<object, KeptApplying>();
/**
 * The last edit that applied in each editor, for as long as the editor lives, or its tab, where
 * the tab keeps the Note's history: a newer edit that fails or waits leaves it the last.
 */
const lastApplied = new WeakMap<object, KeptApplying>();

/** Hears the edit's Note leave: its tab closed, or, outside a tab, its editor ended. */
function onceGone(edit: KeptApplying, listener: () => void): () => void {
  if (edit.kept) return onHistoryEnd(edit.kept, listener);
  const { editor } = edit;
  if (!editor) return () => undefined;
  editor.on("destroy", listener);
  return () => void editor.off("destroy", listener);
}

const isGone = (edit: KeptApplying) =>
  edit.kept ? keptHistory(edit.kept) === undefined : (edit.editor?.isDestroyed ?? true);

/** The line an editor of a kept history showed as it stopped showing, for the tab's next one. */
const lineWhenHidden = new WeakMap<object, AppliedLine>();
type PendingHidden =
  | {
      kind: "applied";
      edit: KeptApplying;
      planned: ReturnType<typeof planChanges>;
      facts: ChangeCounts;
      turn?: string;
    }
  | {
      kind: "applied-line";
      edit: KeptApplying;
      line: AppliedLine;
    }
  | {
      kind: "held";
      mindId: string;
      requests: readonly string[];
      facts: ChangeCounts;
    };
/** An edit applied or held while its tab had no mounted editor, waiting to draw its line (#3839). */
const pendingHidden = new WeakMap<object, PendingHidden>();
const historiesFollowed = new WeakSet<object>();
let cachedHiddenSchema: Schema | null = null;
const hiddenNoteSchema = () => (cachedHiddenSchema ??= getSchema(noteExtensions()));

/**
 * A tab switch is no change to an edit (#3115): its line goes with the editor, and the tab's next
 * editor takes over its last applied edit and its line, while the edit's steps are still on top,
 * and the edit asked last, in whatever state it is: being written, held back or applied.
 */
function followHistory(history: object, editor: Editor | null): void {
  if (historiesFollowed.has(history)) return;
  historiesFollowed.add(history);
  let shownIn: Editor | null = editor;
  onHistoryShown(history, () => {
    const next = historyEditor(history);
    if (next === shownIn) return;
    const line =
      shownIn && !shownIn.isDestroyed
        ? appliedLineIn(shownIn.state)
        : (lineWhenHidden.get(history) ?? null);
    shownIn = next;
    if (!next) {
      if (line) lineWhenHidden.set(history, line);
      return;
    }
    lineWhenHidden.delete(history);
    const applied = lastApplied.get(history);
    if (applied) applied.editor = next;
    const asking = latest.get(history);
    if (asking) {
      asking.editor = next;
      // Being written, its Proposals aren't the User's to accept or reject one by one.
      if (asking.drawing) drawApplying(next, asking.drawing, true);
    }
    const pending = pendingHidden.get(history);
    if (pending) {
      pendingHidden.delete(history);
      if (pending.kind === "applied-line") {
        pending.edit.editor = next;
        if (pending.edit.followed?.onTop()) setAppliedLine(next, pending.line);
      } else if (pending.kind === "applied") {
        pending.edit.editor = next;
        if (pending.edit.followed?.onTop()) {
          const changes = appliedChanges(next.state, anchorChanges(next.state, pending.planned));
          setAppliedLine(next, {
            kind: "applied",
            blockId: firstBlockOf(next.state, changes),
            blocks: {
              paragraphs: pending.facts.changed + pending.facts.wrote,
              tables: pending.facts.tables,
            },
            facts: namedIn(next.state, changes, pending.facts, pending.turn),
            reason: null,
            kept: null,
            ...(pending.turn && { turn: pending.turn }),
          });
        }
      } else {
        const requests = new Set(pending.requests);
        const first = proposalsIn(next.state.doc).find((each) => requests.has(each.request));
        if (first) {
          setAppliedLine(next, {
            kind: "held",
            blockId: topBlockAt(next.state, first.from),
            request: first.request,
            asked: {
              mindId: pending.mindId,
              requests: pending.requests,
              facts: pending.facts,
            },
          });
        }
      }
      return;
    }
    if (line && lineHolds(line, applied)) setAppliedLine(next, line);
  });
  onHistoryEnd(history, () => {
    historiesFollowed.delete(history);
    lineWhenHidden.delete(history);
    pendingHidden.delete(history);
  });
}

/** A line taken from an editor still says what is so: its edit still on top, or its changes waiting. */
const lineHolds = (line: AppliedLine, applied: KeptApplying | undefined) =>
  line.kind === "held" || (applied?.followed?.onTop() ?? false);

function asEditStep(edit: KeptApplying, editor: Editor, change: () => void): void {
  const stack = undoStackOf(editor);
  const last = edit.steps.at(-1);
  if (stack && last && stack.undoStack.at(-1) === last) {
    // Yjs joins a change to the last step when it comes soon after that step's last change.
    stack.lastChange = Date.now();
  } else stack?.stopCapturing();
  const before = stack?.undoStack.at(-1);
  try {
    change();
  } finally {
    const after = stack?.undoStack.at(-1);
    if (after && after !== before) edit.steps.push(after);
    stack?.stopCapturing();
  }
}

function foldSteps(edit: KeptApplying, editor: Editor): void {
  const stack = undoStackOf(editor);
  const last = edit.steps.at(-1);
  const earlier = edit.steps.slice(0, -1);
  if (!stack || !last || earlier.length === 0) return;
  last.insertions = Y.mergeDeleteSets([...earlier.map((step) => step.insertions), last.insertions]);
  last.deletions = Y.mergeDeleteSets([...earlier.map((step) => step.deletions), last.deletions]);
  for (const step of earlier) {
    const index = stack.undoStack.indexOf(step);
    if (index >= 0) stack.undoStack.splice(index, 1);
  }
  edit.steps = [last];
}

/** The core took back what a failed edit wrote: its steps would undo nothing. */
function dropSteps(edit: Applying): void {
  const stack = undoStackOf(edit.editor);
  if (stack) takeOutOfHistory(stack, new Set(edit.steps));
  edit.steps = [];
}

function drawApplying(editor: Editor, request: string, applying: boolean): void {
  if (editor.isDestroyed) return;
  const now = applyingIn(editor.state);
  if (now.has(request) === applying) return;
  const next = new Set(now);
  if (applying) next.add(request);
  else next.delete(request);
  setApplying(editor, next);
}

/** Before the edit is asked for, so none of its updates is missed. Null before the editor is bound. */
export function startApplying(editor: Editor, mindId: string, requestId: string): Applying | null {
  const edit = beginEdit(editor, mindId, requestId);
  if (!edit) return null;
  edit.stopTaking = takeEditUpdates(requestId, edit.doc, (update: Uint8Array, cause: EditCause) => {
    edit.request ??= cause.request;
    if (cause.apply) {
      edit.drawing = cause.request;
      drawApplying(edit.editor, cause.request, true);
    }
    asEditStep(edit, edit.editor, () => Y.applyUpdate(edit.doc, update, EDIT_FROM_CORE));
  });
  return edit;
}

function beginEdit(editor: Editor, mindId: string, requestId: string): Applying | null {
  const doc = editorDoc(editor);
  const stack = undoStackOf(editor);
  if (!doc || !stack || editor.isDestroyed) return null;
  const owner = historyOwnerOf(editor);
  latest.get(owner)?.forget();
  pendingHidden.delete(owner);
  setAppliedLine(editor, null);
  stack.addTrackedOrigin(EDIT_FROM_CORE);
  stack.addTrackedOrigin(AcceptingEdit);
  // A change written over Blocks gives them its origin, which its Undo takes back.
  stack.addToScope([
    ...originMaps(doc),
    doc.getMap(MIND_TEXT_ORIGINS_FIELD),
    doc.getMap(MIND_REVISIONS_FIELD),
  ]);
  const popped = ({ stackItem }: { stackItem: UndoStep }) => {
    if (!edit.steps.includes(stackItem) || latest.get(owner) !== edit) return;
    if (!edit.editor.isDestroyed) setAppliedLine(edit.editor, null);
    lineWhenHidden.delete(owner);
    pendingHidden.delete(owner);
  };
  // Someone else's words in what it wrote take its steps out of the Note's history, its line too.
  const takenOut = (steps: ReadonlySet<UndoStep>) => {
    if (!edit.steps.some((step) => steps.has(step)) || latest.get(owner) !== edit) return;
    if (!edit.editor.isDestroyed) setAppliedLine(edit.editor, null);
    lineWhenHidden.delete(owner);
    pendingHidden.delete(owner);
  };
  const kept = owner === editor ? null : owner;
  if (kept) followHistory(kept, editor);
  const edit: Applying = {
    requestId,
    mindId,
    editor,
    kept,
    doc,
    request: null,
    drawing: null,
    steps: [],
    more: [],
    followed: null,
    leftOut: [],
    stopTaking: () => undefined,
    forget: () => {
      edit.stopTaking();
      stack.off("stack-item-popped", popped);
      stopTaken();
      if (latest.get(owner) === edit) latest.delete(owner);
    },
  };
  stack.on("stack-item-popped", popped);
  const stopTaken = onTakenOut(stack, takenOut);
  latest.set(owner, edit);
  return edit;
}

const ofRequest = (state: EditorState, request: string) =>
  proposalsIn(state.doc).filter((each) => each.request === request);

/** How long an edit's updates may take to reach the editor's copy after the core's reply. */
const ARRIVAL_WAIT_MS = 5_000;

/**
 * Once the editor's copy has all the core had written when it replied, the request's Proposals
 * among it: on a busy machine the reply can come before the edit's last update, which would
 * come in after the edit stopped taking them, as no part of its Undo step and not accepted with
 * it. "late" when they haven't all come within `ARRIVAL_WAIT_MS`; "none" when they came and
 * left no Proposals of it.
 */
function whenArrived(
  edit: Applying,
  request: string,
  stateVector: Uint8Array,
): Promise<"arrived" | "none" | "late" | "closed"> {
  const wanted = Y.decodeStateVector(stateVector);
  const written = () =>
    [...wanted].every(([client, clock]) => Y.getState(edit.doc.store, client) >= clock);
  const held = () => ofRequest(edit.editor.state, request).length > 0;
  return new Promise((resolve) => {
    if (edit.editor.isDestroyed) {
      resolve("closed");
      return;
    }
    if (written() && held()) {
      resolve("arrived");
      return;
    }
    const done = (arrival: "arrived" | "none" | "late" | "closed") => {
      clearTimeout(timer);
      edit.doc.off("afterTransaction", check);
      edit.editor.off("transaction", check);
      edit.editor.off("destroy", closed);
      resolve(arrival);
    };
    const check = () => {
      if (written() && held()) done("arrived");
    };
    const closed = () => done("closed");
    const timer = setTimeout(
      () => done(!written() ? "late" : held() ? "arrived" : "none"),
      ARRIVAL_WAIT_MS,
    );
    edit.doc.on("afterTransaction", check);
    edit.editor.on("transaction", check);
    edit.editor.on("destroy", closed);
  });
}

/** Where each of the request's changes will be once accepted, and what it takes out, read before accepting. */
function changesOf(state: EditorState, request: string): ChangePlace[] {
  const binding = ySyncPluginKey.getState(state)?.binding;
  if (!binding) return [];
  const relative = (pos: number): unknown =>
    absolutePositionToRelativePosition(pos, binding.type, binding.mapping);
  const { doc } = state;
  return ofRequest(state, request).map((proposal: PendingProposal): ChangePlace => {
    if (proposal.block === "insert") {
      return {
        from: relative(proposal.from),
        // Inside the new Block's end: at the Mind's end, the end itself would take in what comes after it.
        to: relative(proposal.to - 1),
        removed: Fragment.empty,
        block: "added",
      };
    }
    if (proposal.block === "delete") {
      const node = doc.nodeAt(proposal.from);
      return {
        from: relative(proposal.from),
        to: relative(proposal.from),
        removed: node ? Fragment.from(asItWas(node)) : Fragment.empty,
        block: "removed",
      };
    }
    const removed: ProseMirrorNode[] = [];
    const added = { from: -1, to: -1 };
    let end = proposal.from;
    for (const range of proposal.ranges) {
      doc.nodesBetween(range.from, range.to, (node, pos) => {
        if (node.isBlock) return true;
        const from = Math.max(pos, range.from);
        const to = Math.min(pos + node.nodeSize, range.to);
        const kind = proposalKindOf(node);
        if (kind === "delete") {
          removed.push(asItWas(node.isText ? node.cut(from - pos, to - pos) : node));
          end = to;
        } else if (kind === "insert") {
          if (added.from < 0) added.from = from;
          added.to = to;
        }
        return false;
      });
    }
    const words = added.from < 0 ? { from: end, to: end } : added;
    const paragraph = rewrittenParagraphOf(doc, proposal);
    return {
      from: relative(words.from),
      to: relative(words.to),
      removed: Fragment.from(removed),
      block: null,
      ...(paragraph && { paragraph }),
      writtenSize: words.to - words.from,
    };
  });
}

/** The top-level Block the first change is in, after it applied; null at the Mind's end. */
function firstBlockOf(state: EditorState, changes: readonly AppliedChange[]): string | null {
  for (const change of changes) {
    const place = placeOfChange(state, change);
    if (!place) continue;
    const index = state.doc.resolve(Math.min(place.from, state.doc.content.size)).index(0);
    if (index >= state.doc.childCount) return null;
    const id: unknown = state.doc.child(index).attrs[BLOCK_ID_ATTRIBUTE];
    return typeof id === "string" ? id : null;
  }
  return null;
}

/** What a request counted, with the paragraph named when it came to one and the Note shows only it. */
function namedIn(
  state: EditorState,
  changes: readonly AppliedChange[],
  facts: ChangeCounts,
  turn: string | undefined,
): ChangeCounts {
  if (facts.changed + facts.wrote !== 1 || facts.tables > 0 || (facts.charts ?? 0) > 0)
    return facts;
  const { named } = changedBlocksOf(state, changes);
  if (!named) return facts;
  if (turn) rememberNamed(turn, named);
  return { ...facts, named };
}

function reasonOf(doc: Y.Doc, request: string): string | null {
  const made = proposalRequestOf(doc, request);
  return made?.source === "edit-with-ai" ? (made.reason ?? null) : null;
}

function keptLineOf(leftOut: readonly LeftOutPart[]): KeptLine | null {
  const [first] = leftOut;
  if (!first) return null;
  return {
    blockId: first.blockId,
    count: leftOut.length,
    mixed: !leftOut.every((part) => part.kind === "paragraph"),
  };
}

export const appliedMessage = (blocks: ChangedBlocks) => appliedText(t, blocks);

/** Accepts the edit's Proposals as part of its Undo step, and shows the line over it. Returns what changed. */
function apply(edit: KeptApplying, editor: Editor, request: string, parts?: number): ChangedBlocks {
  const places = changesOf(editor.state, request);
  const blocks = edit.doc.getXmlFragment(MIND_CONTENT_FIELD);
  let resolved: ReturnType<typeof resolveProposals> = [];
  nameOlderCitations(blocks);
  asEditStep(edit, editor, () => {
    edit.doc.transact(() => {
      resolved = resolveProposals(blocks, (ref: ProposalRef) => ref.request === request, "accept");
    }, new AcceptingEdit());
  });
  foldSteps(edit, editor);
  drawApplying(editor, request, false);
  const entries = aiUseOfAccepted(edit.doc, edit.mindId, resolved, new Date().toISOString());
  if (entries.length > 0) core.recordAiUse(entries).catch(useAppStore.getState().reportError);
  if (resolved.length === 0 || editor.isDestroyed) return { paragraphs: 0, tables: 0 };
  const { doc } = editor.state;
  const changes = appliedChanges(editor.state, places);
  edit.followed = followSteps(editor, edit.steps);
  lastApplied.set(historyOwnerOf(editor), edit);
  const changed = changedBlocksOf(editor.state, changes);
  setAppliedLine(editor, {
    kind: "applied",
    blockId: firstBlockOf(editor.state, changes),
    blocks: changed,
    reason: reasonOf(edit.doc, request),
    kept: keptLineOf(edit.leftOut.filter((part) => blockAt(doc, part.blockId) !== null)),
    ...(parts !== undefined && parts > 1 && { parts }),
  });
  offerEditorUndo(editor, (t) => appliedText(t, changed), pageUndoPlace);
  return changed;
}

// Setting the assistant's changes aside before writing them as the editor's own: no Undo tracks it.
class SettingAside {}

/** The assistant's changes, applied: their steps of Undo, and the changes that were taken. */
export interface AppliedAsked {
  followed: FollowedSteps;
  accepted: readonly string[];
}

type AskedApplied = (mindId: string, requests: ReadonlySet<string>, asked: AppliedAsked) => void;

const applied = new Set<AskedApplied>();

function followCoreUndo(
  edit: Applying,
  application: AskedChangeApplication,
  current: boolean,
): FollowedSteps {
  const undoId = application.undoId;
  let state: "done" | "undone" = "done";
  let onTop = current;
  let redoable = current;
  let busy = false;
  let listening = true;
  let invalidated = !current;
  let expected: AskedChangeTransition | null = null;
  let pending: Promise<void> = Promise.resolve();
  let lineBeforeUndo: AppliedLine | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const stop = () => {
    if (!listening) return;
    listening = false;
    edit.doc.off("update", changedSince);
  };
  const release = async () => {
    try {
      await core.releaseAskedChanges(undoId);
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
  };
  const invalidate = () => {
    invalidated = true;
    expected = null;
    onTop = false;
    redoable = false;
    stop();
    notify();
  };
  const changedSince = (_update: Uint8Array, origin: unknown) => {
    if (expected) {
      if (coveredBy(edit.doc, expected.vector)) {
        if (
          sameVector(edit.doc, expected.vector) &&
          fingerprintOfMind(edit.doc) !== expected.fingerprint
        ) {
          invalidate();
        }
        return;
      }
      invalidate();
      return;
    }
    if (busy && origin === FROM_CORE) return;
    invalidate();
  };
  const expectUpdate = (transition: AskedChangeTransition) => {
    Y.applyUpdate(edit.doc, transition.update, FROM_CORE);
    if (
      sameVector(edit.doc, transition.vector) &&
      fingerprintOfMind(edit.doc) === transition.fingerprint
    ) {
      expected = transition;
      return;
    }
    invalidate();
  };
  const closed = () => {
    stop();
    stopGone();
    void release();
    notify();
  };
  const clearLine = () => {
    if (!edit.editor.isDestroyed && lastApplied.get(historyOwnerOf(edit.editor)) === edit) {
      setAppliedLine(edit.editor, null);
    }
  };
  const restoreLine = () => {
    if (
      !edit.editor.isDestroyed &&
      lineBeforeUndo &&
      lastApplied.get(historyOwnerOf(edit.editor)) === edit
    ) {
      setAppliedLine(edit.editor, lineBeforeUndo);
    }
  };
  edit.doc.on("update", changedSince);
  const stopGone = onceGone(edit, closed);
  return {
    state: () => (isGone(edit) ? "gone" : state),
    onTop: () => state === "done" && onTop && !isGone(edit),
    canRedo: () => state === "undone" && redoable && !isGone(edit),
    add: invalidate,
    settled: () => pending,
    release,
    undo: () => {
      if (state !== "done" || !onTop || busy) return false;
      busy = true;
      expected = null;
      lineBeforeUndo = edit.editor.isDestroyed ? null : appliedLineIn(edit.editor.state);
      const operation = (async () => {
        try {
          const transition = await core.undoAskedChanges(undoId);
          if (transition) {
            expectUpdate(transition);
            state = "undone";
            redoable = !invalidated;
            clearLine();
            return true;
          }
          onTop = false;
          redoable = false;
          return false;
        } catch (error) {
          onTop = false;
          redoable = false;
          useAppStore.getState().reportError(error);
          return false;
        } finally {
          busy = false;
          notify();
        }
      })();
      pending = operation.then(() => undefined);
      return operation;
    },
    redo: () => {
      if (state !== "undone" || !redoable || busy) return false;
      busy = true;
      expected = null;
      const operation = (async () => {
        try {
          const transition = await core.redoAskedChanges(undoId);
          if (transition) {
            expectUpdate(transition);
            state = "done";
            onTop = !invalidated;
            redoable = !invalidated;
            if (!invalidated) restoreLine();
            return true;
          }
          redoable = false;
          return false;
        } catch (error) {
          redoable = false;
          useAppStore.getState().reportError(error);
          return false;
        } finally {
          busy = false;
          notify();
        }
      })();
      pending = operation.then(() => undefined);
      return operation;
    },
    observe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const coreUndoRegistrations = new WeakMap<
  FollowedSteps,
  { change: Undoable; forget: () => void }
>();

function offerCoreUndo(edit: Applying, followed: FollowedSteps, facts: ChangeCounts): void {
  const change: Undoable = {
    said: (t) => changeFact(t, facts, null),
    shownAt: pageUndoPlace,
    undo: async () => {
      const undone = await followed.undo();
      if (undone === false) throw new UndoRefused((t) => t("edit.undo.changedSince"), null);
    },
    redo: async () => {
      const redone = await followed.redo?.();
      if (redone === false) throw new UndoRefused((t) => t("edit.undo.changedSince"), null);
    },
  };
  const sight = keepInSight(edit.kept, change);
  let stopped = false;
  const forget = () => {
    if (stopped) return;
    stopped = true;
    stopFollowing();
    stopGlobal();
    stopGone();
    sight.stop();
    coreUndoRegistrations.delete(followed);
    useUndo.getState().withdraw(change);
    void followed.release?.();
  };
  const stopFollowing = followed.observe(() => {
    const state = followed.state();
    if (
      state === "gone" ||
      (state === "done" && !followed.onTop()) ||
      (state === "undone" && followed.canRedo && !followed.canRedo())
    ) {
      forget();
    }
  });
  const stopGlobal = useUndo.subscribe((state) => {
    if (
      !state.done.includes(change) &&
      !state.undone.includes(change) &&
      state.running?.change !== change
    ) {
      forget();
    }
  });
  const stopGone = onceGone(edit, forget);
  coreUndoRegistrations.set(followed, { change, forget });
  useUndo.getState().push(change);
  sight.recheck();
}

export function shareCoreUndo(followed: FollowedSteps, change: Undoable): void {
  coreUndoRegistrations.set(followed, {
    change,
    forget: () => {
      coreUndoRegistrations.delete(followed);
      void followed.release?.();
    },
  });
}

export async function undoCoreChange(followed: FollowedSteps): Promise<void> {
  const registered = coreUndoRegistrations.get(followed)?.change;
  if (registered) await useUndo.getState().undo(registered);
  else await followed.undo();
}

export function releaseCoreChange(followed: FollowedSteps): void {
  const registered = coreUndoRegistrations.get(followed);
  if (registered) registered.forget();
  else void followed.release?.();
}

const sameVector = (doc: Y.Doc, expected: Uint8Array): boolean => {
  const wanted = Y.decodeStateVector(expected);
  const now = Y.decodeStateVector(Y.encodeStateVector(doc));
  return (
    wanted.size === now.size && [...wanted].every(([client, clock]) => now.get(client) === clock)
  );
};

const coveredBy = (doc: Y.Doc, expected: Uint8Array): boolean => {
  const wanted = Y.decodeStateVector(expected);
  const now = Y.decodeStateVector(Y.encodeStateVector(doc));
  return [...now].every(([client, clock]) => (wanted.get(client) ?? 0) >= clock);
};

/** Whether an editor matches an accepted core change, can still receive it, or has diverged. */
export function coreApplicationStatus(
  editor: Editor,
  application: AskedChangeApplication,
): "current" | "behind" | "diverged" {
  const doc = editorDoc(editor);
  if (!doc) return "diverged";
  if (sameVector(doc, application.afterVector)) {
    return fingerprintOfMind(doc) === application.afterFingerprint ? "current" : "diverged";
  }
  return coveredBy(doc, application.afterVector) ? "behind" : "diverged";
}

/** Calls `listener` as the changes the User asked for apply: at once, or later from a held line. */
export function onAskedApplied(listener: AskedApplied): () => void {
  applied.add(listener);
  return () => applied.delete(listener);
}

/**
 * Applies the assistant's changes the User asked for (#880), now that
 * they are all in the Mind. An open editor takes them as one Undo step;
 * a core `application` already accepted them and follows the core's Undo
 * and Redo instead. `facts` counts what the line says. A rewrite that would
 * take out most of the User's own text stays waiting with its held line.
 * `turn`: the Answer or request at the Note's foot the changes came from.
 */
export function applyArrived(
  editor: Editor,
  mindId: string,
  requests: ReadonlySet<string>,
  facts: ChangeCounts,
  {
    holds = true,
    checkpoint = holds,
    application,
    retainHeadless = false,
    turn,
  }: {
    holds?: boolean;
    checkpoint?: boolean;
    application?: AskedChangeApplication;
    retainHeadless?: boolean;
    turn?: string;
  } = {},
): "applied" | "held" | null {
  const first = proposalsIn(editor.state.doc).find((each) => requests.has(each.request));
  if ((!first && !application) || editor.isDestroyed) return null;
  for (const request of requests) drawApplying(editor, request, false);
  const doc = editorDoc(editor);
  if ((application?.held || (holds && doc && waitsForUser(doc, requests))) && first) {
    setAppliedLine(editor, {
      kind: "held",
      blockId: topBlockAt(editor.state, first.from),
      request: first.request,
      asked: { mindId, requests: [...requests], facts },
    });
    return "held";
  }
  if (application?.held) {
    const [request] = requests;
    if (!request) return null;
    setAppliedLine(editor, {
      kind: "held",
      blockId: null,
      request,
      asked: { mindId, requests: [...requests], facts },
    });
    return "held";
  }
  const request = first?.request ?? [...requests][0];
  if (!request) return null;
  const accepted = application
    ? application.accepted
    : proposalsIn(editor.state.doc)
        .filter((each) => requests.has(each.request))
        .map((each) => each.id);
  const edit = beginEdit(editor, mindId, `assistant:${request}`);
  if (!edit) return null;
  let planned: ReturnType<typeof planChanges>;
  if (application) {
    planned = [];
    const status = coreApplicationStatus(editor, application);
    if (status === "behind") {
      edit.forget();
      return null;
    }
    const current = status === "current";
    if (current) {
      const reviewDoc = new Y.Doc();
      Y.applyUpdate(reviewDoc, application.reviewBefore);
      try {
        const reviewState = yXmlFragmentToProseMirrorRootNode(
          reviewDoc.getXmlFragment(MIND_CONTENT_FIELD),
          editor.schema,
        );
        planned = planChanges(reviewState, requests, new Set(application.accepted));
      } finally {
        reviewDoc.destroy();
      }
    }
    edit.followed = followCoreUndo(edit, application, current);
  } else {
    // Checkpoint before the change is sent: FIFO IPC runs it before applyMindUpdate (#3839).
    if (checkpoint && checkpointBeforeAccept(edit.doc, requests)) {
      core.saveCheckpoint(mindId, "accept").catch(useAppStore.getState().reportError);
    }
    planned = planChanges(editor.state, requests);
    let resolved: ReturnType<typeof writeAccepted> = [];
    asEditStep(edit, editor, () => {
      resolved = writeAccepted(
        edit.doc,
        requests,
        new SettingAside(),
        new AcceptingEdit(),
        editor.schema,
      );
    });
    const entries = aiUseOfAccepted(edit.doc, mindId, resolved, new Date().toISOString());
    if (entries.length > 0) core.recordAiUse(entries).catch(useAppStore.getState().reportError);
  }
  edit.followed ??= followSteps(editor, edit.steps);
  const changes = editor.isDestroyed
    ? []
    : appliedChanges(editor.state, anchorChanges(editor.state, planned));
  lastApplied.set(historyOwnerOf(editor), edit);
  const { followed } = edit;
  if (followed) {
    for (const listener of applied) listener(mindId, requests, { followed, accepted });
  }
  if (editor.isDestroyed) return "applied";
  const said = namedIn(editor.state, changes, facts, turn);
  setAppliedLine(editor, {
    kind: "applied",
    blockId: firstBlockOf(editor.state, changes),
    blocks: { paragraphs: facts.changed + facts.wrote, tables: facts.tables },
    facts: said,
    reason: null,
    kept: null,
    ...(turn && { turn }),
  });
  if (application) {
    if (followed?.onTop()) {
      if (!retainHeadless) offerCoreUndo(edit, followed, said);
    } else {
      void followed?.release?.();
    }
  } else {
    offerEditorUndo(editor, (t) => changeFact(t, said, null), pageUndoPlace);
  }
  return "applied";
}

/**
 * Applies asked-for changes directly onto a hidden tab's kept Yjs document and Undo stack
 * (#3839): one Undo step in that tab's history, a Checkpoint before it, and its line drawn once
 * the tab shows again.
 */
export function applyArrivedInHistory(
  doc: Y.Doc,
  history: UndoStack,
  mindId: string,
  requests: ReadonlySet<string>,
  facts: ChangeCounts,
  { holds = true, turn }: { holds?: boolean; turn?: string } = {},
): "applied" | "held" | null {
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const stale = outOfDateProposals(blocks);
  const pending = pendingProposals(blocks).filter(
    (each) => requests.has(each.request) && !stale.has(each.id),
  );
  if (pending.length === 0) return null;
  if (holds && waitsForUser(doc, requests)) {
    pendingHidden.set(history, {
      kind: "held",
      mindId,
      requests: [...requests],
      facts,
    });
    followHistory(history, null);
    return "held";
  }
  const request = pending[0]?.request;
  if (!request) return null;
  latest.get(history)?.forget();
  lineWhenHidden.delete(history);
  pendingHidden.delete(history);
  history.addTrackedOrigin(EDIT_FROM_CORE);
  history.addTrackedOrigin(AcceptingEdit);
  history.addToScope([
    ...originMaps(doc),
    doc.getMap(MIND_TEXT_ORIGINS_FIELD),
    doc.getMap(MIND_REVISIONS_FIELD),
  ]);
  const popped = ({ stackItem }: { stackItem: UndoStep }) => {
    if (!edit.steps.includes(stackItem) || latest.get(history) !== edit) return;
    if (edit.editor && !edit.editor.isDestroyed) setAppliedLine(edit.editor, null);
    lineWhenHidden.delete(history);
    pendingHidden.delete(history);
  };
  const takenOut = (steps: ReadonlySet<UndoStep>) => {
    if (!edit.steps.some((step) => steps.has(step)) || latest.get(history) !== edit) return;
    if (edit.editor && !edit.editor.isDestroyed) setAppliedLine(edit.editor, null);
    lineWhenHidden.delete(history);
    pendingHidden.delete(history);
  };
  followHistory(history, null);
  const edit: KeptApplying = {
    requestId: `assistant:${request}`,
    mindId,
    editor: null,
    kept: history,
    doc,
    request: null,
    drawing: null,
    steps: [],
    more: [],
    followed: null,
    leftOut: [],
    stopTaking: () => undefined,
    forget: () => {
      edit.stopTaking();
      history.off("stack-item-popped", popped);
      stopTaken();
      if (latest.get(history) === edit) latest.delete(history);
    },
  };
  history.on("stack-item-popped", popped);
  const stopTaken = onTakenOut(history, takenOut);
  latest.set(history, edit);
  // Checkpoint before the change is sent: FIFO IPC runs it before applyMindUpdate (#3839).
  if (checkpointBeforeAccept(doc, requests)) {
    core.saveCheckpoint(mindId, "accept").catch(useAppStore.getState().reportError);
  }
  const schema = hiddenNoteSchema();
  const planned = planChanges(yXmlFragmentToProseMirrorRootNode(blocks, schema), requests);
  let resolved: ReturnType<typeof writeAccepted> = [];
  history.stopCapturing();
  const before = history.undoStack.at(-1);
  try {
    resolved = writeAccepted(doc, requests, new SettingAside(), new AcceptingEdit(), schema);
  } finally {
    const after = history.undoStack.at(-1);
    if (after && after !== before) edit.steps.push(after);
    history.stopCapturing();
  }
  const entries = aiUseOfAccepted(doc, mindId, resolved, new Date().toISOString());
  if (entries.length > 0) core.recordAiUse(entries).catch(useAppStore.getState().reportError);
  const accepted = resolved.map((each) => each.id);
  edit.followed = followStepsInHistory(history, edit.steps);
  lastApplied.set(history, edit);
  pendingHidden.set(history, {
    kind: "applied",
    edit,
    planned,
    facts,
    ...(turn && { turn }),
  });
  const { followed } = edit;
  if (followed) {
    for (const listener of applied) listener(mindId, requests, { followed, accepted });
  }
  offerHistoryUndo(
    history,
    (t) => changeFact(t, facts, null),
    pageUndoPlace,
    undefined,
    undefined,
    {
      silent: true,
    },
  );
  return "applied";
}

const topBlockAt = (state: EditorState, pos: number): string | null => {
  const id: unknown = state.doc.maybeChild(state.doc.resolve(pos).index(0))?.attrs[
    BLOCK_ID_ATTRIBUTE
  ];
  return typeof id === "string" ? id : null;
};

/** Applies the edit once it is back, or leaves it waiting when the core held it back. */
export async function finishApplying(
  edit: Applying,
  result: EditWithAiResult,
): Promise<{ applied: ChangedBlocks } | "held" | "late" | null> {
  if (result.kind !== "proposed") {
    edit.stopTaking();
    edit.drawing = null;
    if (edit.request) drawApplying(edit.editor, edit.request, false);
    dropSteps(edit);
    return null;
  }
  edit.request ??= result.request;
  const arrival = await whenArrived(edit, result.request, result.stateVector);
  edit.stopTaking();
  edit.drawing = null;
  drawApplying(edit.editor, result.request, false);
  // What came waits as changes to review, and what comes later joins them: nothing is lost.
  if (arrival === "late") return "late";
  if (arrival === "closed") {
    // Its tab showing something else as it came back, it waits to be reviewed: no step of the
    // Note's Undo takes it out unseen.
    dropSteps(edit);
    return null;
  }
  if (arrival !== "arrived") return null;
  edit.leftOut = result.leftOut ?? [];
  if (result.held) {
    const first = ofRequest(edit.editor.state, result.request)[0];
    const index = first ? edit.editor.state.doc.resolve(first.from).index(0) : -1;
    const id: unknown =
      index >= 0 ? edit.editor.state.doc.maybeChild(index)?.attrs[BLOCK_ID_ATTRIBUTE] : null;
    setAppliedLine(edit.editor, {
      kind: "held",
      blockId: typeof id === "string" ? id : null,
      request: result.request,
    });
    return "held";
  }
  return { applied: apply(edit, edit.editor, result.request, result.parts) };
}

function undoEdit(editor: Editor): void {
  const owner = historyOwnerOf(editor);
  const edit = latest.get(owner);
  if (!edit?.followed?.onTop()) return;
  void undoCoreChange(edit.followed);
  setAppliedLine(editor, null);
}

function resolveHeld(editor: Editor, outcome: "accept" | "reject"): void {
  const line = appliedLineIn(editor.state);
  if (line?.kind !== "held") return;
  const edit = latest.get(historyOwnerOf(editor));
  const heldIn = line.asked?.mindId ?? (edit?.request === line.request ? edit.mindId : null);
  // Applied now, a change held back is accepted: a Checkpoint first, whoever wrote it (#113).
  // Not awaited: the core takes it before the change this sends next.
  if (outcome === "accept" && heldIn !== null) {
    core.saveCheckpoint(heldIn, "accept").catch(useAppStore.getState().reportError);
  }
  if (line.asked && outcome === "accept") {
    const { mindId, requests, facts } = line.asked;
    setAppliedLine(editor, null);
    if (applyArrived(editor, mindId, new Set(requests), facts, { holds: false }) === "applied") {
      speak(mindId, changeFact(t, facts, null));
    }
    return;
  }
  if (outcome === "accept" && edit?.request === line.request) {
    const changed = apply(edit, editor, line.request);
    if (changed.paragraphs + changed.tables > 0) speak(edit.mindId, appliedMessage(changed));
    return;
  }
  const asked = new Set(line.asked?.requests ?? [line.request]);
  const ids = new Set(
    proposalsIn(editor.state.doc)
      .filter((each) => asked.has(each.request))
      .map((each) => each.id),
  );
  const count = resolveInEditor(editor, ids, outcome).length;
  setAppliedLine(editor, null);
  if (count > 0) {
    offerEditorUndo(editor, (t) =>
      count === 1 ? t("proposal.rejected.one") : t("proposal.rejected", { count }),
    );
  }
}

function removeKept(editor: Editor): void {
  const edit = latest.get(historyOwnerOf(editor));
  const line = appliedLineIn(editor.state);
  if (!edit || line?.kind !== "applied" || editor.isDestroyed) return;
  const { doc } = editor.state;
  const tr = editor.state.tr;
  const ranges = edit.leftOut
    .flatMap((part) => {
      const block = blockAt(doc, part.blockId);
      if (!block) return [];
      return part.whole
        ? [{ from: block.pos, to: block.pos + block.node.nodeSize }]
        : [{ from: block.pos + 1 + part.from, to: block.pos + 1 + part.to }];
    })
    .sort((a, b) => b.from - a.from);
  for (const range of ranges) tr.deleteRange(range.from, range.to);
  tr.setMeta(appliedLineKey, { ...line, kept: null });
  asOneStep(editor, () => editor.view.dispatch(tr));
  const top = undoStackOf(editor)?.undoStack.at(-1);
  if (top && !edit.steps.includes(top)) {
    edit.more.push(top);
    edit.followed?.add(top);
  }
  offerEditorUndo(editor, (t) => t("edit.kept.removed"));
}

export function actOnAppliedEdit(editor: Editor, action: AppliedAction): void {
  switch (action) {
    case "undo":
      undoEdit(editor);
      return;
    case "apply":
      resolveHeld(editor, "accept");
      return;
    case "discard":
      resolveHeld(editor, "reject");
      return;
    case "remove-kept":
      removeKept(editor);
      return;
  }
}

function agentChangeFacts(change: AgentNoteChange): ChangeCounts {
  return {
    created: false,
    changed: change.changed,
    wrote: change.added,
    tables: change.tables,
    ...(change.removed && { removed: change.removed }),
    ...(change.named && { named: change.named }),
  };
}

function agentAppliedLine(change: AgentNoteChange): AppliedLine {
  const facts = agentChangeFacts(change);
  return {
    kind: "applied",
    blockId: change.firstBlockId ?? null,
    blocks: { paragraphs: change.changed + change.added, tables: change.tables },
    facts,
    reason: null,
    kept: null,
  };
}

/**
 * Shows (or queues for a hidden tab) the inline applied-edit line for an outside agent's edit
 * captured onto a tab's kept `Y.UndoManager` (#3839).
 */
export function showCapturedAgentLine(
  history: UndoStack,
  doc: Y.Doc,
  step: UndoStep,
  steps: NoteSteps,
  change: AgentNoteChange,
): void {
  const line = agentAppliedLine(change);
  latest.get(history)?.forget();
  lineWhenHidden.delete(history);
  pendingHidden.delete(history);
  const currentEditor = historyEditor(history);
  followHistory(history, currentEditor);
  const clear = () => {
    if (latest.get(history) !== edit) return;
    if (edit.editor && !edit.editor.isDestroyed) setAppliedLine(edit.editor, null);
    lineWhenHidden.delete(history);
    pendingHidden.delete(history);
  };
  const popped = ({ stackItem }: { stackItem: UndoStep }) => {
    if (edit.steps.includes(stackItem)) clear();
  };
  const takenOut = (removed: ReadonlySet<UndoStep>) => {
    if (edit.steps.some((each) => removed.has(each))) clear();
  };
  const stopStepWatch = steps.observe(() => {
    if (!steps.onTop()) clear();
  });
  const edit: KeptApplying = {
    requestId: `agent-own:${change.step ?? ""}`,
    mindId: change.mindId,
    editor: currentEditor,
    kept: history,
    doc,
    request: null,
    drawing: null,
    steps: [step],
    more: [],
    followed: steps,
    leftOut: [],
    stopTaking: () => undefined,
    forget: () => {
      stopStepWatch();
      history.off("stack-item-popped", popped);
      stopTaken();
      if (latest.get(history) === edit) latest.delete(history);
    },
  };
  history.on("stack-item-popped", popped);
  const stopTaken = onTakenOut(history, takenOut);
  latest.set(history, edit);
  lastApplied.set(history, edit);
  if (currentEditor && !currentEditor.isDestroyed) {
    setAppliedLine(currentEditor, line);
  } else {
    pendingHidden.set(history, { kind: "applied-line", edit, line });
  }
}

/**
 * Draws the inline applied-edit line when opening a Note that an outside agent edited while closed,
 * wired directly to the core Undo step (`undoable`) so clicking Undo or pressing ⌘Z takes it back
 * in one step (#3839).
 */
export function showClosedAgentLine(
  editor: Editor,
  change: AgentNoteChange,
  undoable: Undoable,
): void {
  const edit = beginEdit(editor, change.mindId, `agent-closed:${change.step ?? ""}`);
  if (!edit) return;
  const line = agentAppliedLine(change);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let stopped = false;
  const isOnTop = () => !stopped && !isGone(edit) && useUndo.getState().done.includes(undoable);
  const clearLine = () => {
    if (!edit.editor.isDestroyed && lastApplied.get(historyOwnerOf(edit.editor)) === edit) {
      setAppliedLine(edit.editor, null);
    }
    if (edit.kept) lineWhenHidden.delete(edit.kept);
  };
  const stopAll = () => {
    if (stopped) return;
    stopped = true;
    stopUndoWatch();
    edit.doc.off("update", onDocEdit);
    stopGone();
    notify();
  };
  const onDocEdit = (_update: Uint8Array, origin: unknown) => {
    if (origin === FROM_CORE || origin === EDIT_FROM_CORE) return;
    clearLine();
    stopAll();
    edit.forget();
  };
  const stopUndoWatch = useUndo.subscribe((state) => {
    if (!state.done.includes(undoable)) {
      clearLine();
      stopAll();
      edit.forget();
    }
  });
  const stopGone = onceGone(edit, stopAll);
  edit.doc.on("update", onDocEdit);
  const previousForget = edit.forget;
  edit.forget = () => {
    stopAll();
    previousForget();
  };
  edit.followed = {
    state: () =>
      isGone(edit) ? "gone" : useUndo.getState().done.includes(undoable) ? "done" : "undone",
    onTop: isOnTop,
    add: () => undefined,
    undo: async () => {
      if (!isOnTop()) return false;
      await useUndo.getState().undo(undoable);
      return true;
    },
    observe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  lastApplied.set(historyOwnerOf(editor), edit);
  setAppliedLine(editor, line);
}

/**
 * Restores or shows the held `AppliedEditLine` ("Apply · Discard") whenever a Note holds pending
 * outside-agent Proposals that were held because they rewrite most of the User's own text,
 * including after closing and reopening the Note or restarting the app (#3839).
 */
export function syncHeldOutsideProposals(mindId: string, editor: Editor): void {
  if (editor.isDestroyed) return;
  const current = appliedLineIn(editor.state);
  if (current !== null && current.kind !== "applied" && current.kind !== "held") return;
  const doc = editorDoc(editor);
  if (!doc) return;
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const pending = pendingProposals(blocks);
  if (pending.length === 0) return;
  const seen = new Set<string>();
  const held: string[] = [];
  for (const ref of pending) {
    if (seen.has(ref.request)) continue;
    seen.add(ref.request);
    const made = proposalRequestOf(doc, ref.request);
    if (made?.source !== "outside-agent") continue;
    if (
      made.held === true ||
      (made.requested === "edit" && waitsForUser(doc, new Set([ref.request])))
    ) {
      held.push(ref.request);
    }
  }
  if (held.length === 0) return;
  if (current?.kind === "held") {
    const shown = new Set(current.asked?.requests ?? [current.request]);
    if (held.every((request) => shown.has(request))) return;
  }
  const heldSet = new Set(held);
  const first = proposalsIn(editor.state.doc).find((each) => heldSet.has(each.request));
  if (!first) return;
  const summary = summarizeProposalChanges(blocks, (ref) => heldSet.has(ref.request));
  const facts: ChangeCounts = {
    created: false,
    changed: summary.changed,
    wrote: summary.added,
    tables: summary.tables,
    ...(summary.removed && { removed: summary.removed }),
    ...(summary.named && { named: summary.named }),
  };
  setAppliedLine(editor, {
    kind: "held",
    blockId: topBlockAt(editor.state, first.from),
    request: first.request,
    asked: { mindId, requests: held, facts },
  });
}
