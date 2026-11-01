import { randomUUID } from "node:crypto";
import type { Database } from "../storage";

/**
 * When tagging was turned on for every service automatic tagging and Organize send to now: the
 * latest of their times. "here" when nothing leaves the computer; null when one of them wasn't
 * turned on.
 */
export type SendsSince = string | null | "here";

/**
 * Whether automatic tagging or Organize may send this Document by itself (#2308). Only one that is
 * new since tagging was turned on (`since`) goes: added at or after it, and, in a Linked folder,
 * from a folder linked at or after it or a file written at or after it. One the User has organized or re-tagged
 * since goes too. Everything else waits for them, whatever brought it back (restored, read again,
 * found by a folder linked before), so a way in nobody listed stays closed.
 */
export function mayBackgroundSend(db: Database, documentId: string, since: SendsSince): boolean {
  if (since === "here") return true;
  const row = db.get<{
    created_at: string;
    linked_folder_id: string | null;
    file_mtime_ms: number | null;
    linked_at: string | null;
    cleared_at: string | null;
  }>(
    `SELECT d.created_at, d.linked_folder_id, d.file_mtime_ms, l.created_at AS linked_at,
       (SELECT c.cleared_at FROM tagging_clearances c
         WHERE c.document_id = d.id AND c.deleted_at IS NULL) AS cleared_at
     FROM documents d LEFT JOIN linked_folders l ON l.id = d.linked_folder_id
     WHERE d.id = ?`,
    [documentId],
  );
  if (!row) return false;
  // What the User asked for goes, also while waiting to be allowed: only they start it then.
  if (row.cleared_at !== null && (since === null || row.cleared_at >= since)) return true;
  if (since === null || row.created_at < since) return false;
  if (row.linked_folder_id === null) return true;
  if (row.linked_at === null) return false;
  return (
    row.linked_at >= since || (row.file_mtime_ms !== null && row.file_mtime_ms >= Date.parse(since))
  );
}

/** The User organized or re-tagged these Documents at `at`: they may go by themselves from then. */
export function clearForUser(db: Database, documentIds: readonly string[], at: string): void {
  db.transaction(() => {
    for (const id of documentIds) {
      db.run(
        `INSERT INTO tagging_clearances (id, document_id, cleared_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (document_id) WHERE deleted_at IS NULL
         DO UPDATE SET cleared_at = excluded.cleared_at, updated_at = excluded.updated_at`,
        [randomUUID(), id, at, at, at],
      );
    }
  });
}
