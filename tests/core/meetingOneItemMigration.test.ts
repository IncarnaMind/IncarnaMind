/**
 * The migration that makes a Meeting's Transcript belong to its Note (#2528), on a database as the
 * version before it left one: pairs filed apart join once, on the walled side when a wall lies
 * between them, and nothing else is touched. It runs in the transaction of every migration due,
 * so a quit halfway leaves the database as it was, and it runs once.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { type Database, migrate, openDatabase } from "../../src/core/storage";
import { type Migration, migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";

const AT = "2026-10-20T09:00:00.000Z";
const DELETED = "2026-10-25T09:00:00.000Z";

const ours = migrations.find((each) => each.description.includes("(#2528)")) as Migration;
const before = migrations.filter((each) => each.version < ours.version);

/** A row with every column the table needs filled, from `values`, else a plain placeholder. */
function insert(db: Database, table: string, values: Record<string, string | number | null>) {
  const columns = db.all<{ name: string; type: string; notnull: number; dflt_value: unknown }>(
    `PRAGMA table_info(${table})`,
  );
  const row: Record<string, string | number | null> = {};
  for (const column of columns) {
    const given = values[column.name];
    if (given !== undefined) row[column.name] = given;
    else if (column.notnull === 1 && column.dflt_value === null) {
      row[column.name] = column.type.toUpperCase() === "INTEGER" ? 0 : AT;
    }
  }
  const names = Object.keys(row);
  db.run(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    names.map((name) => row[name] ?? null),
  );
}

const folder = (db: Database, id: string, parentId: string | null, walled: boolean) =>
  insert(db, "library_groups", {
    id,
    name: id,
    description: "",
    parent_id: parentId,
    keep_inside: walled ? 1 : 0,
  });

/** A Note with a Meeting whose Transcript is filed in `filedIn`; the meeting made at `madeAt`. */
function pair(
  db: Database,
  note: { id: string; folderId: string | null; deletedAt?: string; purgedAt?: string },
  transcript: string,
  filedIn: string | null,
  madeAt = AT,
) {
  if (!db.get("SELECT 1 FROM minds WHERE id = ?", [note.id])) {
    insert(db, "minds", {
      id: note.id,
      title: `Call ${note.id}`,
      folder_id: note.folderId,
      deleted_at: note.deletedAt ?? null,
      purged_at: note.purgedAt ?? null,
    });
  }
  insert(db, "documents", {
    id: transcript,
    content_hash: `hash-${transcript}`,
    name: `Transcript · Call ${note.id}`,
    kind: "transcript",
    size: 1,
    status: "ready",
    path: `/data/Transcripts/${transcript}.vtt`,
    source_kind: "data-folder",
    relative_path: `Transcripts/${transcript}.vtt`,
  });
  insert(db, "meetings", {
    id: `meeting-${transcript}`,
    mind_id: note.id,
    status: "stopped",
    transcript_document_id: transcript,
    created_at: madeAt,
    updated_at: madeAt,
  });
  if (filedIn !== null) file(db, transcript, filedIn);
}

const file = (db: Database, documentId: string, groupId: string) =>
  insert(db, "document_groups", {
    id: `filed-${documentId}`,
    document_id: documentId,
    group_id: groupId,
    source: "user",
    status: "classified",
    request_id: `request-${documentId}`,
  });

/**
 * Wall W holds S; A is open; V is another wall. Each pair is filed as an earlier version could
 * leave it: the Note in one Folder, its Transcript, by a drag or Organize, in another.
 */
