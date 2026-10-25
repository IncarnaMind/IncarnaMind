import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  type EditCause,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
} from "./api";
import { InvalidInputError, MindReadOnlyError } from "./errors";
import { readContentVersion } from "./mindAccess";
import type { Database } from "./storage";

/** The origin of the core's own changes to a Mind's document. */
const CORE_ORIGIN = Symbol("the core");

export type MindContent = ReturnType<typeof createMindContent>;

/**
 * Once a Mind has this many stored updates, they are merged into one. The same
 * default as y-leveldb's: compaction rewrites the whole document, so it
 * shouldn't run every few keystrokes. Loading or closing a Mind also compacts it.
 */
export const COMPACT_AFTER_UPDATES = 500;

/** The content schema version recorded in a Mind's document; a Mind that records none is version 1. */
export const contentVersionOf = (doc: Y.Doc): number =>
  readContentVersion(doc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY));

/** Records that this version wrote the document. Call it inside the transaction that changes it. */
function stampContentVersion(doc: Y.Doc): void {
  const settings = doc.getMap(MIND_SETTINGS_FIELD);
  const recorded = settings.get(CONTENT_SCHEMA_VERSION_KEY);
  // Never lowered: a document that records a newer version keeps it. Absent or malformed reads as 1.
  if (
    recorded !== readContentVersion(recorded) ||
    readContentVersion(recorded) < CONTENT_SCHEMA_VERSION
  ) {
    settings.set(CONTENT_SCHEMA_VERSION_KEY, CONTENT_SCHEMA_VERSION);
  }
}

interface LoadedMind {
  doc: Y.Doc;
  /** Rows stored for this Mind, a compacted one included. */
  storedRows: number;
  /** Updates the document emitted that aren't reported and stored yet. */
  outbox: { update: Uint8Array; cause: EditCause | undefined }[];
  cause: EditCause | undefined;
  unsaved: Unsaved | null;
  /**
   * When the Mind was deleted, while changes to it wait (#1202): they stay until it is deleted
   * for good, and are stored deleted with it, so Restore brings them back.
   */
  deletedAt: string | null;
}

