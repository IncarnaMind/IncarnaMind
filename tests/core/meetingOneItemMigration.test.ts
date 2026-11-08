/**
 * The migration that makes a Meeting's Transcript belong to its Note (#2528), on a database as the
 * version before it left one: with no wall between them a pair joins where its Note is; with one,
 * on its walled side; with two, it stays apart. Nothing ever comes out of a wall. It runs in the
 * transaction of every migration due, so a quit halfway leaves the database as it was, and it runs
 * once.
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
  // The Transcript behind a wall its Note, outside every wall, isn't behind: the Note goes in.
  pair(db, { id: "n1", folderId: "A" }, "t1", "S");
  // The Note behind the wall, its Transcript outside: the Transcript goes in.
  pair(db, { id: "n2", folderId: "W" }, "t2", "A");
  // Together already, or apart with no wall between: the Transcript goes where its Note is.
  pair(db, { id: "n3", folderId: "A" }, "t3", "A");
  pair(db, { id: "n9", folderId: null }, "t9", "A");
  // Behind two different walls: left apart.
  pair(db, { id: "n4", folderId: "V" }, "t4", "W");
  // Behind the same wall, in another of its Folders: joined, moving only inside the wall.
  pair(db, { id: "n5", folderId: "S" }, "t5", "W");
  // A Note in Recently deleted, its Transcript behind a wall: the Note goes in, for a Restore.
  pair(db, { id: "n6", folderId: "A", deletedAt: DELETED }, "t6", "W");
  // A Note deleted permanently: its Transcript keeps a row of its own, where it is.
  pair(db, { id: "n7", folderId: null, deletedAt: DELETED, purgedAt: DELETED }, "t7", "A");
  // A Note outside every wall, its meetings' Transcripts behind two: both left apart, the Note
  // where it is (no first Meeting decides).
  pair(db, { id: "n8", folderId: null }, "t8b", "V", "2026-10-21T09:00:00.000Z");
  pair(db, { id: "n8", folderId: null }, "t8a", "W", "2026-10-20T09:00:00.000Z");
  // A Note behind a wall with a Transcript behind it and one behind another: the first joins,
  // the second is left apart, and the Note stays.
  pair(db, { id: "n10", folderId: "W" }, "t10a", "W", "2026-10-20T09:00:00.000Z");
  pair(db, { id: "n10", folderId: "W" }, "t10b", "V", "2026-10-21T09:00:00.000Z");
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
  // Tags and a turned-down Folder on a joined Transcript go; the User's own file keeps its Tag,
  // and so does a Transcript left apart.
  insert(db, "tags", { id: "tag", name: "Calls", description: "" });
  for (const id of ["t3", "t1", "t4", "u1"]) {
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
  db.all<{ mind_id: string; folder_id: string | null; from_folder_id: string | null }>(
    "SELECT mind_id, folder_id, from_folder_id FROM meeting_joins ORDER BY mind_id",
  );
const crossed = (db: Database) =>
  db
    .all<{ mind_id: string; document_id: string }>(
      `SELECT j.mind_id, t.document_id FROM meeting_join_transcripts t
       JOIN meeting_joins j ON j.id = t.join_id ORDER BY t.document_id`,
    )
    .map((row) => [row.mind_id, row.document_id]);
const leftApart = (db: Database) =>
  db
    .all<{ mind_id: string }>("SELECT mind_id FROM meetings_left_apart ORDER BY mind_id")
    .map((row) => row.mind_id);
const liveTags = (db: Database) =>
  db
    .all<{ document_id: string }>(
      "SELECT document_id FROM document_tags WHERE deleted_at IS NULL ORDER BY document_id",
    )
    .map((row) => row.document_id);
/** What an earlier version's turned-down Folders became (migration 137). */
const liveDeclines = (db: Database) =>
  db.all<{ id: string }>("SELECT id FROM organize_review_declines WHERE deleted_at IS NULL");

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
  notes: db.all<{ id: string; title: string; folder_id: string | null; deleted_at: string | null }>(
    "SELECT id, title, folder_id, deleted_at FROM minds ORDER BY id",
  ),
});