function seed(db: Database) {
  folder(db, "W", null, true);
  folder(db, "S", "W", false);
  folder(db, "A", null, false);
  folder(db, "V", null, true);
  // The Transcript behind a wall its Note isn't behind: the Note goes in with it.
  pair(db, { id: "n1", folderId: "A" }, "t1", "S");
  // The Note behind the wall: its Transcript joins it there.
  pair(db, { id: "n2", folderId: "W" }, "t2", "A");
  // Together already, or apart in the open: nothing walled can come out.
  pair(db, { id: "n3", folderId: "A" }, "t3", "A");
  pair(db, { id: "n9", folderId: null }, "t9", "A");
  // Behind two walls: the Note goes to its Transcript's.
  pair(db, { id: "n4", folderId: "V" }, "t4", "W");
  // Behind the same wall, in another of its Folders: the Transcript joins the Note.
  pair(db, { id: "n5", folderId: "S" }, "t5", "W");
  // A Note in Recently deleted goes in with its Transcript too, so its Restore lands there.
  pair(db, { id: "n6", folderId: "A", deletedAt: DELETED }, "t6", "W");
  // A Note deleted permanently: its Transcript keeps a row of its own, where it is.
  pair(db, { id: "n7", folderId: null, deletedAt: DELETED, purgedAt: DELETED }, "t7", "A");
  // Several Meetings: the first Meeting's Transcript decides.
  pair(db, { id: "n8", folderId: null }, "t8b", "V", "2026-10-21T09:00:00.000Z");
  pair(db, { id: "n8", folderId: null }, "t8a", "W", "2026-10-20T09:00:00.000Z");
  // A .vtt the User added is their own Document: it is left as it is.
  insert(db, "documents", {
    id: "u1",
    content_hash: "hash-u1",
    name: "Weekly call.vtt",
    kind: "transcript",
    size: 1,
    status: "ready",
    path: "/home/someone/Weekly call.vtt",
    source_kind: "file",
  });
  file(db, "u1", "A");
  // Tags and a turned-down Folder on a Transcript go; the User's own file keeps its Tag.
  insert(db, "tags", { id: "tag", name: "Calls", description: "" });
  for (const id of ["t3", "u1"]) {
    insert(db, "document_tags", {
      id: `tagged-${id}`,
      document_id: id,
      tag_id: "tag",
      source: "automatic",
    });
  }
  insert(db, "document_group_rejections", { id: "turned-down", document_id: "t3", group_id: "W" });
}

const notes = (db: Database) =>
  db.all<{ id: string; folder_id: string | null }>("SELECT id, folder_id FROM minds ORDER BY id");
const notesOfDocuments = (db: Database) =>
  db.all<{ id: string; meeting_mind_id: string | null }>(
    "SELECT id, meeting_mind_id FROM documents ORDER BY id",
  );
const filed = (db: Database) =>
  db.all<{ document_id: string; group_id: string }>(
    "SELECT document_id, group_id FROM document_groups WHERE deleted_at IS NULL ORDER BY document_id",
  );
const joins = (db: Database) =>
  db.all<{ mind_id: string; from_folder_id: string | null; to_folder_id: string }>(
    "SELECT mind_id, from_folder_id, to_folder_id FROM meeting_joins ORDER BY mind_id",
  );
const liveTags = (db: Database) =>
  db.all<{ document_id: string }>(
    "SELECT document_id FROM document_tags WHERE deleted_at IS NULL ORDER BY document_id",
  );
const liveRejections = (db: Database) =>
  db.all<{ id: string }>("SELECT id FROM document_group_rejections WHERE deleted_at IS NULL");

async function seeded(file?: string): Promise<Database> {
  const db = openDatabase(file ?? join(await createTempDataFolder(), "test.db"));
  migrate(db, before);
  seed(db);
  return db;
}

/** Every Document and Note there is, live or deleted, as each was left. */
const everything = (db: Database) => ({
  documents: db.all<{ id: string; deleted_at: string | null; purged_at: string | null }>(
    "SELECT id, deleted_at, purged_at FROM documents ORDER BY id",
  ),
  notes: db.all<{ id: string; title: string; deleted_at: string | null }>(
    "SELECT id, title, deleted_at FROM minds ORDER BY id",
  ),
});

