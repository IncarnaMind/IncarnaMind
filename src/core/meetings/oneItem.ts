/**
 * One meeting is one item (#2528): a Meeting's Transcript belongs to its Note
 * (`documents.meeting_mind_id`), and goes where the Note goes. The migration
 * that made it so joined the pairs filed apart, on the walled side when one
 * wall lay between them, and left apart those two walls kept apart; what is
 * here keeps each pair whole at every start, says each once, and undoes a
 * join exactly.
 */
import type { JoinedMeeting, MeetingLeftApart } from "../api";
import { InvalidInputError } from "../errors";
import { parseIds } from "../minds";
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
 * and keeps a row of its own, filed as the User's in the Folder its Note was in, so it can still
 * be found and stays behind its wall, in Recently deleted or not. Returns the Transcripts the
 * caller deletes, in this transaction, as deleting the Note does. Never throws on what it finds.
 */
export function transcriptsApart(db: Database, now: string): TranscriptsToDelete[] {
  const fileWhereNoteWas = db.all<{ id: string; folder_id: string; content_hash: string }>(
    `SELECT d.id, n.folder_id, d.content_hash FROM documents d
     JOIN minds n ON n.id = d.meeting_mind_id AND n.purged_at IS NOT NULL
     JOIN library_groups g ON g.id = n.folder_id AND g.deleted_at IS NULL
     WHERE d.purged_at IS NULL
     ORDER BY d.id`,
  );
  for (const row of fileWhereNoteWas) {
    db.run(
      `INSERT INTO document_groups (id, document_id, group_id, source, status,
         content_hash, request_id, created_at, updated_at, filed_at)
       VALUES (?, ?, ?, 'user', 'classified', ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        row.id,
        row.folder_id,
        row.content_hash,
        crypto.randomUUID(),
        now,
        now,
        now,
      ],
    );
  }
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
 * The meetings the migration joined across a wall's edge (`meeting_joins`), not said yet: each
 * Note still live and still in the Folder the join left it in, which is still there. The sidebar
 * says each once, with Undo.
 */
export function joinedMeetings(db: Database): JoinedMeeting[] {
  return db
    .all<{ id: string; mind_id: string; folder_id: string; note_moved: number }>(
      `SELECT j.id, j.mind_id, j.folder_id, j.from_folder_id IS NOT j.folder_id AS note_moved
       FROM meeting_joins j
       JOIN minds n ON n.id = j.mind_id AND n.deleted_at IS NULL AND n.folder_id IS j.folder_id
       JOIN library_groups g ON g.id = j.folder_id AND g.deleted_at IS NULL
       WHERE j.said_at IS NULL AND j.deleted_at IS NULL
       ORDER BY j.created_at, j.mind_id`,
    )
    .map((row) => ({
      id: row.id,
      mindId: row.mind_id,
      folderId: row.folder_id,
      noteMoved: row.note_moved === 1,
    }));
}

/** Records that the sidebar said these joins, so it never says them again. */
export function joinedMeetingsSaid(db: Database, ids: unknown, now: string): void {
  db.run(
    `UPDATE meeting_joins SET said_at = ?, updated_at = ?
     WHERE said_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
    [now, now, JSON.stringify(parseIds(ids, "The meetings said"))],
  );
}

/** What undoing a join changed: the Note to move back, if it moved, and the Transcripts let go. */
export interface JoinUndone {
  mindId: string;
  /** The Folder the Note goes back to, or undefined when the join didn't move it. */
  noteBackTo?: string | null;
  documentIds: string[];
}

/**
 * Puts a pair the migration joined back exactly as it was: each Transcript that crossed is a
 * Document of its own again, in its own Folder with its Tags, and a Note the join moved goes back
 * to its Folder (Not in a Folder when that one is gone). So nothing walled comes out. Refused once
 * the User has moved the Note since. The caller moves the Note, in this transaction.
 */
export function undoMeetingJoin(db: Database, id: unknown, now: string): JoinUndone {
  const joinId = parseIds([id], "The meeting to put back")[0] ?? "";
  const join = db.get<{
    id: string;
    mind_id: string;
    folder_id: string | null;
    from_folder_id: string | null;
    created_at: string;
  }>(
    `SELECT j.id, j.mind_id, j.folder_id, j.from_folder_id, j.created_at FROM meeting_joins j
     JOIN minds n ON n.id = j.mind_id AND n.deleted_at IS NULL AND n.folder_id IS j.folder_id
     WHERE j.id = ? AND j.deleted_at IS NULL`,
    [joinId],
  );
  if (!join) throw new InvalidInputError({ key: "error.meeting.joinMoved" });
  const documentIds = db
    .all<{ document_id: string }>(
      `SELECT t.document_id FROM meeting_join_transcripts t
       JOIN documents d ON d.id = t.document_id AND d.meeting_mind_id = ? AND d.deleted_at IS NULL
       WHERE t.join_id = ? AND t.deleted_at IS NULL
       ORDER BY t.document_id`,
      [join.mind_id, join.id],
    )
    .map((row) => row.document_id);
  const list = JSON.stringify(documentIds);
  db.run(
    `UPDATE documents SET meeting_mind_id = NULL, updated_at = ?
     WHERE id IN (SELECT value FROM json_each(?))`,
    [now, list],
  );
  // The rows the migration put away for them, at its one time; a Tag deleted since stays so.
  for (const table of ["document_groups", "document_tags"]) {
    db.run(
      `UPDATE ${table} SET deleted_at = NULL, updated_at = ?
       WHERE deleted_at = ? AND document_id IN (SELECT value FROM json_each(?))
         ${table === "document_tags" ? "AND tag_id IN (SELECT id FROM tags WHERE deleted_at IS NULL)" : ""}`,
      [now, join.created_at, list],
    );
  }
  db.run(
    "UPDATE meeting_joins SET said_at = coalesce(said_at, ?), deleted_at = ?, updated_at = ? WHERE id = ?",
    [now, now, now, join.id],
  );
  db.run("UPDATE meeting_join_transcripts SET deleted_at = ?, updated_at = ? WHERE join_id = ?", [
    now,
    now,
    join.id,
  ]);
  if (join.from_folder_id === join.folder_id) return { mindId: join.mind_id, documentIds };
  const back =
    join.from_folder_id !== null &&
    db.get("SELECT 1 FROM library_groups WHERE id = ? AND deleted_at IS NULL", [
      join.from_folder_id,
    ])
      ? join.from_folder_id
      : null;
  return { mindId: join.mind_id, noteBackTo: back, documentIds };
}

/**
 * The meetings the migration left apart from their Transcripts (`meetings_left_apart`), because
 * two walls kept them apart, not said yet: each Note still live. The sidebar says so once; nothing
 * moves them, and moving one across a wall is the User's own act.
 */
export function meetingsLeftApart(db: Database): MeetingLeftApart[] {
  return db
    .all<{ id: string; mind_id: string }>(
      `SELECT j.id, j.mind_id FROM meetings_left_apart j
       JOIN minds n ON n.id = j.mind_id AND n.deleted_at IS NULL
       WHERE j.said_at IS NULL AND j.deleted_at IS NULL
       ORDER BY j.created_at, j.mind_id`,
    )
    .map((row) => ({ id: row.id, mindId: row.mind_id }));
}

/** Records that the sidebar said these, so it never says them again. */
export function meetingsLeftApartSaid(db: Database, ids: unknown, now: string): void {
  db.run(
    `UPDATE meetings_left_apart SET said_at = ?, updated_at = ?
     WHERE said_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
    [now, now, JSON.stringify(parseIds(ids, "The meetings said"))],
  );
}
