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

const takers = new Map<string, { doc: Y.Doc; take(update: Uint8Array, cause: EditCause): void }>();

/** How many copies of each Mind this window has open: the note's worth one watch, not each. */
const copiesOpen = new Map<string, number>();

/** The changes this window sent for each Mind that the core does not have yet. */
const sent = new Map<string, Set<Promise<void>>>();

/**
 * Waits until every change this window sent for the Mind has reached the
 * core, for an ask that must see them: a column move, which copies each cell
 * as it is then, the words just typed into one included.
 */
export async function flushMindUpdates(mindId: string): Promise<void> {
  for (;;) {
    const waiting = sent.get(mindId);
    if (!waiting || waiting.size === 0) return;
    await Promise.all([...waiting]);
  }
}

/** Hands the updates of this edit to `take`, in the copy `doc` only. Returns what stops it. */
export function takeEditUpdates(
  requestId: string,
  doc: Y.Doc,
  take: (update: Uint8Array, cause: EditCause) => void,
): () => void {
  const taker = { doc, take };
  takers.set(requestId, taker);
  return () => {
    if (takers.get(requestId) === taker) takers.delete(requestId);
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
  // Listen before opening, so nothing pushed in between is missed. Yjs merges in any order.
  const stopListening = core.on("mind.update", ({ mindId: changed, update, cause }) => {
    if (changed !== mindId) return;
    const taker = cause && takers.get(cause.requestId);
    if (cause && taker?.doc === local) taker.take(update, cause);
    else Y.applyUpdate(local, update, FROM_CORE);
  });
  // A change that built on one the core never got goes again inside the whole copy (#1119).
  const store = (update: Uint8Array, again: boolean) => {
    const tracked = core.applyMindUpdate(mindId, update).catch((error: unknown) => {
      const missed = describeError(error).wording?.key === "error.mind.missedChange";
      if (missed && again && active) store(Y.encodeStateAsUpdate(local), false);
      else failed(error);
    });
    const waiting = sent.get(mindId) ?? new Set<Promise<void>>();
    waiting.add(tracked);
    sent.set(mindId, waiting);
    void tracked.finally(() => {
      waiting.delete(tracked);
      if (waiting.size === 0 && sent.get(mindId) === waiting) sent.delete(mindId);
    });
  };
  const send = (update: Uint8Array, origin: unknown) => {
    if (origin !== FROM_CORE && origin !== EDIT_FROM_CORE && editable) store(update, true);
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
        core.watchComparisonMind?.({ mindId, clientId }).catch(() => undefined);
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
    stopListening();
    local.off("update", send);
    if (watching) {
      const copies = (copiesOpen.get(mindId) ?? 1) - 1;
      if (copies <= 0) {
        copiesOpen.delete(mindId);
        core.unwatchComparisonMind?.({ mindId, clientId }).catch(() => undefined);
      } else copiesOpen.set(mindId, copies);
    }
    core.closeMind(mindId).catch(() => undefined);
  };
}
