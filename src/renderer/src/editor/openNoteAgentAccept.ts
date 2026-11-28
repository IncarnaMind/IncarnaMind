/**
 * Handles main-process `OpenNoteWriteRequest` calls on the mounted editor's UI thread (#3839):
 * flushes in-flight typing before a write, refuses without touching the DOM while the User is
 * composing (IME) or edited meanwhile, and accepts fresh Proposals as a single Undo step with a
 * Checkpoint and the inline applied-edit line.
 */
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../../core/api";
import type { OpenNoteWriteRequest } from "../../../shared/bridge";
import type {
  OpenNoteAcceptInput,
  OpenNoteAcceptResult,
  OpenNotePrepareResult,
} from "../../../shared/openNoteEditor";
import { outOfDateProposals, pendingProposals } from "../../../shared/proposals";
import { applyArrived } from "../appliedEdits";
import type { ChangeCounts } from "../changeFacts";
import { files } from "../core";
import { EDIT_FROM_CORE, FROM_CORE, flushMindUpdates, setComposingGate } from "../mindCopies";
import { mindEditors, onMindEditorOpen } from "./openEditors";
import { editorDoc } from "./proposalReview";

const ARRIVAL_WAIT_MS = 5_000;
const TOKEN_TTL_MS = 60_000;
const COMPOSITION_POLL_MS = 25;

interface Prepared {
  mindId: string;
  editor: Editor;
  doc: Y.Doc;
  gens: ReadonlyMap<Y.Doc, number>;
  timer: ReturnType<typeof setTimeout>;
}

const localGenerations = new WeakMap<Y.Doc, number>();
const observedDocs = new WeakSet<Y.Doc>();
const observedEditors = new WeakSet<Editor>();
const compositionEndWaiters = new Map<string, Set<() => void>>();
const compositionPolls = new Map<string, ReturnType<typeof setInterval>>();
const preparedTokens = new Map<string, Prepared>();
let acceptingLocally = 0;

function bumpLocal(doc: Y.Doc): void {
  localGenerations.set(doc, (localGenerations.get(doc) ?? 0) + 1);
}

function generationOf(doc: Y.Doc): number {
  return localGenerations.get(doc) ?? 0;
}

function stopCompositionPoll(mindId: string): void {
  const timer = compositionPolls.get(mindId);
  if (timer === undefined) return;
  clearInterval(timer);
  compositionPolls.delete(mindId);
}

function ensureCompositionPoll(mindId: string): void {
  if (compositionPolls.has(mindId)) return;
  const timer = setInterval(() => {
    const waiters = compositionEndWaiters.get(mindId);
    if (!waiters || waiters.size === 0) {
      stopCompositionPoll(mindId);
      return;
    }
    if (!anyComposing(mindId)) notifyCompositionEnd(mindId);
  }, COMPOSITION_POLL_MS);
  compositionPolls.set(mindId, timer);
}

function notifyCompositionEnd(mindId: string): void {
  const waiters = compositionEndWaiters.get(mindId);
  if (!waiters || waiters.size === 0) {
    stopCompositionPoll(mindId);
    return;
  }
  if (anyComposing(mindId)) return;
  // Flush committed IME DOM text into ProseMirror before draining deferred remote updates.
  for (const editor of mindEditors(mindId)) flushDomObserver(editor.view);
  if (anyComposing(mindId)) return;
  stopCompositionPoll(mindId);
  compositionEndWaiters.delete(mindId);
  for (const run of waiters) run();
}

function watchEditor(mindId: string, editor: Editor): void {
  if (observedEditors.has(editor)) return;
  observedEditors.add(editor);
  const doc = editorDoc(editor);
  if (doc && !observedDocs.has(doc)) {
    observedDocs.add(doc);
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (acceptingLocally > 0 || origin === FROM_CORE || origin === EDIT_FROM_CORE) return;
      bumpLocal(doc);
    });
  }
  const onStart = () => {
    const current = editorDoc(editor);
    if (current) bumpLocal(current);
  };
  const onEnd = () => {
    const current = editorDoc(editor);
    if (current) bumpLocal(current);
    queueMicrotask(() => notifyCompositionEnd(mindId));
  };
  const onTransaction = () => {
    if (compositionEndWaiters.has(mindId) && !anyComposing(mindId)) {
      queueMicrotask(() => notifyCompositionEnd(mindId));
    }
  };
  const dom = editor.view.dom;
  dom.addEventListener("compositionstart", onStart);
  dom.addEventListener("compositionend", onEnd);
  editor.on("transaction", onTransaction);
  editor.once("destroy", () => {
    dom.removeEventListener("compositionstart", onStart);
    dom.removeEventListener("compositionend", onEnd);
    editor.off("transaction", onTransaction);
    queueMicrotask(() => notifyCompositionEnd(mindId));
  });
}

