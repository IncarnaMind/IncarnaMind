/**
 * The migration that makes a Meeting's Transcript belong to its Note (#2528) on a Library of
 * 2,000 Documents, 300 of them Transcripts in 280 Notes, filed every way an earlier version could
 * leave them: every pair survives, nothing is erased, nothing walled comes out, a pair one wall
 * lies between joins on its walled side, and one two walls lie between stays exactly where it was.
 */
import { join } from "node:path";
import { expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/core/storage";
import { type Migration, migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder } from "../helpers/core";
import { seedMeetingLibrary, wallsOf } from "../helpers/meetingLibrary";

const ours = migrations.find((each) => each.description.includes("(#2528)")) as Migration;

test("2,000 Documents and 300 meetings: every Document, Note and pair survives, and nothing walled comes out", async () => {
  const db = openDatabase(join(await createTempDataFolder(), "library.db"));
  migrate(
    db,
    migrations.filter((each) => each.version < ours.version),
  );
  seedMeetingLibrary(db);
  const walls = wallsOf(db);
  const wallOf = (folderId: string | null | undefined) =>
    folderId ? (walls.get(folderId) ?? null) : null;
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
  const liveTags = () =>
    db.get<{ n: number }>("SELECT count(*) AS n FROM document_tags WHERE deleted_at IS NULL")?.n;
  expect(documentsBefore).toHaveLength(2000);
  expect(db.get<{ n: number }>("SELECT count(*) AS n FROM meetings")?.n).toBe(300);
  expect(notesBefore).toHaveLength(280);
  expect(filedBefore.size).toBe(1440);
  expect(liveTags()).toBe(288);

  migrate(db);

  // Nothing erased: every Document and Note is there, deleted or not as it was.
  expect(db.all("SELECT id, deleted_at FROM documents ORDER BY id")).toEqual(documentsBefore);
  expect(db.all("SELECT id, deleted_at FROM minds ORDER BY id")).toEqual(
    notesBefore.map(({ id, deleted_at }) => ({ id, deleted_at })),
  );
  const notesAfter = new Map(
    db
      .all<{ id: string; folder_id: string | null }>("SELECT id, folder_id FROM minds")
      .map((row) => [row.id, row.folder_id]),
  );

  // 240 pairs are one item now: together already (80), behind the same wall (20), apart in the
  // open (60), the Note gone in to its Transcript's wall (40, and 20 in Recently deleted), and the
  // Transcript gone in to its Note's (20).
  const owned = db.all<{ id: string; meeting_mind_id: string }>(
    "SELECT id, meeting_mind_id FROM documents WHERE meeting_mind_id IS NOT NULL ORDER BY id",
  );
  expect(owned).toHaveLength(240);
  for (const [prefix, count] of [
    ["t-same-", 80],
    ["t-within-", 20],
    ["t-apart-", 60],
    ["t-walled-", 40],
    ["t-bin-", 20],
    ["t-inside-", 20],
  ] as const) {
    expect(
      owned.filter((each) => each.id.startsWith(prefix)),
      prefix,
    ).toHaveLength(count);
  }
  expect(
    db.get<{ n: number }>(
      "SELECT count(*) AS n FROM documents d JOIN meetings m ON m.transcript_document_id = d.id WHERE d.meeting_mind_id = m.mind_id",
    )?.n,
  ).toBe(240);

  // Nothing walled came out, nor went behind another wall: every Note and Transcript behind a wall
  // is behind it still; only outside halves moved, in. 60 Notes went in, each into its
  // Transcript's Folder.
  const placeAfter = (id: string) => {
    const noteId = owned.find((each) => each.id === id)?.meeting_mind_id;
    return noteId ? notesAfter.get(noteId) : filedBefore.get(id);
  };
  const walledTranscripts = [...filedBefore].filter(
    ([id, groupId]) => id.startsWith("t-") && wallOf(groupId) !== null,
  );
  expect(walledTranscripts).toHaveLength(120);
  expect(
    walledTranscripts.filter(([id, groupId]) => wallOf(placeAfter(id)) !== wallOf(groupId)),
  ).toEqual([]);
  expect(
    notesBefore.filter(
      (note) => wallOf(note.folder_id) !== null && notesAfter.get(note.id) !== note.folder_id,
    ),
  ).toEqual([]);
  const moved = notesBefore.filter((note) => notesAfter.get(note.id) !== note.folder_id);
  expect(moved).toHaveLength(60);
  expect(
    moved.every(
      (note) => wallOf(note.folder_id) === null && wallOf(notesAfter.get(note.id)) !== null,
    ),
  ).toBe(true);

  // The 20 Notes with Transcripts behind two walls stay where they were, their 40 Transcripts
  // Documents of their own in their Folders; the 20 whose Note was deleted permanently too.
  const filedAfter = new Map(
    db
      .all<{ document_id: string; group_id: string }>(
        "SELECT document_id, group_id FROM document_groups WHERE deleted_at IS NULL",
      )
      .map((row) => [row.document_id, row.group_id]),
  );
  const apart = [
    ...Array.from({ length: 20 }, (_, i) => `t-two-a-${i}`),
    ...Array.from({ length: 20 }, (_, i) => `t-two-b-${i}`),
    ...Array.from({ length: 20 }, (_, i) => `t-gone-${i}`),
  ];
  expect(
    db
      .all<{ id: string }>(
        "SELECT id FROM documents WHERE kind = 'transcript' AND source_kind = 'data-folder' AND meeting_mind_id IS NULL ORDER BY id",
      )
      .map((row) => row.id),
  ).toEqual([...apart].sort());
  for (const id of apart) expect(filedAfter.get(id)).toBe(filedBefore.get(id));
  expect(
    notesBefore
      .filter((note) => note.id.startsWith("n-two-"))
      .filter((note) => notesAfter.get(note.id) !== note.folder_id),
  ).toEqual([]);

  // Said once: the 80 joins across a wall's edge (60 of them live), and the 20 Notes left apart.
  expect(db.get<{ n: number }>("SELECT count(*) AS n FROM meeting_joins")?.n).toBe(80);
  expect(
    db.get<{ n: number }>(
      "SELECT count(*) AS n FROM meeting_joins j JOIN minds n ON n.id = j.mind_id WHERE n.deleted_at IS NULL",
    )?.n,
  ).toBe(60);
  expect(
    db.get<{ n: number }>(
      "SELECT count(*) AS n FROM meetings_left_apart WHERE mind_id LIKE 'n-two-%'",
    )?.n,
  ).toBe(20);
  expect(db.get<{ n: number }>("SELECT count(*) AS n FROM meetings_left_apart")?.n).toBe(20);

  // Every other Document is filed and tagged as it was; a joined Transcript has no Folder or Tags.
  expect(filedAfter.size).toBe(1200);
  for (const [documentId, groupId] of filedAfter) {
    expect(filedBefore.get(documentId)).toBe(groupId);
  }
  expect(
    db.get<{ n: number }>(
      "SELECT count(*) AS n FROM document_tags WHERE deleted_at IS NULL AND document_id IN (SELECT id FROM documents WHERE meeting_mind_id IS NOT NULL)",
    )?.n,
  ).toBe(0);
  expect(liveTags()).toBe(188);
  db.close();
});
