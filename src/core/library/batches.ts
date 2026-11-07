import { randomUUID } from "node:crypto";
import type { LinkedFolder } from "../api";
import type { Database } from "../storage";
import type { DocumentBatch } from "./types";

const PROGRESS_INTERVAL_MS = 250;
const READ = new Set(["ready", "waiting-for-model", "embedding", "no-text", "failed"]);

interface Batch {
  id: string;
  groupId: string | null;
  documentIds: string[];
  adding: boolean;
  /** The Linked folder whose first scan adds to it. */
  linkedFolderId: string | null;
  said: string | null;
}

interface Row {
  id: string;
  status: string;
  has_text: number;
  group_id: string | null;
  sorting: string | null;
  suggested: number | null;
}

/**
 * Documents added together, and how far they are. A batch is kept while the
 * app runs, until it is read and sorted and nothing in it waits for the User.
 */
export function createBatches(options: {
  db: Database;
  emit(batch: DocumentBatch): void;
  /** Files a new Document into the Folder its batch was added to. */
  file(documentId: string, groupId: string): void;
}) {
  const { db } = options;
  const batches = new Map<string, Batch>();
  const byDocument = new Map<string, Batch>();
  const dirty = new Set<Batch>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const progress = (batch: Batch) => {
    const rows = db.all<Row>(
      `SELECT d.id, d.status,
         EXISTS (SELECT 1 FROM passages p WHERE p.document_id = d.id AND p.deleted_at IS NULL) AS has_text,
         g.group_id, g.status AS sorting, g.suggested
       FROM json_each(?) j
       JOIN documents d ON d.id = j.value AND d.deleted_at IS NULL
       LEFT JOIN document_groups g ON g.document_id = d.id AND g.deleted_at IS NULL
       ORDER BY j.key`,
      [JSON.stringify(batch.documentIds)],
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.suggested === 1 && row.group_id)
        counts.set(row.group_id, (counts.get(row.group_id) ?? 0) + 1);
    }
    const value: DocumentBatch = {
      id: batch.id,
      groupId: batch.groupId,
      linkedFolderId: batch.linkedFolderId,
      documentIds: rows.map((row) => row.id),
      adding: batch.adding,
      read: rows.filter((row) => READ.has(row.status) || row.has_text === 1).length,
      sorted: rows.filter((row) => row.sorting === "classified").length,
      suggested: [...counts]
        .map(([groupId, count]) => ({ groupId, count }))
        .sort((a, b) => b.count - a.count),
    };
    const settled =
      !batch.adding &&
      value.read === rows.length &&
      value.suggested.length === 0 &&
      !rows.some(
        (row) => row.sorting && ["pending", "classifying", "waiting"].includes(row.sorting),
      );
    return { value, settled };
  };

  const flush = () => {
    for (const batch of dirty) {
      const { value, settled } = progress(batch);
      const said = JSON.stringify(value);
      if (said !== batch.said) {
        batch.said = said;
        options.emit(value);
      }
      if (settled) {
        batches.delete(batch.id);
        for (const id of batch.documentIds) byDocument.delete(id);
      }
    }
    dirty.clear();
  };

  // The first change is said at once, later ones at most every PROGRESS_INTERVAL_MS.
  const touch = (batch: Batch) => {
    if (closed || !batches.has(batch.id)) return;
    dirty.add(batch);
    // A batch's first word and its landing are said at once, even while another batch's timer
    // runs: a window starts holding its lists the moment a batch begins, and lists it the moment
    // it has landed (#1329).
    if (timer && batch.said !== null && batch.adding) return;
    flush();
    if (timer) return;
    const later = () => {
      timer = undefined;
      if (closed || dirty.size === 0) return;
      flush();
      timer = setTimeout(later, PROGRESS_INTERVAL_MS);
      timer.unref?.();
    };
    timer = setTimeout(later, PROGRESS_INTERVAL_MS);
    timer.unref?.();
  };

  const join = (batch: Batch, documentId: string) => {
    batch.documentIds.push(documentId);
    byDocument.set(documentId, batch);
    if (batch.groupId) options.file(documentId, batch.groupId);
    touch(batch);
  };

  const done = (batch: Batch) => {
    batch.adding = false;
    touch(batch);
  };

  return {
    begin(groupId: string | null): string {
      const batch: Batch = {
        id: randomUUID(),
        groupId,
        documentIds: [],
        adding: true,
        linkedFolderId: null,
        said: null,
      };
      batches.set(batch.id, batch);
      return batch.id;
    },
    added(batchId: string, documentId: string): void {
      const batch = batches.get(batchId);
      if (batch) join(batch, documentId);
    },
    done(batchId: string): void {
      const batch = batches.get(batchId);
      if (batch) done(batch);
    },
    /** The batch is the first scan of this Linked folder, just linked. */
    linking(batchId: string, linkedFolder: LinkedFolder): void {
      const batch = batches.get(batchId);
      if (!batch) return;
      batch.linkedFolderId = linkedFolder.id;
      if (linkedFolder.status === "watching") done(batch);
    },
    /** A new Document a scan found: it joins its Linked folder's batch while the first scan runs. */
    found(documentId: string): void {
      const row = db.get<{ linked_folder_id: string | null }>(
        "SELECT linked_folder_id FROM documents WHERE id = ?",
        [documentId],
      );
      const batch = [...batches.values()].find(
        (each) =>
          each.adding &&
          each.linkedFolderId !== null &&
          each.linkedFolderId === row?.linked_folder_id,
      );
      if (batch) join(batch, documentId);
    },
    // A first scan paused, or out of reach, finishes once it can go on.
    linkedFoldersChanged(list: readonly LinkedFolder[]): void {
      for (const batch of batches.values()) {
        if (!batch.adding || !batch.linkedFolderId) continue;
        const linked = list.find((each) => each.id === batch.linkedFolderId);
        if (!linked || linked.status === "watching") done(batch);
      }
    },
    changed(documentIds: readonly string[]): void {
      for (const id of documentIds) {
        const batch = byDocument.get(id);
        if (batch) touch(batch);
      }
    },
    /** Folders changed: a deleted one leaves its suggestions Not in a Folder. */
    libraryChanged(): void {
      for (const batch of batches.values()) touch(batch);
    },
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