function editableEditors(mindId: string): Editor[] {
  const list = mindEditors(mindId).filter((editor) => editor.isEditable);
  for (const editor of list) watchEditor(mindId, editor);
  return list;
}

function flushEditableEditors(mindId: string): void {
  for (const editor of editableEditors(mindId)) flushDomObserver(editor.view);
}

function primaryEditor(editors: readonly Editor[]): Editor | null {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  for (const editor of editors) {
    if (editor.isFocused || (active !== null && editor.view.dom.contains(active))) return editor;
  }
  return editors[0] ?? null;
}

function snapshotGens(editors: readonly Editor[]): Map<Y.Doc, number> {
  const map = new Map<Y.Doc, number>();
  for (const editor of editors) {
    const doc = editorDoc(editor);
    if (doc && !map.has(doc)) map.set(doc, generationOf(doc));
  }
  return map;
}

function anyLocalEditSince(mindId: string, gens: ReadonlyMap<Y.Doc, number>): boolean {
  for (const [doc, before] of gens) {
    if (generationOf(doc) !== before) return true;
  }
  for (const editor of editableEditors(mindId)) {
    const doc = editorDoc(editor);
    if (!doc || !gens.has(doc)) return true;
  }
  return false;
}

function anyComposing(mindId: string): boolean {
  return mindEditors(mindId).some((editor) => editor.view.composing);
}

function releasePrepared(token: string): Prepared | null {
  const entry = preparedTokens.get(token);
  if (!entry) return null;
  clearTimeout(entry.timer);
  preparedTokens.delete(token);
  return entry;
}

function waitForVector(
  doc: Y.Doc,
  stateVector: Uint8Array,
  editor: Editor,
  isBusy: () => boolean,
): Promise<"arrived" | "changed" | "not-open"> {
  const wanted = Y.decodeStateVector(stateVector);
  const reached = () =>
    [...wanted].every(([client, clock]) => Y.getState(doc.store, client) >= clock);
  return new Promise((resolve) => {
    if (editor.isDestroyed || !editor.isEditable) {
      resolve("not-open");
      return;
    }
    if (isBusy()) {
      resolve("changed");
      return;
    }
    if (reached()) {
      resolve("arrived");
      return;
    }
    const done = (outcome: "arrived" | "changed" | "not-open") => {
      clearTimeout(timer);
      doc.off("afterTransaction", check);
      editor.off("destroy", onDestroy);
      editor.view.dom.removeEventListener("compositionstart", onCompose);
      resolve(outcome);
    };
    const check = () => {
      if (editor.isDestroyed || !editor.isEditable) done("not-open");
      else if (isBusy()) done("changed");
      else if (reached()) done("arrived");
    };
    const onDestroy = () => done("not-open");
    const onCompose = () => done("changed");
    const timer = setTimeout(
      () => done(reached() && !isBusy() ? "arrived" : "changed"),
      ARRIVAL_WAIT_MS,
    );
    doc.on("afterTransaction", check);
    editor.on("destroy", onDestroy);
    editor.view.dom.addEventListener("compositionstart", onCompose);
  });
}

function flushDomObserver(view: Editor["view"]): void {
  if (!("domObserver" in view)) return;
  const observer = (view as { domObserver?: unknown }).domObserver;
  if (typeof observer !== "object" || observer === null) return;
  // ProseMirror's flush() is a no-op during its 20ms flushingSoon window; forceFlush() drains it.
  if (
    "forceFlush" in observer &&
    typeof (observer as { forceFlush?: unknown }).forceFlush === "function"
  ) {
    (observer as { forceFlush(): void }).forceFlush();
  }
  if ("flush" in observer && typeof (observer as { flush?: unknown }).flush === "function") {
    (observer as { flush(): void }).flush();
  }
}

export async function prepareOpenNoteWrite(mindId: string): Promise<OpenNotePrepareResult> {
  const editors = editableEditors(mindId);
  if (editors.length === 0) return { open: false };
  if (editors.some((editor) => editor.view.composing)) return { open: true, busy: true };
  for (const editor of editors) flushDomObserver(editor.view);
  if (editors.some((editor) => editor.isDestroyed)) {
    const remaining = editableEditors(mindId);
    if (remaining.length === 0) return { open: false };
  }
  if (anyComposing(mindId)) return { open: true, busy: true };
  const live = editableEditors(mindId);
  const primary = primaryEditor(live);
  const doc = primary ? editorDoc(primary) : null;
  if (!primary || !doc) return { open: false };
  const gens = snapshotGens(live);
  await flushMindUpdates(mindId);
  if (primary.isDestroyed || !primary.isEditable) return { open: false };
  if (anyComposing(mindId) || anyLocalEditSince(mindId, gens)) return { open: true, busy: true };
  const token = crypto.randomUUID();
  const timer = setTimeout(() => preparedTokens.delete(token), TOKEN_TTL_MS);
  preparedTokens.set(token, { mindId, editor: primary, doc, gens, timer });
  return { open: true, busy: false, token };
}