/** A Mind's changes storage refused (#1119): kept in memory as one update, and tried again. */
interface Unsaved {
  update: Uint8Array;
  /** How many changes it holds. */
  count: number;
  failure: unknown;
  /** How many tries in a row have failed. */
  tries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** What the core hears of changes that couldn't be stored. */
export interface MindContentOptions {
  /** Some of the Mind's changes couldn't be stored, or (null) all of them are now. */
  unsaved?(
    mindId: string,
    state: { count: number; failure: unknown; deleted: boolean } | null,
  ): void;
}

/** How long to wait before storing again after each failed try; the last repeats. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Whether an update starts past what the document has of one of its clients: it builds on a change the document never got. */
function missesEarlier(doc: Y.Doc, update: Uint8Array): boolean {
  const { from } = Y.parseUpdateMeta(update);
  const have = Y.decodeStateVector(Y.encodeStateVector(doc));
  return [...from].some(([client, clock]) => clock > (have.get(client) ?? 0));
}

const holdsBack = (doc: Y.Doc) => doc.store.pendingStructs !== null || doc.store.pendingDs !== null;

/**
 * The authoritative Yjs document of each Mind being edited (ADR-0003).
 *
 * Every change to a document, whoever made it, is reported through `onChanged`
 * at once and stored as one row. A document is loaded on first use and stays in
 * memory until `close`, `remove` or `closeAll`. Callers check that the Mind exists.
 *
 * When storage refuses a write, the document keeps the change and every later
 * one builds on it (#1119): they wait, merged, are tried again with each change
 * and on a backoff, and `options.unsaved` hears of them until they are stored.
 */
export function createMindContent(
  db: Database,
  now: () => string,
  onChanged: (mindId: string, update: Uint8Array, cause: EditCause | undefined) => void,
  options: MindContentOptions = {},
) {
  const loaded = new Map<string, LoadedMind>();

  const insert = (
    mindId: string,
    data: Uint8Array,
    at: string,
    deletedAt: string | null = null,
  ) => {
    db.run(
      "INSERT INTO mind_updates (id, mind_id, data, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)",
      [randomUUID(), mindId, data, at, at, deletedAt],
    );
  };

  /** Replaces the Mind's stored rows with one row holding the document's whole state. */
  const compact = (mindId: string, mind: LoadedMind) => {
    if (mind.storedRows <= 1 || mind.deletedAt !== null) return;
    const state = Y.encodeStateAsUpdate(mind.doc);
    db.transaction(() => {
      db.run("DELETE FROM mind_updates WHERE mind_id = ? AND deleted_at IS NULL", [mindId]);
      insert(mindId, state, now());
    });
    mind.storedRows = 1;
  };

  const unload = (mindId: string) => {
    const mind = loaded.get(mindId);
    if (mind?.unsaved?.timer) clearTimeout(mind.unsaved.timer);
    mind?.doc.destroy();
    loaded.delete(mindId);
  };

  /** A new document holding what is stored for the Mind, and how many rows that took. */
  const fromStorage = (mindId: string, deleted = false) => {
    // A Mind waiting in Recently deleted has all its rows marked deleted.
    const rows = db.all<{ data: Uint8Array }>(
      `SELECT data FROM mind_updates WHERE mind_id = ? AND deleted_at IS ${deleted ? "NOT " : ""}NULL ORDER BY rowid`,
      [mindId],
    );
    const doc = new Y.Doc();
    doc.transact(() => {
      for (const row of rows) Y.applyUpdate(doc, row.data);
    });
    return { doc, rows: rows.length };
  };

  const peekStored = <T>(
    mindId: string,
    deleted: boolean,
    look: (blocks: Y.XmlFragment) => T,
  ): T => {
    const mind = loaded.get(mindId);
    if (mind) return look(mind.doc.getXmlFragment(MIND_CONTENT_FIELD));
    const { doc } = fromStorage(mindId, deleted);
    try {
      return look(doc.getXmlFragment(MIND_CONTENT_FIELD));
    } finally {
      doc.destroy();
    }
  };

  const load = (mindId: string): LoadedMind => {
    const existing = loaded.get(mindId);
    if (existing) return existing;

    const { doc, rows } = fromStorage(mindId);
    const mind: LoadedMind = {
      doc,
      storedRows: rows,
      outbox: [],
      cause: undefined,
      unsaved: null,
      deletedAt: null,
    };
    // Listening only after loading, so the stored rows aren't stored again. The
    // listener must not throw: Yjs calls it while finishing a transaction.
    doc.on("update", (update: Uint8Array) => {
      mind.outbox.push({ update, cause: mind.cause });
    });
    loaded.set(mindId, mind);
    // A Mind a newer version wrote is left exactly as stored.
    if (contentVersionOf(doc) <= CONTENT_SCHEMA_VERSION) compact(mindId, mind);
    return mind;
  };

  /** Reports what the document emitted since the last flush, and stores it. */
  const flush = (mindId: string, mind: LoadedMind) => {
    if (mind.outbox.length === 0) return;
    const updates = mind.outbox.splice(0);
    for (const { update, cause } of updates) {
      try {
        onChanged(mindId, update, cause);
      } catch (error) {
        // What follows a change (its index, the Mind's title) mustn't keep it from being stored.
        console.error(`Mind ${mindId}: what follows a change failed`, error);
      }
    }
    store(
      mindId,
      mind,
      updates.map(({ update }) => update),
    );
  };

  /**
   * Stores `updates` after any still waiting, merged into one row with them. True once nothing
   * waits; on a failure all of them wait, and are tried again later.
   */
  const store = (mindId: string, mind: LoadedMind, updates: readonly Uint8Array[]): boolean => {
    const waiting = mind.unsaved;
    if (!waiting && updates.length === 0) return true;
    const rows = waiting ? [Y.mergeUpdates([waiting.update, ...updates])] : updates;
    try {
      const at = now();
      db.transaction(() => {
        for (const row of rows) insert(mindId, row, at, mind.deletedAt);
      });
    } catch (failure) {
      if (waiting?.timer) clearTimeout(waiting.timer);
      const unsaved: Unsaved = {
        update: rows.length === 1 && rows[0] ? rows[0] : Y.mergeUpdates([...rows]),
        count: (waiting?.count ?? 0) + updates.length,
        failure,
        tries: (waiting?.tries ?? 0) + 1,
        timer: null,
      };
      mind.unsaved = unsaved;
      unsaved.timer = retryLater(mindId, mind, unsaved.tries);
      options.unsaved?.(mindId, {
        count: unsaved.count,
        failure,
        deleted: mind.deletedAt !== null,
      });
      return false;
    }
    mind.storedRows += rows.length;
    if (waiting) {
      if (waiting.timer) clearTimeout(waiting.timer);
      mind.unsaved = null;
      options.unsaved?.(mindId, null);
      // A deleted Mind stays in memory only while its changes wait.
      if (mind.deletedAt !== null) unload(mindId);
    }
    if (mind.storedRows >= COMPACT_AFTER_UPDATES) compact(mindId, mind);
    return true;
  };

  const retryLater = (mindId: string, mind: LoadedMind, tries: number) => {
    const timer = setTimeout(
      () => {
        if (loaded.get(mindId) !== mind || !mind.unsaved) return;
        mind.unsaved.timer = null;
        store(mindId, mind, []);
      },
      RETRY_MS[Math.min(tries, RETRY_MS.length) - 1],
    );
    // Waiting to store again never keeps the app from quitting: quitting tries once more.
    timer.unref?.();
    return timer;
  };

  /** Refuses a write to a Mind a newer version wrote: the editor's schema would delete what it doesn't know. */
  const requireWritable = (mind: LoadedMind) => {
    if (contentVersionOf(mind.doc) > CONTENT_SCHEMA_VERSION) {
      throw new MindReadOnlyError({ key: "error.mind.newerVersionEdit" });
    }
  };

  return {
    /** The Mind's whole document, encoded as one update. */
    state(mindId: string): Uint8Array {
      return Y.encodeStateAsUpdate(load(mindId).doc);
    },

    stateVector(mindId: string): Uint8Array {
      return Y.encodeStateVector(load(mindId).doc);
    },

    /**
     * The content schema version the Mind was last written with. A Mind that
     * isn't loaded is read from what is stored and left unloaded, writing nothing.
     */
    contentVersion(mindId: string): number {
      const mind = loaded.get(mindId);
      if (mind) return contentVersionOf(mind.doc);
      const { doc } = fromStorage(mindId);
      try {
        return contentVersionOf(doc);
      } finally {
        doc.destroy();
      }
    },

    /**
     * The Mind's whole document as stored, for showing a Mind that may not be
     * written to: it is not kept in memory and nothing is rewritten.
     */
    storedState(mindId: string): Uint8Array {
      const mind = loaded.get(mindId);
      if (mind) return Y.encodeStateAsUpdate(mind.doc);
      const { doc } = fromStorage(mindId);
      try {
        return Y.encodeStateAsUpdate(doc);
      } finally {
        doc.destroy();
      }
    },

    apply(mindId: string, update: unknown, cause?: EditCause): void {
      if (!(update instanceof Uint8Array) || update.byteLength === 0) {
        throw new InvalidInputError("A Mind update must be a non-empty Uint8Array.");
      }
      const mind = load(mindId);
      requireWritable(mind);
      let failure: unknown;
      let missed = false;
      const heldBack = holdsBack(mind.doc);
      mind.cause = cause;
      try {
        missed = missesEarlier(mind.doc, update);
        // One transaction, so recording the version rides in the same stored update.
        mind.doc.transact(() => {
          Y.applyUpdate(mind.doc, update);
          stampContentVersion(mind.doc);
        }, CORE_ORIGIN);
      } catch (error) {
        failure = error;
      } finally {
        mind.cause = undefined;
      }
      // Whatever Yjs took in is in the document now, so it is stored even if the rest was malformed.
      flush(mindId, mind);
      if (failure !== undefined) {
        throw new InvalidInputError("That isn't a valid Yjs update.", { cause: failure });
      }
      // Yjs holds back a change that builds on one it never got; acknowledging it would lose it.
      if (missed || (!heldBack && holdsBack(mind.doc))) {
        throw new InvalidInputError({ key: "error.mind.missedChange" });
      }
    },

    /**
     * Reads the Mind's Blocks. `look` must not change them, nor keep them: the
     * document can be dropped from memory, and loaded again, between calls.
     */
    read<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T {
      return look(load(mindId).doc.getXmlFragment(MIND_CONTENT_FIELD));
    },

    /**
     * Reads the Mind's Blocks as `read` does, but a Mind that isn't loaded is
     * read from what is stored and left unloaded, writing nothing.
     */
    peek<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T {
      return peekStored(mindId, false, look);
    },

    /** As `peek`, for a Mind waiting in Recently deleted: its Blocks as they come back on restore. */
    peekDeleted<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T {
      return peekStored(mindId, true, look);
    },

    /**
     * Changes the Mind's Blocks in one Yjs transaction (the core's own edits,
     * e.g. writing an Answer), then stores and reports the change like any
     * client's. `change` must not keep the Blocks, as for `read`.
     */
    edit<T>(mindId: string, change: (blocks: Y.XmlFragment) => T): T {
      const mind = load(mindId);
      requireWritable(mind);
      let result: T | undefined;
      try {
        mind.doc.transact(() => {
          result = change(mind.doc.getXmlFragment(MIND_CONTENT_FIELD));
          stampContentVersion(mind.doc);
        }, CORE_ORIGIN);
      } finally {
        flush(mindId, mind);
      }
      return result as T;
    },

    /**
     * Reads the Mind's own choices (`MIND_SETTINGS_FIELD`), as `peek` reads its Blocks: a Mind
     * that isn't loaded is read from what is stored and left unloaded.
     */
    readSettings<T>(mindId: string, look: (settings: Y.Map<unknown>) => T): T {
      const mind = loaded.get(mindId);
      if (mind) return look(mind.doc.getMap(MIND_SETTINGS_FIELD));
      const { doc } = fromStorage(mindId);
      try {
        return look(doc.getMap(MIND_SETTINGS_FIELD));
      } finally {
        doc.destroy();
      }
    },

    /** Changes the Mind's own choices in one transaction, stored and reported like `edit`. */
    editSettings<T>(mindId: string, change: (settings: Y.Map<unknown>) => T): T {
      const mind = load(mindId);
      requireWritable(mind);
      let result: T | undefined;
      try {
        mind.doc.transact(() => {
          result = change(mind.doc.getMap(MIND_SETTINGS_FIELD));
          stampContentVersion(mind.doc);
        }, CORE_ORIGIN);
      } finally {
        flush(mindId, mind);
      }
      return result as T;
    },

    isLoaded(mindId: string): boolean {
      return loaded.has(mindId);
    },

    /**
     * Compacts the Mind and drops its document from memory. Does nothing if it isn't loaded.
     * Changes that still can't be stored keep it in memory, still tried again.
     */
    close(mindId: string): void {
      const mind = loaded.get(mindId);
      if (!mind || mind.deletedAt !== null) return;
      flush(mindId, mind);
      if (!store(mindId, mind, [])) return;
      // A Mind a newer version wrote is left exactly as stored.
      if (contentVersionOf(mind.doc) <= CONTENT_SCHEMA_VERSION) compact(mindId, mind);
      unload(mindId);
    },

    /**
     * Marks the Mind's content deleted, in the transaction that deletes the Mind; `removed`
     * follows once that commits.
     */
    remove(mindId: string, at: string): void {
      db.run(
        "UPDATE mind_updates SET deleted_at = ?, updated_at = ? WHERE mind_id = ? AND deleted_at IS NULL",
        [at, at, mindId],
      );
    },

    /**
     * The Mind's deletion at `at` committed: its document leaves memory. Changes that still
     * wait are stored deleted with it, or stay in memory, tried again, until they are.
     */
    removed(mindId: string, at: string): void {
      const mind = loaded.get(mindId);
      if (!mind) return;
      // Only now: had the deletion rolled back, later typing would be stored as deleted.
      mind.deletedAt = at;
      if (!mind.unsaved || store(mindId, mind, [])) unload(mindId);
    },

    /**
     * Brings back the content `remove` marked deleted at `deletedAt`, in the transaction that
     * restores the Mind; `restored` follows once that commits.
     */
    restore(mindId: string, deletedAt: string): void {
      db.run(
        "UPDATE mind_updates SET deleted_at = NULL, updated_at = ? WHERE mind_id = ? AND deleted_at = ?",
        [now(), mindId, deletedAt],
      );
    },

    /**
     * The Mind's restore committed: what still waits is live again, and the unsaved-changes
     * notice hears of it. Only now: had the restore rolled back, the Mind is still deleted.
     */
    restored(mindId: string, deletedAt: string): void {
      const mind = loaded.get(mindId);
      if (mind?.deletedAt !== deletedAt) return;
      mind.deletedAt = null;
      const { unsaved } = mind;
      if (unsaved) {
        options.unsaved?.(mindId, {
          count: unsaved.count,
          failure: unsaved.failure,
          deleted: false,
        });
      }
    },

    /** Drops a Mind deleted for good from memory, with what of it still waits. */
    forget(mindId: string): void {
      const mind = loaded.get(mindId);
      if (mind?.unsaved) {
        console.error(
          `${mind.unsaved.count} changes to Mind ${mindId} couldn't be stored before it was deleted for good.`,
          mind.unsaved.failure,
        );
        options.unsaved?.(mindId, null);
      }
      unload(mindId);
    },

    /** Tries once more to store what is waiting. */
    storeWaiting(): void {
      for (const [mindId, mind] of [...loaded]) if (mind.unsaved) store(mindId, mind, []);
    },

    /** Drops every document from memory, storing first what couldn't be stored before. */
    closeAll(): void {
      for (const [mindId, mind] of [...loaded]) {
        flush(mindId, mind);
        if (!store(mindId, mind, [])) {
          console.error(
            `${mind.unsaved?.count ?? 0} changes to Mind ${mindId} couldn't be stored before quitting, and are lost.`,
            mind.unsaved?.failure,
          );
        }
        unload(mindId);
      }
    },
  };
}
