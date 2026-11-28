/**
 * A window's local copy of a Mind's Yjs document, kept in step with the
 * core's: it starts from the core's full state, sends every local change to
 * the core, and applies the changes the core pushes. The editor holds one for
 * the Mind it shows; the assistant's card of changes (#202) holds one for each
 * Mind it accepts or rejects changes in.
 *
 * A Mind the core opens read-only (a newer version wrote it) is only a copy to
 * look at: nothing is ever sent from it.
 */
import * as Y from "yjs";
import type { EditCause, MindAccess } from "../../core/api";
import { clientId } from "./clientId";
import { core } from "./core";
import { describeError } from "./errors";

/** Marks changes that came from the core, so they aren't sent back to it. */
export const FROM_CORE = Symbol("from the core");

/** The core's changes from an edit asked for here (#880): not sent back, but this window's Undo takes them back. */
export const EDIT_FROM_CORE = Symbol("an edit asked for here, from the core");

interface Taker {
  doc: Y.Doc;
  take(update: Uint8Array, cause: EditCause): void;
}

/** Each copy that asked to take an edit's updates, by the edit's request. */
const takers = new Map<string, Set<Taker>>();

/** How many copies of each Mind this window has open: the note's worth one watch, not each. */
const copiesOpen = new Map<string, number>();

interface SentUpdate {
  promise: Promise<boolean>;
}

/** The changes this window sent for each Mind that the core does not have yet. */
const sent = new Map<string, Set<SentUpdate>>();

/**
 * Prevents incoming core updates from mutating a Mind's Yjs document while an open editor for it
 * is mid-IME composition (`view.composing`), draining queued updates once composition ends (#3839).
 */
export interface ComposingGate {
  isComposing(mindId: string): boolean;
  onceNotComposing(mindId: string, run: () => void): () => void;
}

let composingGate: ComposingGate | null = null;

export function setComposingGate(gate: ComposingGate | null): void {
  composingGate = gate;
}

/**
 * Waits until every change this window sent for the Mind has reached the
 * core, for an ask that must see them: a column move, which copies each cell
 * as it is then, the words just typed into one included. Returns false if any
 * flushed save failed without recovering.
 */
export async function flushMindUpdates(mindId: string): Promise<boolean> {
  let ok = true;
  const seen = new Set<SentUpdate>();
  for (;;) {
    const waiting = sent.get(mindId);
    const pending = waiting ? [...waiting].filter((each) => !seen.has(each)) : [];
    if (pending.length === 0) return ok;
    for (const each of pending) seen.add(each);
    const results = await Promise.all(pending.map((each) => each.promise));
    if (results.some((each) => !each)) ok = false;
  }
}

/**
 * Hands the updates of this edit to `take`, in the copy `doc` only: another copy takes them
 * through its own. Returns what stops it.
 */
export function takeEditUpdates(
  requestId: string,
  doc: Y.Doc,
  take: (update: Uint8Array, cause: EditCause) => void,
): () => void {
  const taker = { doc, take };
  const all = takers.get(requestId) ?? new Set<Taker>();
  all.add(taker);
  takers.set(requestId, all);
  return () => {
    all.delete(taker);
    if (all.size === 0 && takers.get(requestId) === all) takers.delete(requestId);
  };
}

export interface OpenedCopy {
  access: MindAccess;
  /** Null when the Mind can't be shown ("update-required"). */
  doc: Y.Doc | null;
}

/**
 * Opens a copy of the Mind: `opened` hears it once its state has arrived,
 * `failed` why it couldn't be opened. Returns what closes it.
 */
export function openMindCopy(
  mindId: string,
  opened: (copy: OpenedCopy) => void,
  failed: (error: unknown) => void,
): () => void {
  const local = new Y.Doc();
  let active = true;
  let closed = false;
  let watching = false;
  let editable = false;
  const deferred: { update: Uint8Array; cause?: EditCause }[] = [];
  let stopWaitingComposition: (() => void) | null = null;
  const applyOne = (update: Uint8Array, cause?: EditCause) => {
    const taker =
      cause && [...(takers.get(cause.requestId) ?? [])].find((each) => each.doc === local);
    if (cause && taker) taker.take(update, cause);
    else Y.applyUpdate(local, update, FROM_CORE);
  };
  const drainDeferred = () => {
    stopWaitingComposition = null;
    if (!active || deferred.length === 0) return;
    if (composingGate?.isComposing(mindId)) {
      stopWaitingComposition = composingGate.onceNotComposing(mindId, drainDeferred);
      return;
    }
    const queued = deferred.splice(0);
    for (const item of queued) applyOne(item.update, item.cause);
  };
  // Listen before opening, so nothing pushed in between is missed. Yjs merges in any order.
  const stopListening = core.on("mind.update", ({ mindId: changed, update, cause }) => {
    if (changed !== mindId) return;
    if (deferred.length > 0 || composingGate?.isComposing(mindId)) {
      deferred.push({ update, cause });
      if (!stopWaitingComposition && composingGate) {
        stopWaitingComposition = composingGate.onceNotComposing(mindId, drainDeferred);
      }
      return;
    }
    applyOne(update, cause);
  });
  // A change that built on one the core never got goes again inside the whole copy (#1119).
  const store = (update: Uint8Array, again: boolean): Promise<boolean> => {
    const entry: SentUpdate = {
      promise: core.applyMindUpdate(mindId, update).then(
        () => true,
        (error: unknown) => {
          const missed = describeError(error).wording?.key === "error.mind.missedChange";
          if (missed && again && active) return store(Y.encodeStateAsUpdate(local), false);
          failed(error);
          return false;
        },
      ),
    };
    const waiting = sent.get(mindId) ?? new Set<SentUpdate>();
    waiting.add(entry);
    sent.set(mindId, waiting);
    void entry.promise.finally(() => {
      waiting.delete(entry);
      if (waiting.size === 0 && sent.get(mindId) === waiting) sent.delete(mindId);
    });
    return entry.promise;
  };
  const send = (update: Uint8Array, origin: unknown) => {
    if (origin !== FROM_CORE && origin !== EDIT_FROM_CORE && editable) void store(update, true);
  };
  local.on("update", send);
  core.openMind(mindId).then(
    ({ state, access }) => {
      if (!active) return;
      if (access === "update-required") {
        opened({ access, doc: null });
        return;
      }
      editable = access === "edit";
      Y.applyUpdate(local, state, FROM_CORE);
      watching = true;
      const copies = copiesOpen.get(mindId) ?? 0;
      copiesOpen.set(mindId, copies + 1);
      if (copies === 0) {
        core.watchComparisonMind({ mindId, clientId }).catch((error: unknown) => {
          console.warn("This window couldn't watch the Mind's comparison tables.", error);
        });
      }
      opened({ access, doc: local });
    },
    (error: unknown) => {
      if (active) failed(error);
    },
  );
  return () => {
    if (closed) return;
    closed = true;
    active = false;
    stopWaitingComposition?.();
    stopWaitingComposition = null;
    deferred.length = 0;
    stopListening();
    local.off("update", send);
    if (watching) {
      const copies = (copiesOpen.get(mindId) ?? 1) - 1;
      if (copies <= 0) {
        copiesOpen.delete(mindId);
        core.unwatchComparisonMind({ mindId, clientId }).catch((error: unknown) => {
          console.warn("This window couldn't stop watching the Mind's comparison tables.", error);
        });
      } else copiesOpen.set(mindId, copies);
    }
    core.closeMind(mindId).catch((error: unknown) => {
      console.warn("The Mind's copy couldn't be closed.", error);
    });
  };
}
