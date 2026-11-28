/**
 * Handles main-process `OpenNoteWriteRequest` calls on the mounted editor's UI thread (#3839):
 * flushes in-flight typing before a write, waits briefly for active IME composition or unrelated
 * typing to settle without touching the DOM during IME, refuses cleanly when a targeted paragraph
 * changed or busy state outlasts the settle window, and accepts fresh Proposals as a single Undo
 * step with a Checkpoint and the inline applied-edit line.
 */
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../../../core/api";
import type { OpenNoteWriteRequest } from "../../../shared/bridge";
import { markValueOf } from "../../../shared/markKeys";
import type {
  OpenNoteAcceptInput,
  OpenNoteAcceptResult,
  OpenNotePrepareResult,
} from "../../../shared/openNoteEditor";
import {
  outOfDateProposals,
  pendingProposals,
  readProposalAttribute,
  readProposalRef,
} from "../../../shared/proposals";
import { applyArrived } from "../appliedEdits";
import type { ChangeCounts } from "../changeFacts";
import { files } from "../core";
import { EDIT_FROM_CORE, FROM_CORE, flushMindUpdates, setComposingGate } from "../mindCopies";
import { setAppliedLine } from "./appliedEditLine";
import { mindEditors, onMindEditorOpen } from "./openEditors";
import { editorDoc } from "./proposalReview";

const ARRIVAL_WAIT_MS = 5_000;
const TOKEN_TTL_MS = 60_000;
const COMPOSITION_POLL_MS = 25;
const DEFAULT_SETTLE_WAIT_MS = 1_500;
const DEFAULT_TYPING_QUIET_MS = 150;
const MAX_EDIT_LOG_ENTRIES = 100;

interface Prepared {
  mindId: string;
  editor: Editor;
  doc: Y.Doc;
  gens: ReadonlyMap<Y.Doc, number>;
  timer: ReturnType<typeof setTimeout>;
}

interface DocEditLog {
  gen: number;
  lastEditAt: number;
  oldestKeptGen: number;
  entries: { gen: number; blocks: readonly string[] }[];
}

export interface OpenNoteSettleOptions {
  settleWaitMs?: number;
  typingQuietMs?: number;
}

const docEditLogs = new WeakMap<Y.Doc, DocEditLog>();
const observedDocs = new WeakSet<Y.Doc>();
const observedEditors = new WeakSet<Editor>();
const compositionEndWaiters = new Map<string, Set<() => void>>();
const compositionPolls = new Map<string, ReturnType<typeof setInterval>>();
const preparedTokens = new Map<string, Prepared>();
const cancelledRequests = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightCancels = new Map<string, Set<() => void>>();
let acceptingLocally = 0;

function recordLocalEdit(doc: Y.Doc, blocks: readonly string[]): void {
  let log = docEditLogs.get(doc);
  if (!log) {
    log = { gen: 0, lastEditAt: 0, oldestKeptGen: 0, entries: [] };
    docEditLogs.set(doc, log);
  }
  log.gen += 1;
  log.lastEditAt = Date.now();
  log.entries.push({ gen: log.gen, blocks });
  if (log.entries.length > MAX_EDIT_LOG_ENTRIES) {
    const trimmed = log.entries.splice(0, log.entries.length - MAX_EDIT_LOG_ENTRIES);
    const lastTrimmed = trimmed.at(-1);
    if (lastTrimmed) log.oldestKeptGen = Math.max(log.oldestKeptGen, lastTrimmed.gen);
  }
}

function generationOf(doc: Y.Doc): number {
  return docEditLogs.get(doc)?.gen ?? 0;
}

function blockIdAtPos(doc: ProseMirrorNode, pos: number): string | null {
  if (doc.childCount === 0) return null;
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const index = doc.resolve(clamped).index(0);
  const child = doc.maybeChild(Math.min(index, doc.childCount - 1));
  const id: unknown = child?.attrs[BLOCK_ID_ATTRIBUTE];
  return typeof id === "string" && id !== "" ? id : null;
}

