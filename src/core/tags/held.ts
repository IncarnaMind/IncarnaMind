import { randomUUID } from "node:crypto";
import type { Database } from "../storage";

/**
 * When tagging was turned on for every service automatic tagging and Organize send to now: the
 * latest of their times. "here" when nothing leaves the computer; null when one of them wasn't
 * turned on.
 */
export type SendsSince = string | null | "here";

/**
 * Whether automatic tagging or Organize may send this Document by itself (#2308). Only one
 * IncarnaMind saw arrive new at or after tagging was turned on (`since`) goes: added by the User,
 * found by the first scan of a Linked folder they linked then, or reported by its watcher after
 * that scan (`markArrived`). One the User has organized or re-tagged since goes too. Everything
 * else waits for them, whatever its file's times say (an edit, a save by rename, a copy keeping
 * its date) and whatever brought it back (restored, read again, found by a later scan), so a way
 * in nobody listed stays closed.
 */
export function mayBackgroundSend(db: Database, documentId: string, since: SendsSince): boolean {
  if (since === "here") return true;
  const row = db.get<{ arrived_at: string | null; cleared_at: string | null }>(
    `SELECT arrived_at, cleared_at FROM tagging_marks
     WHERE document_id = ? AND deleted_at IS NULL`,
    [documentId],
  );
  // What the User asked for goes, also while waiting to be allowed: only they start it then.
  if (row?.cleared_at != null && (since === null || row.cleared_at >= since)) return true;
  if (since === null) return false;
  return row?.arrived_at != null && row.arrived_at >= since;
}

function mark(
  db: Database,
  documentIds: readonly string[],
  column: "arrived_at" | "cleared_at",
  at: string,
): void {
  db.transaction(() => {
    for (const id of documentIds) {
      db.run(
        `INSERT INTO tagging_marks (id, document_id, ${column}, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (document_id) WHERE deleted_at IS NULL
         DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`,
        [randomUUID(), id, at, at, at],
      );
    }
  });
}

/** IncarnaMind saw this Document arrive new at `at` (see `mayBackgroundSend`). */
export function markArrived(db: Database, documentId: string, at: string): void {
  mark(db, [documentId], "arrived_at", at);
}

/** The User organized or re-tagged these Documents at `at`: they may go by themselves from then. */
export function clearForUser(db: Database, documentIds: readonly string[], at: string): void {
  mark(db, documentIds, "cleared_at", at);
}
