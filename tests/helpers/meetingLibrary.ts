/**
 * A Library as the version before #2528 could leave it, at size: 2,000 Documents, 300 of them
 * Meetings' Transcripts in 280 Notes, filed every way a drag or Organize could file them. Made-up
 * names only. Folders A1–A10 are open; W1–W5 keep their work inside them, each with a sub-Folder
 * S1–S5.
 */
import type { Database, SqlValue } from "../../src/core/storage";

const AT = "2026-10-20T09:00:00.000Z";
const LATER = "2026-10-21T09:00:00.000Z";
export const DELETED_AT = "2026-10-25T09:00:00.000Z";

/** Inserts rows into a table, every column it needs filled with a plain placeholder. */
function rowsInto(db: Database, table: string) {
  const columns = db.all<{ name: string; type: string; notnull: number; dflt_value: unknown }>(
    `PRAGMA table_info(${table})`,
  );
  return (values: Record<string, SqlValue>) => {
    const row: Record<string, SqlValue> = {};
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
  };
}

const open = (i: number) => `A${(i % 10) + 1}`;
const wall = (i: number) => `W${(i % 5) + 1}`;
const inWall = (i: number) => `S${(i % 5) + 1}`;

export function seedMeetingLibrary(db: Database): void {
  db.transaction(() => {
    const folder = rowsInto(db, "library_groups");
    const mind = rowsInto(db, "minds");
    const document = rowsInto(db, "documents");
    const meeting = rowsInto(db, "meetings");
    const filed = rowsInto(db, "document_groups");
    const tag = rowsInto(db, "tags");
    const tagged = rowsInto(db, "document_tags");

    for (let i = 0; i < 10; i++) {
      folder({ id: open(i), name: `Harbour ${i + 1}`, description: "", keep_inside: 0 });
    }
    for (let i = 0; i < 5; i++) {
      folder({ id: wall(i), name: `Client ${i + 1}`, description: "", keep_inside: 1 });
      folder({ id: inWall(i), name: `Client ${i + 1} files`, description: "", parent_id: wall(i) });
    }
    tag({ id: "tag-calls", name: "Calls", description: "" });

    const file = (documentId: string, groupId: string | null) => {
      if (groupId === null) return;
      filed({
        id: `filed-${documentId}`,
        document_id: documentId,
        group_id: groupId,
        source: "user",
        status: "classified",
        request_id: `request-${documentId}`,
      });
    };
    const transcript = (
      id: string,
      mindId: string,
      groupId: string | null,
      { madeAt = AT, deletedAt = null }: { madeAt?: string; deletedAt?: string | null } = {},
    ) => {
      document({
        id,
        content_hash: `hash-${id}`,
        name: `Transcript · Call ${mindId}`,
        kind: "transcript",
        size: 1,
        status: "ready",
        path: `/data/Transcripts/${id}.vtt`,
        source_kind: "data-folder",
        relative_path: `Transcripts/${id}.vtt`,
        deleted_at: deletedAt,
      });
      meeting({
        id: `meeting-${id}`,
        mind_id: mindId,
        status: "stopped",
        transcript_document_id: id,
        created_at: madeAt,
        updated_at: madeAt,
        deleted_at: deletedAt,
      });
      file(id, groupId);
    };
    const note = (
      id: string,
      folderId: string | null,
      {
        deletedAt = null,
        purgedAt = null,
      }: { deletedAt?: string | null; purgedAt?: string | null } = {},
    ) =>
      mind({
        id,
        title: `Call ${id}`,
        folder_id: folderId,
        deleted_at: deletedAt,
        purged_at: purgedAt,
      });

    // Together already: 80, their Transcripts tagged by Organize.
    for (let i = 0; i < 80; i++) {
      note(`n-same-${i}`, open(i));
      transcript(`t-same-${i}`, `n-same-${i}`, open(i));
      tagged({
        id: `tag-t-same-${i}`,
        document_id: `t-same-${i}`,
        tag_id: "tag-calls",
        source: "automatic",
      });
    }
    // Behind the same wall, the Note in its sub-Folder: 20, tagged by Organize too.
    for (let i = 0; i < 20; i++) {
      note(`n-within-${i}`, inWall(i));
      transcript(`t-within-${i}`, `n-within-${i}`, wall(i));
      tagged({
        id: `tag-t-within-${i}`,
        document_id: `t-within-${i}`,
        tag_id: "tag-calls",
        source: "automatic",
      });
    }
    // Apart in the open: 60, the Note in one Folder, its Transcript in the next.
    for (let i = 0; i < 60; i++) {
      note(`n-apart-${i}`, open(i));
      transcript(`t-apart-${i}`, `n-apart-${i}`, open(i + 1));
    }
    // The Transcript behind a wall its Note isn't behind: 40, half the Notes in no Folder, half
    // the Transcripts in the wall's sub-Folder.
    for (let i = 0; i < 40; i++) {
      note(`n-walled-${i}`, i % 2 === 0 ? null : open(i));
      transcript(`t-walled-${i}`, `n-walled-${i}`, i % 4 < 2 ? wall(i) : inWall(i));
    }
    // The Note behind the wall, its Transcript in the open: 20.
    for (let i = 0; i < 20; i++) {
      note(`n-inside-${i}`, wall(i));
      transcript(`t-inside-${i}`, `n-inside-${i}`, open(i));
    }
    // A Note with Transcripts behind two walls: 20 Notes, 40 Transcripts.
    for (let i = 0; i < 20; i++) {
      note(`n-two-${i}`, open(i));
      transcript(`t-two-a-${i}`, `n-two-${i}`, wall(i), { madeAt: AT });
      transcript(`t-two-b-${i}`, `n-two-${i}`, wall(i + 1), { madeAt: LATER });
    }
    // A Note deleted permanently: 20, its Transcript left live.
    for (let i = 0; i < 20; i++) {
      note(`n-gone-${i}`, null, { deletedAt: DELETED_AT, purgedAt: DELETED_AT });
      transcript(`t-gone-${i}`, `n-gone-${i}`, open(i));
    }
    // A pair waiting in Recently deleted, the Transcript behind a wall: 20.
    for (let i = 0; i < 20; i++) {
      note(`n-bin-${i}`, open(i), { deletedAt: DELETED_AT });
      transcript(`t-bin-${i}`, `n-bin-${i}`, wall(i), { deletedAt: DELETED_AT });
    }
    // A .vtt the User added: 20, filed and tagged as the User did.
    for (let i = 0; i < 20; i++) {
      document({
        id: `vtt-${i}`,
        content_hash: `hash-vtt-${i}`,
        name: `Weekly call ${i}.vtt`,
        kind: "transcript",
        size: 1,
        status: "ready",
        path: `/home/someone/calls/Weekly call ${i}.vtt`,
        source_kind: "file",
      });
      file(`vtt-${i}`, open(i));
      tagged({ id: `tag-vtt-${i}`, document_id: `vtt-${i}`, tag_id: "tag-calls", source: "user" });
    }
    // The rest of the Library: 1,680 Documents, two in three filed, one in ten tagged.
    for (let i = 0; i < 1680; i++) {
      const id = `doc-${i}`;
      document({
        id,
        content_hash: `hash-${id}`,
        name: `Survey ${i}.pdf`,
        kind: "pdf",
        size: 1,
        status: "ready",
        path: `/home/someone/surveys/Survey ${i}.pdf`,
        source_kind: "file",
      });
      file(id, i % 3 === 0 ? null : i % 3 === 1 ? open(i) : inWall(i));
      if (i % 10 === 0) {
        tagged({ id: `tag-${id}`, document_id: id, tag_id: "tag-calls", source: "automatic" });
      }
    }
  });
}

/** Each live Folder's nearest wall, or null, as the Library works it out. */
export function wallsOf(db: Database): Map<string, string | null> {
  const folders = db.all<{ id: string; parent_id: string | null; keep_inside: number }>(
    "SELECT id, parent_id, keep_inside FROM library_groups WHERE deleted_at IS NULL",
  );
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const walls = new Map<string, string | null>();
  for (const folder of folders) {
    let at: (typeof folders)[number] | undefined = folder;
    let found: string | null = null;
    const seen = new Set<string>();
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      if (at.keep_inside === 1) {
        found = at.id;
        break;
      }
      at = at.parent_id === null ? undefined : byId.get(at.parent_id);
    }
    walls.set(folder.id, found);
  }
  return walls;
}