export function verifyOpenNoteWrite(mindId: string, token: string): boolean {
  const prepared = releasePrepared(token);
  if (!prepared || prepared.mindId !== mindId) return false;
  flushEditableEditors(mindId);
  if (anyComposing(mindId) || anyLocalEditSince(mindId, prepared.gens)) return false;
  return true;
}

export async function acceptOpenNoteWrite(
  input: OpenNoteAcceptInput,
): Promise<OpenNoteAcceptResult> {
  const prepared = releasePrepared(input.token);
  if (!prepared || prepared.mindId !== input.mindId) return "not-open";
  const { mindId, editor, doc, gens } = prepared;
  if (editor.isDestroyed || !editor.isEditable) return "not-open";
  const isBusy = () => anyComposing(mindId) || anyLocalEditSince(mindId, gens);
  if (isBusy()) return "changed";
  const arrival = await waitForVector(doc, input.stateVector, editor, isBusy);
  if (arrival !== "arrived") return arrival;
  if (editor.isDestroyed || !editor.isEditable) return "not-open";
  if (isBusy()) return "changed";
  flushEditableEditors(mindId);
  if (editor.isDestroyed || !editor.isEditable) return "not-open";
  if (isBusy()) return "changed";
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const stale = outOfDateProposals(blocks);
  const mine = pendingProposals(blocks).filter((each) => each.request === input.request);
  if (mine.length === 0 || mine.some((each) => stale.has(each.id))) return "changed";
  const facts: ChangeCounts = {
    created: false,
    changed: input.changed,
    wrote: input.added,
    tables: input.tables,
    ...(input.tablesRemoved && { tablesRemoved: true }),
    ...(input.removed && { removed: input.removed }),
    ...(input.named && { named: input.named }),
  };
  let outcome: "applied" | "held" | null = null;
  acceptingLocally += 1;
  try {
    outcome = applyArrived(editor, mindId, new Set([input.request]), facts, {
      holds: false,
      checkpoint: true,
    });
  } finally {
    acceptingLocally -= 1;
  }
  if (outcome !== "applied") return "changed";
  await flushMindUpdates(mindId);
  return "applied";
}

/** Installs the window's composing gate and IPC handler for lossless mounted-editor writes (#3839). */
export function installOpenNoteAgentAccept(): () => void {
  const stopOpenWatch = onMindEditorOpen((mindId, editor) => {
    if (editor.isEditable) watchEditor(mindId, editor);
  });
  setComposingGate({
    isComposing: anyComposing,
    onceNotComposing: (mindId, run) => {
      if (!anyComposing(mindId)) {
        queueMicrotask(() => {
          for (const editor of mindEditors(mindId)) flushDomObserver(editor.view);
          run();
        });
        return () => undefined;
      }
      const set = compositionEndWaiters.get(mindId) ?? new Set<() => void>();
      set.add(run);
      compositionEndWaiters.set(mindId, set);
      for (const editor of mindEditors(mindId)) watchEditor(mindId, editor);
      ensureCompositionPoll(mindId);
      return () => {
        set.delete(run);
        if (set.size === 0 && compositionEndWaiters.get(mindId) === set) {
          compositionEndWaiters.delete(mindId);
          stopCompositionPoll(mindId);
        }
      };
    },
  });
  const handleRequest = (request: OpenNoteWriteRequest) => {
    if (request.kind === "prepare") {
      void prepareOpenNoteWrite(request.mindId).then(
        (result) =>
          files.replyOpenNoteWriteRequest({ kind: "prepare", callId: request.callId, ...result }),
        () =>
          files.replyOpenNoteWriteRequest({ kind: "prepare", callId: request.callId, open: false }),
      );
      return;
    }
    if (request.kind === "verify") {
      let ok = false;
      try {
        ok = verifyOpenNoteWrite(request.mindId, request.token);
      } catch {
        ok = false;
      }
      files.replyOpenNoteWriteRequest({ kind: "verify", callId: request.callId, ok });
      return;
    }
    void acceptOpenNoteWrite(request).then(
      (result) =>
        files.replyOpenNoteWriteRequest({ kind: "accept", callId: request.callId, result }),
      () =>
        files.replyOpenNoteWriteRequest({
          kind: "accept",
          callId: request.callId,
          result: "changed",
        }),
    );
  };
  const stopIpc =
    typeof files?.onOpenNoteWriteRequest === "function"
      ? files.onOpenNoteWriteRequest(handleRequest)
      : () => undefined;
  return () => {
    stopIpc();
    stopOpenWatch();
    setComposingGate(null);
    for (const entry of preparedTokens.values()) clearTimeout(entry.timer);
    preparedTokens.clear();
    for (const timer of compositionPolls.values()) clearInterval(timer);
    compositionPolls.clear();
    compositionEndWaiters.clear();
  };
}