function touchedBlockIds(transaction: Transaction): string[] {
  const before = transaction.before;
  const after = transaction.doc;
  if (before.childCount !== after.childCount) return ["*"];
  const ids = new Set<string>();
  let current = before;
  for (let i = 0; i < transaction.steps.length; i++) {
    const step = transaction.steps[i];
    const map = transaction.mapping.maps[i];
    const next = transaction.docs[i + 1] ?? after;
    if (!step || !map) continue;
    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      const beforeId = blockIdAtPos(current, oldStart);
      const beforeEndId = blockIdAtPos(current, Math.max(oldStart, oldEnd - 1));
      const afterId = blockIdAtPos(next, newStart);
      const afterEndId = blockIdAtPos(next, Math.max(newStart, newEnd - 1));
      if (!beforeId || !beforeEndId || !afterId || !afterEndId) {
        ids.add("*");
        return;
      }
      ids.add(beforeId);
      ids.add(beforeEndId);
      ids.add(afterId);
      ids.add(afterEndId);
    });
    current = next;
  }
  return ids.size > 0 ? [...ids] : ["*"];
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

function subscribeCompositionEnd(mindId: string, run: () => void): () => void {
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
}

function registerCancel(request: string, onCancel: () => void): () => void {
  const set = inFlightCancels.get(request) ?? new Set<() => void>();
  set.add(onCancel);
  inFlightCancels.set(request, set);
  return () => {
    set.delete(onCancel);
    if (set.size === 0 && inFlightCancels.get(request) === set) inFlightCancels.delete(request);
  };
}

function watchEditor(mindId: string, editor: Editor): void {
  if (observedEditors.has(editor)) return;
  observedEditors.add(editor);
  const doc = editorDoc(editor);
  if (doc && !observedDocs.has(doc)) {
    observedDocs.add(doc);
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      // ProseMirror transactions are classified below so remote-triggered plugin fix-ups never count as typing.
      if (
        acceptingLocally > 0 ||
        origin === FROM_CORE ||
        origin === EDIT_FROM_CORE ||
        origin === ySyncPluginKey
      ) {
        return;
      }
      recordLocalEdit(doc, ["*"]);
    });
  }
  const onEnd = () => {
    queueMicrotask(() => notifyCompositionEnd(mindId));
  };
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (acceptingLocally === 0 && transaction.docChanged) {
      const syncMeta = transaction.getMeta(ySyncPluginKey) as
        | { isChangeOrigin?: boolean; isUndoRedoOperation?: boolean }
        | undefined;
      const fromRemoteSync = syncMeta !== undefined && !syncMeta.isUndoRedoOperation;
      if (!fromRemoteSync && transaction.getMeta("addToHistory") !== false) {
        const current = editorDoc(editor);
        if (current) {
          recordLocalEdit(
            current,
            syncMeta?.isUndoRedoOperation ? ["*"] : touchedBlockIds(transaction),
          );
        }
      }
    }
    if (compositionEndWaiters.has(mindId) && !anyComposing(mindId)) {
      queueMicrotask(() => notifyCompositionEnd(mindId));
    }
  };
  const dom = editor.view.dom;
  dom.addEventListener("compositionend", onEnd);
  editor.on("transaction", onTransaction);
  editor.once("destroy", () => {
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

function localEditStatusSince(
  mindId: string,
  gens: ReadonlyMap<Y.Doc, number>,
): { changed: boolean; structural: boolean; blocks: Set<string>; lastEditAt: number } {
  let changed = false;
  let structural = false;
  let lastEditAt = 0;
  const blocks = new Set<string>();
  for (const [doc, before] of gens) {
    const log = docEditLogs.get(doc);
    if (!log || log.gen === before) continue;
    changed = true;
    lastEditAt = Math.max(lastEditAt, log.lastEditAt);
    if (before < log.oldestKeptGen) {
      structural = true;
      continue;
    }
    for (const entry of log.entries) {
      if (entry.gen <= before) continue;
      for (const blockId of entry.blocks) {
        if (blockId === "*") structural = true;
        else blocks.add(blockId);
      }
    }
  }
  for (const editor of editableEditors(mindId)) {
    const doc = editorDoc(editor);
    if (!doc || !gens.has(doc)) {
      changed = true;
      structural = true;
    }
  }
  return { changed, structural, blocks, lastEditAt };
}

function targetedTopBlockIds(blocks: Y.XmlFragment, request: string): Set<string> | null {
  const ids = new Set<string>();
  const topArray = blocks.toArray();
  const idOfTop = (index: number): string | null => {
    const node = topArray[index];
    if (!(node instanceof Y.XmlElement)) return null;
    const id = node.getAttribute(BLOCK_ID_ATTRIBUTE);
    return typeof id === "string" && id !== "" ? id : null;
  };
  const containsRequest = (node: Y.XmlElement | Y.XmlText): boolean => {
    if (node instanceof Y.XmlText) {
      const delta: unknown = node.toDelta();
      if (!Array.isArray(delta)) return false;
      return delta.some((run: unknown) => {
        if (typeof run !== "object" || run === null) return false;
        const attrs = (run as { attributes?: Record<string, unknown> }).attributes;
        if (!attrs) return false;
        const ins = readProposalRef(markValueOf(PROPOSAL_INSERT_MARK, attrs));
        const del = readProposalRef(markValueOf(PROPOSAL_DELETE_MARK, attrs));
        return ins?.request === request || del?.request === request;
      });
    }
    const prop = readProposalAttribute(node.getAttribute(PROPOSAL_ATTRIBUTE));
    if (prop?.request === request) return true;
    return node
      .toArray()
      .some((child) =>
        child instanceof Y.XmlElement || child instanceof Y.XmlText
          ? containsRequest(child)
          : false,
      );
  };
  for (let i = 0; i < topArray.length; i++) {
    const child = topArray[i];
    if (!(child instanceof Y.XmlElement)) continue;
    const prop = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
    if (prop?.request === request && prop.kind === "insert") {
      const prevId = i > 0 ? idOfTop(i - 1) : null;
      const nextId = i + 1 < topArray.length ? idOfTop(i + 1) : null;
      const selfId = idOfTop(i);
      if (prevId) ids.add(prevId);
      if (nextId) ids.add(nextId);
      if (selfId) ids.add(selfId);
      continue;
    }
    if (containsRequest(child)) {
      const id = idOfTop(i);
      if (!id) return null;
      ids.add(id);
    }
  }
  return ids;
}

function anyComposing(mindId: string): boolean {
  return mindEditors(mindId).some((editor) => editor.view.composing);
}

function waitForCompositionEnd(
  mindId: string,
  maxWaitMs: number,
  request?: string,
): Promise<"ended" | "timeout" | "cancelled"> {
  if (!anyComposing(mindId)) return Promise.resolve("ended");
  if (request !== undefined && cancelledRequests.has(request)) return Promise.resolve("cancelled");
  if (maxWaitMs <= 0) return Promise.resolve("timeout");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: "ended" | "timeout" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopCompose();
      stopCancel();
      resolve(outcome);
    };
    const stopCompose = subscribeCompositionEnd(mindId, () => finish("ended"));
    const stopCancel =
      request !== undefined ? registerCancel(request, () => finish("cancelled")) : () => undefined;
    const timer = setTimeout(() => finish(anyComposing(mindId) ? "timeout" : "ended"), maxWaitMs);
  });
}

