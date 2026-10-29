/**
 * Edits the User asked for apply at once (#880), the window's side: the
 * editor that asked takes the core's updates in as its own change, then
 * accepts them, all one step of its Undo.
 */
import type { Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  ySyncPluginKey,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  type AskedChangeApplication,
  type AskedChangeTransition,
  BLOCK_ID_ATTRIBUTE,
  type EditCause,
  type EditWithAiResult,
  type LeftOutPart,
  MIND_CONTENT_FIELD,
  type ProposalRef,
} from "../../core/api";
import { waitsForUser } from "../../shared/askedChanges";
import { originMaps } from "../../shared/blockOrigins";
import { fingerprintOfMind } from "../../shared/mindState";
import { mindName } from "../../shared/naming";
import { aiUseOfAccepted, proposalRequestOf, resolveProposals } from "../../shared/proposals";
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
  changeGroupsOf,
  changesLeft,
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
  offerEditorUndo,
  type UndoStep,
  undoStackOf,
} from "./editor/editorUndo";
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
import { showFirstLook } from "./needsLook";
import { useAppStore } from "./store";
import { pageUndoPlace, type Undoable, UndoRefused, useUndo } from "./undo";

// An origin the editor's Undo tracks, and its copy sends to the core.
class AcceptingEdit {}

export interface Applying {
  requestId: string;
  mindId: string;
  editor: Editor;
  doc: Y.Doc;
  request: string | null;
  steps: UndoStep[];
  /** Later steps that belong to it: restoring a change, removing what it left out. */
  more: UndoStep[];
  /** Its steps as Undo and Redo move them, once it applied. */
  followed: FollowedSteps | null;
  leftOut: readonly LeftOutPart[];
  /** What it changed, once it applied. */
  changes: readonly AppliedChange[];
  byAssistant: boolean;
  /** Each change Restore original put back, by the step that did it. */
  restored: Map<AppliedChange, FollowedSteps>;
  stopTaking(): void;
  forget(): void;
}

const latest = new WeakMap<Editor, Applying>();
/**
 * The last edit that applied in each editor, which Review changes shows
 * after its line has gone (#1795), for as long as the editor lives: a
 * newer edit that fails or waits leaves it the last.
 */
const lastApplied = new WeakMap<Editor, Applying>();

function asEditStep(edit: Applying, change: () => void): void {
  const stack = undoStackOf(edit.editor);
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

function foldSteps(edit: Applying): void {
  const stack = undoStackOf(edit.editor);
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
  for (const step of edit.steps) {
    const index = stack?.undoStack.indexOf(step) ?? -1;
    if (index >= 0) stack?.undoStack.splice(index, 1);
  }
  edit.steps = [];
}

function drawApplying(editor: Editor, request: string, applying: boolean): void {
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
    if (cause.apply) drawApplying(editor, cause.request, true);
    asEditStep(edit, () => Y.applyUpdate(edit.doc, update, EDIT_FROM_CORE));
  });
  return edit;
}