/** The wall each Folder is behind, as the Library works it out: W holds S; V is another; A none. */
const WALL_OF: Record<string, string | null> = { W: "W", S: "W", V: "V", A: null };
const wallOf = (folderId: string | null | undefined) => (folderId ? WALL_OF[folderId] : null);

/** Each Note's wall, and each meeting's Transcript's: its own Folder's, or once joined its Note's. */
function walls(db: Database, joined: boolean) {
  const noteFolder = new Map(notes(db).map((each) => [each.id, each.folder_id]));
  const filedIn = new Map(filed(db).map((each) => [each.document_id, each.group_id]));
  const documents = joined
    ? notesOfDocuments(db)
    : db
        .all<{ id: string }>("SELECT id FROM documents ORDER BY id")
        .map((row) => ({ id: row.id, meeting_mind_id: null }));
  return {
    notes: new Map([...noteFolder].map(([id, folderId]) => [id, wallOf(folderId)])),
    transcripts: new Map(
      documents
        .filter((each) => each.id !== "u1")
        .map((each) => [
          each.id,
          wallOf(
            each.meeting_mind_id ? noteFolder.get(each.meeting_mind_id) : filedIn.get(each.id),
          ),
        ]),
    ),
  };
}

describe("Migration: a Meeting's Transcript belongs to its Note (#2528)", () => {
  test("pairs join where their Note is, on the walled side of one wall, and stay apart across two", async () => {
    const db = await seeded();
    const kept = everything(db);
    migrate(db);

    // Every Document and Note is still there; nothing was erased.
    expect(everything(db).documents).toEqual(kept.documents);
    expect(
      everything(db).notes.map(({ id, title, deleted_at }) => ({ id, title, deleted_at })),
    ).toEqual(kept.notes.map(({ id, title, deleted_at }) => ({ id, title, deleted_at })));
    expect(kept.documents).toHaveLength(13);
    expect(kept.notes).toHaveLength(10);

    // Only the two Notes outside every wall whose Transcript was behind one moved, into it.
    expect(notes(db)).toEqual([
      { id: "n1", folder_id: "S" },
      { id: "n10", folder_id: "W" },
      { id: "n2", folder_id: "W" },
      { id: "n3", folder_id: "A" },
      { id: "n4", folder_id: "V" },
      { id: "n5", folder_id: "S" },
      { id: "n6", folder_id: "W" },
      { id: "n7", folder_id: null },
      { id: "n8", folder_id: null },
      { id: "n9", folder_id: null },
    ]);
    expect(notesOfDocuments(db)).toEqual([
      { id: "t1", meeting_mind_id: "n1" },
      { id: "t10a", meeting_mind_id: "n10" },
      { id: "t10b", meeting_mind_id: null },
      { id: "t2", meeting_mind_id: "n2" },
      { id: "t3", meeting_mind_id: "n3" },
      { id: "t4", meeting_mind_id: null },
      { id: "t5", meeting_mind_id: "n5" },
      { id: "t6", meeting_mind_id: "n6" },
      { id: "t7", meeting_mind_id: null },
      { id: "t8a", meeting_mind_id: null },
      { id: "t8b", meeting_mind_id: null },
      { id: "t9", meeting_mind_id: "n9" },
      { id: "u1", meeting_mind_id: null },
    ]);
    // A Transcript left apart keeps its own Folder, as does one with no Note and the User's file.
    expect(filed(db)).toEqual([
      { document_id: "t10b", group_id: "V" },
      { document_id: "t4", group_id: "W" },
      { document_id: "t7", group_id: "A" },
      { document_id: "t8a", group_id: "W" },
      { document_id: "t8b", group_id: "V" },
      { document_id: "u1", group_id: "A" },
    ]);
    expect(joins(db)).toEqual([
      { mind_id: "n1", folder_id: "S", from_folder_id: "A" },
      { mind_id: "n2", folder_id: "W", from_folder_id: "W" },
      { mind_id: "n6", folder_id: "W", from_folder_id: "A" },
    ]);
    expect(crossed(db)).toEqual([
      ["n1", "t1"],
      ["n2", "t2"],
      ["n6", "t6"],
    ]);
    expect(leftApart(db)).toEqual(["n10", "n4", "n8"]);
    expect(liveTags(db)).toEqual(["t4", "u1"]);
    expect(liveDeclines(db)).toEqual([]);
    const row = db.get<{ id: string; created_at: string; said_at: string | null }>(
      "SELECT id, created_at, said_at FROM meeting_joins WHERE mind_id = 'n1'",
    );
    expect(row?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row?.said_at).toBeNull();
    db.close();
  });

  test("nothing walled comes out, and nothing goes behind another wall: an outside half only goes in", async () => {
    const db = await seeded();
    const before = walls(db, false);
    migrate(db);
    const after = walls(db, true);

    for (const [kind, then] of [
      ["notes", before.notes],
      ["transcripts", before.transcripts],
    ] as const) {
      for (const [id, wall] of then) {
        const now = after[kind].get(id);
        if (wall !== null) expect({ id, wall: now }).toEqual({ id, wall });
      }
    }
    // The outside halves that moved went in, onto their pair's walled side.
    type Walls = ReadonlyMap<string, string | null | undefined>;
    const wentIn = (then: Walls, now: Walls) =>
      [...then].filter(([id, wall]) => wall === null && now.get(id) !== null).map(([id]) => id);
    expect([
      ...wentIn(before.notes, after.notes),
      ...wentIn(before.transcripts, after.transcripts),
    ]).toEqual(["n1", "n6", "t2"]);
    db.close();
  });

  test("a Note outside every wall with its Transcript behind one goes in; a walled Note takes its Transcript in", async () => {
    const db = await seeded();
    migrate(db);

    expect(notes(db).filter((each) => each.id === "n1" || each.id === "n2")).toEqual([
      { id: "n1", folder_id: "S" },
      { id: "n2", folder_id: "W" },
    ]);
    expect(notesOfDocuments(db).filter((each) => each.id === "t1" || each.id === "t2")).toEqual([
      { id: "t1", meeting_mind_id: "n1" },
      { id: "t2", meeting_mind_id: "n2" },
    ]);
    db.close();
  });

  test("no first Meeting decides for a Note whose Transcripts are behind two walls: it stays where it is", async () => {
    const db = await seeded();
    migrate(db);

    expect(notes(db).filter((each) => each.id === "n8" || each.id === "n10")).toEqual([
      { id: "n10", folder_id: "W" },
      { id: "n8", folder_id: null },
    ]);
    expect(filed(db).filter((each) => /^t(8|10)/.test(each.document_id))).toEqual([
      { document_id: "t10b", group_id: "V" },
      { document_id: "t8a", group_id: "W" },
      { document_id: "t8b", group_id: "V" },
    ]);
    expect(notesOfDocuments(db).filter((each) => /^t(8|10)/.test(each.id))).toEqual([
      { id: "t10a", meeting_mind_id: "n10" },
      { id: "t10b", meeting_mind_id: null },
      { id: "t8a", meeting_mind_id: null },
      { id: "t8b", meeting_mind_id: null },
    ]);
    db.close();
  });

  test("run again it changes nothing", async () => {
    const db = await seeded();
    migrate(db);
    const once = {
      notes: notes(db),
      joins: joins(db),
      leftApart: leftApart(db),
      notesOf: notesOfDocuments(db),
      filed: filed(db),
    };

    migrate(db);

    expect({
      notes: notes(db),
      joins: joins(db),
      leftApart: leftApart(db),
      notesOf: notesOfDocuments(db),
      filed: filed(db),
    }).toEqual(once);
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
    for (const table of ["meeting_joins", "meeting_join_transcripts", "meetings_left_apart"]) {
      expect(
        db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]),
      ).toBeUndefined();
    }

    migrate(db);
    expect(joins(db)).toHaveLength(3);
    expect(leftApart(db)).toHaveLength(3);
    expect(notesOfDocuments(db).filter((each) => each.meeting_mind_id !== null)).toHaveLength(7);
    db.close();
  });
});

