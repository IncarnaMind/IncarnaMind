/**
 * One meeting is one item (#2528): a Meeting's Transcript belongs to its Note
 * (`documents.meeting_mind_id`), and goes where the Note goes. The migration
 * that made it so joined the pairs filed apart; what is here keeps each pair
 * whole at every start, and says once which Notes that migration moved.
 */
import type { JoinedMeeting } from "../api";
import { InvalidInputError } from "../errors";
import type { Database } from "../storage";

/** Transcripts to send to Recently deleted with their Notes, at each Note's time. */
export interface TranscriptsToDelete {
  deletedAt: string;
  documentIds: string[];
}

/**
 * Puts right what an earlier version left apart, as each start finds it: a live Transcript whose
 * Note waits in Recently deleted (deleted before #1253) goes there with it, its Meetings too, so
 * it comes back with the Note; one whose Note was deleted permanently belongs to no Note again,
 * and keeps a row of its own so it can still be found. Returns the Transcripts the caller deletes,
 * in this transaction, as deleting the Note does.
 */
export function transcriptsApart(db: Database, now: string): TranscriptsToDelete[] {
  db.run(
    `UPDATE documents SET meeting_mind_id = NULL, updated_at = ?
     WHERE meeting_mind_id IS NOT NULL AND purged_at IS NULL
       AND EXISTS (SELECT 1 FROM minds n WHERE n.id = documents.meeting_mind_id
         AND n.purged_at IS NOT NULL)`,
    [now],
  );
  const left = db.all<{ id: string; mind_id: string; deleted_at: string }>(
    `SELECT d.id, n.id AS mind_id, n.deleted_at FROM documents d
     JOIN minds n ON n.id = d.meeting_mind_id
     WHERE d.deleted_at IS NULL AND n.deleted_at IS NOT NULL AND n.purged_at IS NULL
     ORDER BY n.deleted_at, d.id`,
  );
  const byNote = new Map<string, TranscriptsToDelete>();
  for (const row of left) {
    const known = byNote.get(row.mind_id) ?? { deletedAt: row.deleted_at, documentIds: [] };
    known.documentIds.push(row.id);
    byNote.set(row.mind_id, known);
  }
  for (const [mindId, { deletedAt }] of byNote) {
    db.run(
      `UPDATE meetings SET deleted_at = ?, updated_at = ?
       WHERE mind_id = ? AND deleted_at IS NULL AND status IN ('ready', 'stopped')`,
      [deletedAt, now, mindId],
    );
  }
  return [...byNote.values()];
}

/**
 * The Notes the migration moved to their Transcript's Folder (`meeting_joins`), not said yet:
 * each still live and still in that Folder, which is still there. The sidebar says each once,
 * with Undo.
 */
export function joinedMeetings(db: Database): JoinedMeeting[] {
  return db
    .all<{ id: string; mind_id: string; to_folder_id: string; from_folder_id: string | null }>(
      `SELECT j.id, j.mind_id, j.to_folder_id, j.from_folder_id FROM meeting_joins j
       JOIN minds n ON n.id = j.mind_id AND n.deleted_at IS NULL AND n.folder_id = j.to_folder_id
       JOIN library_groups g ON g.id = j.to_folder_id AND g.deleted_at IS NULL
       WHERE j.said_at IS NULL AND j.deleted_at IS NULL
       ORDER BY j.created_at, j.id`,
    )
    .map((row) => ({
      id: row.id,
      mindId: row.mind_id,
      folderId: row.to_folder_id,
      fromFolderId: row.from_folder_id,
    }));
}

/** Records that the sidebar said these, so it never says them again. */
export function joinedMeetingsSaid(db: Database, ids: unknown, now: string): void {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    throw new InvalidInputError("Expected a list of ids.");
  }
  db.run(
    `UPDATE meeting_joins SET said_at = ?, updated_at = ?
     WHERE said_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
    [now, now, JSON.stringify(ids)],
  );
}
