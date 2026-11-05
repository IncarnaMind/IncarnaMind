/**
 * The migration that makes a Meeting's Transcript belong to its Note (#2528) on a Library of
 * 2,000 Documents, 300 of them Transcripts in 280 Notes, filed every way an earlier version could
 * leave them: every pair survives, nothing is erased, and nothing walled comes out but what the
 * one case that can't be helped takes, a Note with Transcripts behind two walls.
 */
import { join } from "node:path";
import { expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/core/storage";
import { type Migration, migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder } from "../helpers/core";
import { seedMeetingLibrary, wallsOf } from "../helpers/meetingLibrary";

const ours = migrations.find((each) => each.description.includes("(#2528)")) as Migration;

test("2,000 Documents and 300 meetings: every Document, Note and pair survives, and only a Note with Transcripts behind two walls leaves one of them", async () => {
  const db = openDatabase(join(await createTempDataFolder(), "library.db"));
  migrate(
    db,
    migrations.filter((each) => each.version < ours.version),
  );
  seedMeetingLibrary(db);
  const walls = wallsOf(db);
  const documentsBefore = db.all<{ id: string; deleted_at: string | null }>(
    "SELECT id, deleted_at FROM documents ORDER BY id",
  );
  const notesBefore = db.all<{ id: string; folder_id: string | null; deleted_at: string | null }>(
    "SELECT id, folder_id, deleted_at FROM minds ORDER BY id",
  );
  const filedBefore = new Map(
    db
      .all<{ document_id: string; group_id: string }>(
        "SELECT document_id, group_id FROM document_groups WHERE deleted_at IS NULL",
      )
      .map((row) => [row.document_id, row.group_id]),
  );
  expect(documentsBefore).toHaveLength(2000);
  expect(notesBefore).toHaveLength(280);
  expect(filedBefore.size).toBe(1440);

  migrate(db);

  // Nothing erased: every Document and Note is there, deleted or not as it was.
  expect(db.all("SELECT id, deleted_at FROM documents ORDER BY id")).toEqual(documentsBefore);
  expect(db.all("SELECT id, deleted_at FROM minds ORDER BY id")).toEqual(
    notesBefore.map(({ id, deleted_at }) => ({ id, deleted_at })),
  );

  // Every pair whose Note is still here is one item; the 20 whose Note was deleted permanently
  // keep a row and a Folder of their own.
  const owned = db.all<{ id: string; meeting_mind_id: string }>(
    "SELECT id, meeting_mind_id FROM documents WHERE meeting_mind_id IS NOT NULL ORDER BY id",
  );
  expect(owned).toHaveLength(280);
  expect(
    db.get<{ n: number }>(
      "SELECT count(*) AS n FROM documents d JOIN meetings m ON m.transcript_document_id = d.id WHERE d.meeting_mind_id = m.mind_id",
    )?.n,
  ).toBe(280);
  const orphans = db.all<{ id: string }>(
    "SELECT id FROM documents WHERE kind = 'transcript' AND source_kind = 'data-folder' AND meeting_mind_id IS NULL",
  );
  expect(orphans.map((row) => row.id).every((id) => id.startsWith("t-gone-"))).toBe(true);
  expect(orphans).toHaveLength(20);

  // Only Folders changed: 80 Notes moved to their Transcript's side of a wall, each recorded.
  const notesAfter = new Map(
    db
      .all<{ id: string; folder_id: string | null }>("SELECT id, folder_id FROM minds")
      .map((row) => [row.id, row.folder_id]),
  );
  const moved = notesBefore.filter((note) => notesAfter.get(note.id) !== note.folder_id);
  expect(moved).toHaveLength(80);
  expect(db.get<{ n: number }>("SELECT count(*) AS n FROM meeting_joins")?.n).toBe(80);

  // Nothing walled came out: each Transcript that was behind a wall is behind it still, with its
  // Note, but the 20 second Transcripts of Notes whose Transcripts were behind two walls.
  const wallOf = (folderId: string | null | undefined) =>
    folderId ? (walls.get(folderId) ?? null) : null;
  const cameOut = owned.filter((transcript) => {
    const before = wallOf(filedBefore.get(transcript.id));
    return before !== null && wallOf(notesAfter.get(transcript.meeting_mind_id)) !== before;
  });
  expect(cameOut).toHaveLength(20);
  expect(cameOut.every((transcript) => transcript.id.startsWith("t-two-b-"))).toBe(true);
  // No Note left a wall it was behind.
  expect(
    notesBefore.filter(
      (note) =>
        wallOf(note.folder_id) !== null &&
        wallOf(notesAfter.get(note.id)) !== wallOf(note.folder_id),
    ),
  ).toEqual([]);

  // Every other Document is filed and tagged as it was; Transcripts have no Folder or Tags.
  const filedAfter = new Map(
    db
      .all<{ document_id: string; group_id: string }>(
        "SELECT document_id, group_id FROM document_groups WHERE deleted_at IS NULL",
      )
      .map((row) => [row.document_id, row.group_id]),
  );
  expect(filedAfter.size).toBe(1160);
  for (const [documentId, groupId] of filedAfter) {
    expect(filedBefore.get(documentId)).toBe(groupId);
  }
  expect(
    db.get<{ n: number }>(
      "SELECT count(*) AS n FROM document_tags WHERE deleted_at IS NULL AND document_id IN (SELECT id FROM documents WHERE meeting_mind_id IS NOT NULL)",
    )?.n,
  ).toBe(0);
  expect(
    db.get<{ n: number }>("SELECT count(*) AS n FROM document_tags WHERE deleted_at IS NULL")?.n,
  ).toBe(188);
  db.close();
});