describe("A database from before, opened by this version (#2528)", () => {
  test("an Organize suggestion is no wall: the pair joins where its Note is, and the Note stays", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(db, before);
    folder(db, "W", null, true);
    folder(db, "A", null, false);
    pair(db, { id: "n1", folderId: "A" }, "t1", null);
    insert(db, "document_groups", {
      id: "suggested-t1",
      document_id: "t1",
      group_id: "W",
      source: "automatic",
      status: "classified",
      request_id: "request-t1",
    });
    migrate(db);
    expect(notes(db)).toEqual([{ id: "n1", folder_id: "A" }]);
    expect(notesOfDocuments(db)).toEqual([{ id: "t1", meeting_mind_id: "n1" }]);
    expect(joins(db)).toEqual([]);
    db.close();
  });

  test("a Tag deleted before, restored after, doesn't come back on a joined Transcript", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(db, before);
    folder(db, "A", null, false);
    pair(db, { id: "n1", folderId: "A" }, "t1", "A");
    insert(db, "tags", { id: "gone", name: "Calls", description: "", deleted_at: DELETED });
    insert(db, "document_tags", {
      id: "tagged-t1",
      document_id: "t1",
      tag_id: "gone",
      source: "user",
      deleted_at: DELETED,
    });
    db.close();

    const core = startCore(dataDir);
    await core.restore([{ kind: "tag", id: "gone" }]);
    expect((await core.listTags()).map((tag) => tag.id)).toEqual(["gone"]);
    expect((await core.listDocuments()).find((each) => each.id === "t1")?.tags).toEqual([]);
    core.close();
  });

  test("a start never fails on a Transcript in Recently deleted whose Note is gone for good, and two starts agree", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(db, before);
    folder(db, "W", null, true);
    pair(db, { id: "n1", folderId: "W" }, "t1", "W");
    // The version before let the User delete a Transcript on its own.
    db.run("UPDATE documents SET deleted_at = ? WHERE id = 't1'", [DELETED]);
    db.close();
    startCore(dataDir).close();
    const after = openDatabase(join(dataDir, DATABASE_FILE));
    after.run("UPDATE minds SET deleted_at = ?, purged_at = ? WHERE id = 'n1'", [DELETED, DELETED]);
    after.close();

    const placed = () => {
      const read = openDatabase(join(dataDir, DATABASE_FILE));
      const state = {
        transcript: read.get<{ meeting_mind_id: string | null; deleted: number }>(
          "SELECT meeting_mind_id, deleted_at IS NOT NULL AS deleted FROM documents WHERE id = 't1'",
        ),
        filed: read.all<{ group_id: string; source: string }>(
          "SELECT group_id, source FROM document_groups WHERE document_id = 't1' AND deleted_at IS NULL",
        ),
      };
      read.close();
      return state;
    };
    for (const start of [1, 2]) {
      const core = startCore(dataDir);
      expect(
        (await core.listDeleted()).map((item) => [item.kind, item.id]),
        `start ${start}`,
      ).toEqual([["document", "t1"]]);
      core.close();
      expect(placed(), `start ${start}`).toEqual({
        transcript: { meeting_mind_id: null, deleted: 1 },
        filed: [{ group_id: "W", source: "user" }],
      });
    }

    // Restored, it is back behind its wall, a Document of its own.
    const core = startCore(dataDir);
    await core.restore([{ kind: "document", id: "t1" }]);
    expect(
      (await core.getLibrary()).assignments
        .filter((each) => each.documentId === "t1")
        .map((each) => each.groupId),
    ).toEqual(["W"]);
    core.close();
  });

  test("a Transcript whose Note was deleted permanently stays in its Note's Folder, behind its wall", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(db, before);
    folder(db, "W", null, true);
    pair(db, { id: "n1", folderId: "W" }, "t1", "W");
    migrate(db);
    // Deleted permanently after the upgrade while its Transcript stayed, as a failed removal can.
    db.run("UPDATE minds SET deleted_at = ?, purged_at = ? WHERE id = 'n1'", [DELETED, DELETED]);
    db.close();

    const core = startCore(dataDir);
    const t1 = (await core.listDocuments()).find((each) => each.id === "t1");
    expect(t1?.meetingMindId).toBeNull();
    expect(
      (await core.getLibrary()).assignments
        .filter((each) => each.documentId === "t1")
        .map(({ groupId, source }) => ({ groupId, source })),
    ).toEqual([{ groupId: "W", source: "user" }]);
    core.close();
  });

  test("keeps every Document and Note, says each join once, and Undo puts a pair back exactly as it was", async () => {
    const dataDir = await createTempDataFolder();
    const seededDb = await seeded(join(dataDir, DATABASE_FILE));
    seededDb.close();

    const core = startCore(dataDir, { now: manualClock("2026-10-26T09:00:00.000Z").now });

    const live = ["t1", "t10a", "t10b", "t2", "t3", "t4", "t5", "t7", "t8a", "t8b", "t9", "u1"];
    // The Transcript joined to the Note in Recently deleted waits there with it, as one item.
    expect((await core.listDocuments()).map((each) => each.id).sort()).toEqual(live);
    expect((await core.listDeleted()).map((item) => [item.kind, item.id])).toEqual([
      ["mind", "n6"],
    ]);

    // The Note in Recently deleted isn't said until it is back.
    const joined = await core.listJoinedMeetings();
    expect(
      joined.map(({ mindId, folderId, noteMoved }) => ({ mindId, folderId, noteMoved })),
    ).toEqual([
      { mindId: "n1", folderId: "S", noteMoved: true },
      { mindId: "n2", folderId: "W", noteMoved: false },
    ]);
    const left = await core.listMeetingsLeftApart();
    expect(left.map((each) => each.mindId)).toEqual(["n10", "n4", "n8"]);

    // Undo the Note that went in: it goes back out, its Transcript stays behind the wall, a
    // Document of its own again with its Folder and Tag.
    await core.undoMeetingJoin(joined[0]?.id as string);
    const folderOf = async (id: string) =>
      (await core.listMinds()).find((mind) => mind.id === id)?.folderId;
    expect(await folderOf("n1")).toBe("A");
    const t1 = (await core.listDocuments()).find((each) => each.id === "t1");
    expect(t1?.meetingMindId).toBeNull();
    expect(t1?.tags.map((each) => each.tagId)).toEqual(["tag"]);
    expect(
      (await core.getLibrary()).assignments
        .filter((each) => each.documentId === "t1")
        .map((each) => each.groupId),
    ).toEqual(["S"]);

    // Undo the Transcript that went in: it goes back to its Folder, the Note stays.
    await core.undoMeetingJoin(joined[1]?.id as string);
    expect(await folderOf("n2")).toBe("W");
    expect((await core.listDocuments()).find((each) => each.id === "t2")?.meetingMindId).toBeNull();
    expect(
      (await core.getLibrary()).assignments
        .filter((each) => each.documentId === "t2")
        .map((each) => each.groupId),
    ).toEqual(["A"]);
    await expect(core.undoMeetingJoin(joined[1]?.id as string)).rejects.toMatchObject({
      wording: { key: "error.meeting.joinMoved" },
    });
    expect(await core.listJoinedMeetings()).toEqual([]);

    await core.meetingsLeftApartSaid(left.map((each) => each.id));
    expect(await core.listMeetingsLeftApart()).toEqual([]);
    core.close();
  });

  test("says a join once, and not again at the next start though the User did nothing with it", async () => {
    const dataDir = await createTempDataFolder();
    (await seeded(join(dataDir, DATABASE_FILE))).close();

    const first = startCore(dataDir);
    const joined = await first.listJoinedMeetings();
    expect(joined).toHaveLength(2);
    await first.joinedMeetingsSaid(joined.map((each) => each.id));
    first.close();

    const again = startCore(dataDir);
    expect(await again.listJoinedMeetings()).toEqual([]);
    expect((await again.listMinds()).find((mind) => mind.id === "n1")?.folderId).toBe("S");
    again.close();
  });

  test("Undo is refused once the User has moved the Note since, and the join is no longer said", async () => {
    const dataDir = await createTempDataFolder();
    (await seeded(join(dataDir, DATABASE_FILE))).close();
    const core = startCore(dataDir);
    const [first] = await core.listJoinedMeetings();
    await core.moveToFolder({ mindIds: ["n1"], folderId: "W" });

    await expect(core.undoMeetingJoin(first?.id as string)).rejects.toMatchObject({
      wording: { key: "error.meeting.joinMoved" },
    });
    expect((await core.listJoinedMeetings()).map((each) => each.mindId)).toEqual(["n2"]);
    expect((await core.listDocuments()).find((each) => each.id === "t1")?.meetingMindId).toBe("n1");
    core.close();
  });
});