describe("Migration: a Meeting's Transcript belongs to its Note (#2528)", () => {
  test("pairs filed apart join once, on the walled side when a wall lies between them", async () => {
    const db = await seeded();
    const kept = everything(db);
    migrate(db);

    // Every Document and Note is still there, as it was; only Folders changed.
    expect(everything(db)).toEqual(kept);
    expect(kept.documents).toHaveLength(11);
    expect(kept.notes).toHaveLength(9);

    expect(notes(db)).toEqual([
      { id: "n1", folder_id: "S" },
      { id: "n2", folder_id: "W" },
      { id: "n3", folder_id: "A" },
      { id: "n4", folder_id: "W" },
      { id: "n5", folder_id: "S" },
      { id: "n6", folder_id: "W" },
      { id: "n7", folder_id: null },
      { id: "n8", folder_id: "W" },
      { id: "n9", folder_id: null },
    ]);
    expect(joins(db)).toEqual([
      { mind_id: "n1", from_folder_id: "A", to_folder_id: "S" },
      { mind_id: "n4", from_folder_id: "V", to_folder_id: "W" },
      { mind_id: "n6", from_folder_id: "A", to_folder_id: "W" },
      { mind_id: "n8", from_folder_id: null, to_folder_id: "W" },
    ]);
    expect(notesOfDocuments(db)).toEqual([
      { id: "t1", meeting_mind_id: "n1" },
      { id: "t2", meeting_mind_id: "n2" },
      { id: "t3", meeting_mind_id: "n3" },
      { id: "t4", meeting_mind_id: "n4" },
      { id: "t5", meeting_mind_id: "n5" },
      { id: "t6", meeting_mind_id: "n6" },
      { id: "t7", meeting_mind_id: null },
      { id: "t8a", meeting_mind_id: "n8" },
      { id: "t8b", meeting_mind_id: "n8" },
      { id: "t9", meeting_mind_id: "n9" },
      { id: "u1", meeting_mind_id: null },
    ]);
    // Only the Transcript with no Note keeps a Folder, and the User's own file.
    expect(filed(db)).toEqual([
      { document_id: "t7", group_id: "A" },
      { document_id: "u1", group_id: "A" },
    ]);
    expect(liveTags(db)).toEqual([{ document_id: "u1" }]);
    expect(liveRejections(db)).toEqual([]);
    const join = db.get<{ id: string; created_at: string; said_at: string | null }>(
      "SELECT id, created_at, said_at FROM meeting_joins WHERE mind_id = 'n1'",
    );
    expect(join?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(join?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(join?.said_at).toBeNull();
    db.close();
  });

  test("run again it changes nothing", async () => {
    const db = await seeded();
    migrate(db);
    const once = {
      notes: notes(db),
      joins: joins(db),
      notesOf: notesOfDocuments(db),
      filed: filed(db),
    };

    migrate(db);

    expect({
      notes: notes(db),
      joins: joins(db),
      notesOf: notesOfDocuments(db),
      filed: filed(db),
    }).toEqual(once);
    expect(joins(db)).toHaveLength(4);
    db.close();
  });

  test("stopped halfway, it leaves the database as it was, and the next start joins each pair once", async () => {
    const db = await seeded();
    const startNotes = notes(db);
    const startFiled = filed(db);
    const halfway: Migration = {
      version: ours.version + 100_000,
      description: "a quit halfway",
      sql: "INSERT INTO no_such_table VALUES (1);",
    };

    expect(() => migrate(db, [...before, ours, halfway])).toThrow();

    const columns = db.all<{ name: string }>("PRAGMA table_info(documents)").map((c) => c.name);
    expect(columns).not.toContain("meeting_mind_id");
    expect(notes(db)).toEqual(startNotes);
    expect(filed(db)).toEqual(startFiled);
    expect(
      db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting_joins'"),
    ).toBeUndefined();

    migrate(db);
    expect(joins(db)).toHaveLength(4);
    expect(notes(db).find((each) => each.id === "n1")).toEqual({ id: "n1", folder_id: "S" });
    db.close();
  });
});

describe("A database from before, opened by this version (#2528)", () => {
  test("keeps every Document and Note, says each Note it moved, and Undo puts each back where it was", async () => {
    const dataDir = await createTempDataFolder();
    const seededDb = await seeded(join(dataDir, DATABASE_FILE));
    const before = seededDb.all<{ id: string; folder_id: string | null }>(
      "SELECT id, folder_id FROM minds WHERE deleted_at IS NULL ORDER BY id",
    );
    seededDb.close();

    const core = startCore(dataDir, { now: manualClock("2026-10-26T09:00:00.000Z").now });

    const live = ["t1", "t2", "t3", "t4", "t5", "t7", "t8a", "t8b", "t9", "u1"];
    expect((await core.listDocuments()).map((each) => each.id).sort()).toEqual(live);
    expect((await core.listMinds()).map((mind) => mind.id).sort()).toEqual(
      before.map((each) => each.id),
    );
    // The Transcript an earlier version left live beside its deleted Note waits with it, as one item.
    expect(
      (await core.listDeleted()).map((item) => [item.kind, item.id, item.meeting?.transcript]),
    ).toEqual([["mind", "n6", true]]);
    expect((await core.listDocuments()).find((each) => each.id === "t7")?.meetingMindId).toBeNull();
    expect((await core.listDocuments()).find((each) => each.id === "t1")?.meetingMindId).toBe("n1");

    const joined = await core.listJoinedMeetings();
    expect(
      joined.map(({ mindId, folderId, fromFolderId }) => ({ mindId, folderId, fromFolderId })),
    ).toEqual([
      { mindId: "n1", folderId: "S", fromFolderId: "A" },
      { mindId: "n4", folderId: "W", fromFolderId: "V" },
      { mindId: "n8", folderId: "W", fromFolderId: null },
    ]);

    // Undo, as the sidebar's line does: each Note goes back where it was, its Transcript with it.
    for (const join of joined) {
      await core.moveToFolder({ mindIds: [join.mindId], folderId: join.fromFolderId });
    }
    expect(
      (await core.listMinds())
        .map((mind) => ({ id: mind.id, folder_id: mind.folderId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(before);
    expect((await core.listDocuments()).map((each) => each.id).sort()).toEqual(live);
    core.close();
  });
});