function waitQuiet(waitMs: number, request: string): Promise<"done" | "cancelled"> {
  if (cancelledRequests.has(request)) return Promise.resolve("cancelled");
  if (waitMs <= 0) return Promise.resolve("done");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: "done" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopCancel();
      resolve(outcome);
    };
    const stopCancel = registerCancel(request, () => finish("cancelled"));
    const timer = setTimeout(() => finish("done"), waitMs);
  });
}

function releasePrepared(token: string): Prepared | null {
  const entry = preparedTokens.get(token);
  if (!entry) return null;
  clearTimeout(entry.timer);
  preparedTokens.delete(token);
  return entry;
}

export function cancelOpenNoteWrite(_mindId: string, request: string, token: string): void {
  releasePrepared(token);
  if (request === "") return;
  const existing = cancelledRequests.get(request);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => cancelledRequests.delete(request), TOKEN_TTL_MS);
  cancelledRequests.set(request, timer);
  const callbacks = inFlightCancels.get(request);
  if (callbacks) {
    for (const run of [...callbacks]) run();
  }
}

function waitForVector(
  mindId: string,
  doc: Y.Doc,
  stateVector: Uint8Array,
  editor: Editor,
  request: string,
  deadline: number,
): Promise<"arrived" | "changed" | "not-open"> {
  const wanted = Y.decodeStateVector(stateVector);
  const reached = () =>
    [...wanted].every(([client, clock]) => Y.getState(doc.store, client) >= clock);
  return new Promise((resolve) => {
    if (cancelledRequests.has(request)) {
      resolve("changed");
      return;
    }
    if (editor.isDestroyed || !editor.isEditable) {
      resolve("not-open");
      return;
    }
    if (reached()) {
      resolve("arrived");
      return;
    }
    let settled = false;
    let composeTimer: ReturnType<typeof setTimeout> | null = null;
    const clearComposeTimer = () => {
      if (composeTimer !== null) {
        clearTimeout(composeTimer);
        composeTimer = null;
      }
    };
    const done = (outcome: "arrived" | "changed" | "not-open") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearComposeTimer();
      stopCancel();
      doc.off("afterTransaction", check);
      editor.off("destroy", onDestroy);
      editor.view.dom.removeEventListener("compositionstart", onComposeStart);
      editor.view.dom.removeEventListener("compositionend", onComposeEnd);
      resolve(outcome);
    };
    const armComposeTimer = () => {
      if (composeTimer !== null || !anyComposing(mindId)) return;
      const left = Math.max(0, deadline - Date.now());
      composeTimer = setTimeout(() => {
        composeTimer = null;
        if (anyComposing(mindId)) done("changed");
      }, left);
    };
    const check = () => {
      if (cancelledRequests.has(request)) done("changed");
      else if (editor.isDestroyed || !editor.isEditable) done("not-open");
      else if (reached()) done("arrived");
    };
    const onDestroy = () => done("not-open");
    const onComposeStart = () => armComposeTimer();
    const onComposeEnd = () => {
      if (!anyComposing(mindId)) clearComposeTimer();
    };
    const stopCancel = registerCancel(request, () => done("changed"));
    const timer = setTimeout(() => {
      if (reached()) {
        done("arrived");
        return;
      }
      console.warn(
        `Timed out waiting for staged agent update ${request} on Mind ${mindId} after ${ARRIVAL_WAIT_MS}ms.`,
      );
      done("changed");
    }, ARRIVAL_WAIT_MS);
    doc.on("afterTransaction", check);
    editor.on("destroy", onDestroy);
    editor.view.dom.addEventListener("compositionstart", onComposeStart);
    editor.view.dom.addEventListener("compositionend", onComposeEnd);
    armComposeTimer();
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

export async function prepareOpenNoteWrite(
  mindId: string,
  options: OpenNoteSettleOptions = {},
): Promise<OpenNotePrepareResult> {
  const settleWaitMs = options.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS;
  const editors = editableEditors(mindId);
  if (editors.length === 0) return { open: false };
  if (anyComposing(mindId)) {
    const settled = await waitForCompositionEnd(mindId, settleWaitMs);
    if (settled !== "ended" || anyComposing(mindId)) return { open: true, busy: true };
  }
  const afterCompose = editableEditors(mindId);
  if (afterCompose.length === 0) return { open: false };
  for (const editor of afterCompose) flushDomObserver(editor.view);
  const live = editableEditors(mindId);
  if (live.length === 0) return { open: false };
  if (anyComposing(mindId)) return { open: true, busy: true };
  const primary = primaryEditor(live);
  const doc = primary ? editorDoc(primary) : null;
  if (!primary || !doc) return { open: false };
  const gens = snapshotGens(live);
  const flushed = await flushMindUpdates(mindId);
  if (primary.isDestroyed || !primary.isEditable) return { open: false };
  if (!flushed || anyComposing(mindId) || localEditStatusSince(mindId, gens).changed) {
    return { open: true, busy: true };
  }
  const token = crypto.randomUUID();
  const timer = setTimeout(() => preparedTokens.delete(token), TOKEN_TTL_MS);
  preparedTokens.set(token, { mindId, editor: primary, doc, gens, timer });
  return { open: true, busy: false, token };
}

export function verifyOpenNoteWrite(mindId: string, token: string): boolean {
  const prepared = releasePrepared(token);
  if (!prepared || prepared.mindId !== mindId) return false;
  flushEditableEditors(mindId);
  if (anyComposing(mindId) || localEditStatusSince(mindId, prepared.gens).changed) return false;
  return true;
}

export async function acceptOpenNoteWrite(
  input: OpenNoteAcceptInput,
  options: OpenNoteSettleOptions = {},
): Promise<OpenNoteAcceptResult> {
  const settleWaitMs = options.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS;
  const typingQuietMs = options.typingQuietMs ?? DEFAULT_TYPING_QUIET_MS;
  const deadline = Date.now() + settleWaitMs;
  const prepared = releasePrepared(input.token);
  if (!prepared || prepared.mindId !== input.mindId) return "not-open";
  const { mindId, editor, doc, gens } = prepared;
  if (cancelledRequests.has(input.request)) return "changed";
  if (editor.isDestroyed || !editor.isEditable) return "not-open";
  if (anyComposing(mindId)) {
    const settled = await waitForCompositionEnd(
      mindId,
      Math.max(0, deadline - Date.now()),
      input.request,
    );
    if (settled === "cancelled" || cancelledRequests.has(input.request)) return "changed";
    if (editor.isDestroyed || !editor.isEditable) return "not-open";
    if (anyComposing(mindId)) return "changed";
  }
  const arrival = await waitForVector(
    mindId,
    doc,
    input.stateVector,
    editor,
    input.request,
    deadline,
  );
  if (arrival !== "arrived") return arrival;
  for (;;) {
    if (cancelledRequests.has(input.request)) return "changed";
    if (editor.isDestroyed || !editor.isEditable) return "not-open";
    if (anyComposing(mindId)) {
      const settled = await waitForCompositionEnd(
        mindId,
        Math.max(0, deadline - Date.now()),
        input.request,
      );
      if (settled === "cancelled" || cancelledRequests.has(input.request)) return "changed";
      if (editor.isDestroyed || !editor.isEditable) return "not-open";
      if (anyComposing(mindId)) return "changed";
    }
    flushEditableEditors(mindId);
    if (cancelledRequests.has(input.request)) return "changed";
    if (editor.isDestroyed || !editor.isEditable) return "not-open";
    if (anyComposing(mindId)) {
      if (Date.now() >= deadline) return "changed";
      continue;
    }
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    const stale = outOfDateProposals(blocks);
    const mine = pendingProposals(blocks).filter((each) => each.request === input.request);
    if (mine.length === 0 || mine.some((each) => stale.has(each.id))) return "changed";
    const edits = localEditStatusSince(mindId, gens);
    if (!edits.changed) break;
    const targets = targetedTopBlockIds(blocks, input.request);
    const conflict =
      edits.structural ||
      targets === null ||
      [...edits.blocks].some((blockId) => targets.has(blockId));
    if (conflict) return "changed";
    const quietRemaining = edits.lastEditAt + typingQuietMs - Date.now();
    if (quietRemaining <= 0) break;
    const budget = deadline - Date.now();
    if (budget <= 0) return "changed";
    const waited = await waitQuiet(Math.min(quietRemaining, budget), input.request);
    if (waited === "cancelled") return "changed";
  }
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
      holds: true,
      checkpoint: true,
    });
  } finally {
    acceptingLocally -= 1;
  }
  if (outcome === "held") {
    await flushMindUpdates(mindId);
    return "held";
  }
  if (outcome !== "applied") return "changed";
  const saved = await flushMindUpdates(mindId);
  if (!saved) {
    setAppliedLine(editor, null);
    return "failed";
  }
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
      return subscribeCompositionEnd(mindId, run);
    },
  });
  const handleRequest = (request: OpenNoteWriteRequest) => {
    if (request.kind === "prepare") {
      void prepareOpenNoteWrite(request.mindId).then(
        (result) =>
          files.replyOpenNoteWriteRequest({ kind: "prepare", callId: request.callId, ...result }),
        (error: unknown) => {
          console.error(`Failed to prepare open Note write for Mind ${request.mindId}.`, error);
          files.replyOpenNoteWriteRequest({
            kind: "prepare",
            callId: request.callId,
            open: true,
            busy: true,
          });
        },
      );
      return;
    }
    if (request.kind === "verify") {
      let ok = false;
      try {
        ok = verifyOpenNoteWrite(request.mindId, request.token);
      } catch (error) {
        console.error(`Failed to verify open Note write for Mind ${request.mindId}.`, error);
        ok = false;
      }
      files.replyOpenNoteWriteRequest({ kind: "verify", callId: request.callId, ok });
      return;
    }
    if (request.kind === "cancel") {
      cancelOpenNoteWrite(request.mindId, request.request, request.token);
      return;
    }
    void acceptOpenNoteWrite(request).then(
      (result) =>
        files.replyOpenNoteWriteRequest({ kind: "accept", callId: request.callId, result }),
      (error: unknown) => {
        console.error(
          `Failed to accept open Note write ${request.request} for Mind ${request.mindId}.`,
          error,
        );
        files.replyOpenNoteWriteRequest({
          kind: "accept",
          callId: request.callId,
          result: "changed",
        });
      },
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
    for (const timer of cancelledRequests.values()) clearTimeout(timer);
    cancelledRequests.clear();
    inFlightCancels.clear();
    for (const timer of compositionPolls.values()) clearInterval(timer);
    compositionPolls.clear();
    compositionEndWaiters.clear();
  };
}