function beginEdit(editor: Editor, mindId: string, requestId: string): Applying | null {
  const doc = editorDoc(editor);
  const stack = undoStackOf(editor);
  if (!doc || !stack || editor.isDestroyed) return null;
  latest.get(editor)?.forget();
  setAppliedLine(editor, null);
  stack.addTrackedOrigin(EDIT_FROM_CORE);
  stack.addTrackedOrigin(AcceptingEdit);
  // A change written over Blocks gives them its origin, which its Undo takes back.
  stack.addToScope(originMaps(doc));
  const popped = ({ stackItem }: { stackItem: UndoStep }) => {
    if (edit.steps.includes(stackItem) && latest.get(editor) === edit) setAppliedLine(editor, null);
  };
  const edit: Applying = {
    requestId,
    mindId,
    editor,
    doc,
    request: null,
    steps: [],
    more: [],
    followed: null,
    leftOut: [],
    changes: [],
    byAssistant: false,
    restored: new Map(),
    stopTaking: () => undefined,
    forget: () => {
      edit.stopTaking();
      stack.off("stack-item-popped", popped);
      if (latest.get(editor) === edit) latest.delete(editor);
    },
  };
  stack.on("stack-item-popped", popped);
  latest.set(editor, edit);
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
function apply(edit: Applying, request: string): ChangedBlocks {
  const { editor } = edit;
  const places = changesOf(editor.state, request);
  const blocks = edit.doc.getXmlFragment(MIND_CONTENT_FIELD);
  let resolved: ReturnType<typeof resolveProposals> = [];
  nameOlderCitations(blocks);
  asEditStep(edit, () => {
    edit.doc.transact(() => {
      resolved = resolveProposals(blocks, (ref: ProposalRef) => ref.request === request, "accept");
    }, new AcceptingEdit());
  });
  foldSteps(edit);
  drawApplying(editor, request, false);
  const entries = aiUseOfAccepted(edit.doc, edit.mindId, resolved, new Date().toISOString());
  if (entries.length > 0) core.recordAiUse(entries).catch(useAppStore.getState().reportError);
  if (resolved.length === 0 || editor.isDestroyed) return { paragraphs: 0, tables: 0 };
  const { doc } = editor.state;
  const changes = appliedChanges(editor.state, places);
  edit.followed = followSteps(editor, edit.steps);
  edit.changes = changes;
  lastApplied.set(editor, edit);
  const changed = changedBlocksOf(editor.state, changes);
  setAppliedLine(editor, {
    kind: "applied",
    blockId: firstBlockOf(editor.state, changes),
    blocks: changed,
    reason: reasonOf(edit.doc, request),
    changes,
    kept: keptLineOf(edit.leftOut.filter((part) => blockAt(doc, part.blockId) !== null)),
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
    edit.editor.off("destroy", closed);
    void release();
    notify();
  };
  const clearLine = () => {
    if (!edit.editor.isDestroyed && lastApplied.get(edit.editor) === edit) {
      setAppliedLine(edit.editor, null);
    }
  };
  const restoreLine = () => {
    if (!edit.editor.isDestroyed && lineBeforeUndo && lastApplied.get(edit.editor) === edit) {
      setAppliedLine(edit.editor, lineBeforeUndo);
    }
  };
  edit.doc.on("update", changedSince);
  edit.editor.on("destroy", closed);
  return {
    state: () => (edit.editor.isDestroyed ? "gone" : state),
    onTop: () => state === "done" && onTop && !edit.editor.isDestroyed,
    canRedo: () => state === "undone" && redoable && !edit.editor.isDestroyed,
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
      if (undone === false) throw new UndoRefused((t) => t("edit.review.changedSince"), null);
    },
    redo: async () => {
      const redone = await followed.redo?.();
      if (redone === false) throw new UndoRefused((t) => t("edit.review.changedSince"), null);
    },
  };
  let stopped = false;
  const forget = () => {
    if (stopped) return;
    stopped = true;
    stopFollowing();
    stopGlobal();
    edit.editor.off("destroy", forget);
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
  edit.editor.on("destroy", forget);
  coreUndoRegistrations.set(followed, { change, forget });
  useUndo.getState().push(change);
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
 */
export function applyArrived(
  editor: Editor,
  mindId: string,
  requests: ReadonlySet<string>,
  facts: ChangeCounts,
  {
    holds = true,
    application,
    retainHeadless = false,
  }: { holds?: boolean; application?: AskedChangeApplication; retainHeadless?: boolean } = {},
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
    planned = planChanges(editor.state, requests);
    let resolved: ReturnType<typeof writeAccepted> = [];
    asEditStep(edit, () => {
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
  edit.changes = changes;
  edit.byAssistant = true;
  lastApplied.set(editor, edit);
  const { followed } = edit;
  if (followed) {
    for (const listener of applied) listener(mindId, requests, { followed, accepted });
  }
  if (editor.isDestroyed) return "applied";
  setAppliedLine(editor, {
    kind: "applied",
    blockId: firstBlockOf(editor.state, changes),
    blocks: { paragraphs: facts.changed + facts.wrote, tables: facts.tables },
    facts,
    reason: null,
    changes,
    kept: null,
  });
  if (application) {
    if (followed?.onTop()) {
      if (!retainHeadless) offerCoreUndo(edit, followed, facts);
    } else {
      void followed?.release?.();
    }
  } else {
    offerEditorUndo(editor, (t) => changeFact(t, facts, null), pageUndoPlace);
  }
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
    if (edit.request) drawApplying(edit.editor, edit.request, false);
    dropSteps(edit);
    return null;
  }
  edit.request ??= result.request;
  const arrival = await whenArrived(edit, result.request, result.stateVector);
  edit.stopTaking();
  if (arrival !== "closed") drawApplying(edit.editor, result.request, false);
  // What came waits as changes to review, and what comes later joins them: nothing is lost.
  if (arrival === "late") return "late";
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
  return { applied: apply(edit, result.request) };
}

function undoEdit(editor: Editor): void {
  const edit =
    appliedLineIn(editor.state)?.kind === "review" ? lastApplied.get(editor) : latest.get(editor);
  if (!edit?.followed?.onTop()) return;
  void undoCoreChange(edit.followed);
  setAppliedLine(editor, null);
}

const restoredIn = (edit: Applying) => (change: AppliedChange) =>
  edit.restored.get(change)?.state() === "done";

// Redo of a Restore finishes its step after the editor took the change in: drawn again once it has.
function redrawReview(editor: Editor): void {
  requestAnimationFrame(() => {
    const line = editor.isDestroyed ? null : appliedLineIn(editor.state);
    if (line?.kind === "review") setAppliedLine(editor, { ...line });
  });
}

/**
 * Whether Review changes is there for the editor's last applied edit (and,
 * given `followed`, for that one): it is still done, and some change of it
 * can still be restored, its words untouched since.
 */
export function canReviewApplied(editor: Editor, followed?: FollowedSteps | null): boolean {
  const edit = lastApplied.get(editor);
  if (editor.isDestroyed || !edit?.followed) return false;
  if (followed !== undefined && followed !== edit.followed) return false;
  const kind = appliedLineIn(editor.state)?.kind;
  if (kind === "held" || kind === "running" || edit.followed.state() !== "done") return false;
  const restored = restoredIn(edit);
  const left = edit.changes.filter((change) => !restored(change));
  return changeGroupsOf(editor.state, left).some((group) => group.restorable);
}

/** Whether ⌘K and the Mind's ⋯ offer Review changes: it is there, and not already showing. */
export const offersReview = (editor: Editor): boolean =>
  canReviewApplied(editor) && appliedLineIn(editor.state)?.kind !== "review";

/** Review changes for the editor's last applied edit, at its first change: from its line, ⌘K, the Mind's ⋯ and the assistant's card. */
export function reviewApplied(editor: Editor, { focus = false } = {}): void {
  const edit = lastApplied.get(editor);
  if (!edit || !canReviewApplied(editor)) return;
  const { followed, changes } = edit;
  const mind = useAppStore.getState().minds.find((each) => each.id === edit.mindId);
  const restored = restoredIn(edit);
  const shows = (change: AppliedChange) => followed?.state() === "done" && !restored(change);
  const left = changes.filter(shows);
  setAppliedLine(editor, {
    kind: "review",
    blockId: firstBlockOf(editor.state, left),
    changes,
    shows,
    ...(edit.byAssistant && { byAssistant: true }),
    ...(followed && {
      undo: { available: () => followed.onTop(), mind: mind ? mindName(mind) : t("mind.untitled") },
    }),
  });
  const first = left
    .map((change) => placeOfChange(editor.state, change))
    .find((place) => place !== null);
  const chain = focus ? editor.chain().focus() : editor.chain();
  if (first) chain.setTextSelection(first.from).scrollIntoView().run();
}

/** The group of changes shown again whose words the cursor is in, by its place among the line's groups. */
export function reviewedChangeAt(state: EditorState): number | null {
  const line = appliedLineIn(state);
  if (line?.kind !== "review") return null;
  const { from } = state.selection;
  const index = changeGroupsOf(state, changesLeft(line)).findIndex(
    (group) => group.from <= from && from <= group.to,
  );
  return index >= 0 ? index : null;
}

/** Whether the group the cursor is in can be restored: the User hasn't changed it since. */
export function restorableAt(state: EditorState): boolean {
  const line = appliedLineIn(state);
  const index = reviewedChangeAt(state);
  return (
    line?.kind === "review" &&
    index !== null &&
    changeGroupsOf(state, changesLeft(line))[index]?.restorable === true
  );
}

/**
 * Restore original: a group's old words back in place of its new ones, one
 * step of Undo. Never over words the User changed since: those show "You
 * changed this since" and have no Restore.
 */
export function restoreChange(editor: Editor, index: number): void {
  const line = appliedLineIn(editor.state);
  const group =
    line?.kind === "review" ? changeGroupsOf(editor.state, changesLeft(line))[index] : undefined;
  if (line?.kind !== "review" || !group?.restorable || editor.isDestroyed) return;
  const tr = editor.state.tr;
  // Last first, so the places of the ones before it hold.
  const lastFirst = [...group.members].sort(
    (a, b) => b.place.from - a.place.from || b.index - a.index,
  );
  for (const { change, place } of lastFirst) tr.replaceWith(place.from, place.to, change.removed);
  // Until the change reaches the Mind's document its Yjs place is read against the text before it.
  const restoring = new Set(group.members.map(({ change }) => change));
  tr.setMeta(appliedLineKey, {
    ...line,
    shows: (change: AppliedChange) => !restoring.has(change) && (line.shows?.(change) ?? true),
  });
  asOneStep(editor, () => editor.view.dispatch(tr));
  const top = undoStackOf(editor)?.undoStack.at(-1);
  const edit = lastApplied.get(editor);
  if (top && edit) {
    edit.more.push(top);
    edit.followed?.add(top);
    const back = followSteps(editor, [top]);
    back?.observe(() => redrawReview(editor));
    if (back) for (const { change } of group.members) edit.restored.set(change, back);
  }
  // Placed again now that the change has reached the Mind's document.
  const now = appliedLineIn(editor.state);
  if (now?.kind === "review") setAppliedLine(editor, { ...now, shows: line.shows });
  offerEditorUndo(editor, (t) => t("edit.review.restored.one"));
}

function resolveHeld(editor: Editor, outcome: "accept" | "reject"): void {
  const line = appliedLineIn(editor.state);
  if (line?.kind !== "held") return;
  if (line.asked && outcome === "accept") {
    const { mindId, requests, facts } = line.asked;
    setAppliedLine(editor, null);
    if (applyArrived(editor, mindId, new Set(requests), facts, { holds: false }) === "applied") {
      speak(mindId, changeFact(t, facts, null));
    }
    return;
  }
  const edit = latest.get(editor);
  if (outcome === "accept" && edit?.request === line.request) {
    const changed = apply(edit, line.request);
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
  const edit = latest.get(editor);
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
    case "undo-all":
      undoEdit(editor);
      return;
    case "review":
      reviewApplied(editor);
      return;
    case "done":
      setAppliedLine(editor, null);
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
    case "look": {
      const line = appliedLineIn(editor.state);
      if (line?.kind === "applied") showFirstLook(editor, line.facts?.lookIn ?? []);
      return;
    }
  }
}
