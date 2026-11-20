/**
 * Files an outside agent hands over (#3412): a deck, workbook, Word file or PDF it made, named by
 * its path on this computer and read there alone, as a Canvas's files are (../canvases). Each
 * hand-over whose bytes differ is a version: its copy is kept in the data folder, the Library's one
 * Document for the item takes it as its new version, and the check makes a Note of it, as "Check
 * someone else's file" does. The same path handed over again by the same agent is the same item.
 */
import type { HandedFile, HandedFileVersion } from "../api";
import { NotFoundError } from "../errors";
import type { Database } from "../storage";

/** A handed-over file with the pairing that handed it, by which one in no Folder is reached. */
export interface StoredHandedFile extends HandedFile {
  pairingId: string;
  /** The path the agent named, by which it hands the same file over again. */
  path: string;
}

/** A version as kept: its copy in the data folder, relative to it. */
export interface StoredHandedVersion extends HandedFileVersion {
  id: string;
  file: string;
}

interface FileRow {
  id: string;
  title: string;
  kind: string;
  path: string;
  folder_id: string | null;
  pairing_id: string;
  agent: string;
  document_id: string | null;
  created_at: string;
  updated_at: string;
  version: number | bigint | null;
}

interface VersionRow {
  id: string;
  number: number | bigint;
  content_hash: string;
  size: number | bigint;
  file: string;
  mind_id: string | null;
  agent: string;
  created_at: string;
}

const LIVE = `f.id, f.title, f.kind, f.path, f.folder_id, f.pairing_id, f.agent, f.document_id,
  f.created_at, f.updated_at,
  (SELECT max(v.number) FROM agent_file_versions v WHERE v.file_id = f.id AND v.deleted_at IS NULL)
    AS version
  FROM agent_files f WHERE f.deleted_at IS NULL`;

const KINDS: readonly HandedFile["kind"][] = ["pptx", "xlsx", "docx", "pdf"];

const toFile = (row: FileRow): StoredHandedFile => ({
  id: row.id,
  title: row.title,
  kind: KINDS.find((kind) => kind === row.kind) ?? "pdf",
  folderId: row.folder_id,
  agent: row.agent,
  documentId: row.document_id,
  version: Number(row.version ?? 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  pairingId: row.pairing_id,
  path: row.path,
});

const toVersion = (row: VersionRow): StoredHandedVersion => ({
  id: row.id,
  number: Number(row.number),
  contentHash: row.content_hash,
  size: Number(row.size),
  file: row.file,
  mindId: row.mind_id,
  agent: row.agent,
  createdAt: row.created_at,
});

export function createAgentFiles(options: { db: Database; now(): string; newId(): string }) {
  const { db, now, newId } = options;

  const get = (fileId: string): StoredHandedFile | null => {
    const row = db.get<FileRow>(`SELECT ${LIVE} AND f.id = ?`, [fileId]);
    return row ? toFile(row) : null;
  };

  const requireFile = (fileId: string): StoredHandedFile => {
    const file = get(fileId);
    if (!file) throw new NotFoundError({ key: "error.handedFile.notFound" });
    return file;
  };

  const versions = (fileId: string): StoredHandedVersion[] =>
    db
      .all<VersionRow>(
        `SELECT id, number, content_hash, size, file, mind_id, agent, created_at
         FROM agent_file_versions WHERE file_id = ? AND deleted_at IS NULL ORDER BY number`,
        [fileId],
      )
      .map(toVersion);

  return {
    get,

    list: (): StoredHandedFile[] =>
      db.all<FileRow>(`SELECT ${LIVE} ORDER BY f.updated_at DESC, f.rowid DESC`).map(toFile),

    /** The item this pairing handed over from `path`, if there is one. */
    atPath: (pairingId: string, path: string): StoredHandedFile | null => {
      const row = db.get<FileRow>(
        `SELECT ${LIVE} AND f.pairing_id = ? AND f.path = ? ORDER BY f.created_at DESC LIMIT 1`,
        [pairingId, path],
      );
      return row ? toFile(row) : null;
    },

    versions,

    /** Every version's check Note, each item's in order of its versions. */
    versionNotes: (): { fileId: string; mindId: string }[] =>
      db
        .all<{ file_id: string; mind_id: string }>(
          `SELECT v.file_id, v.mind_id FROM agent_file_versions v
           JOIN agent_files f ON f.id = v.file_id
           WHERE v.mind_id IS NOT NULL AND v.deleted_at IS NULL AND f.deleted_at IS NULL
           ORDER BY v.file_id, v.number`,
        )
        .map((row) => ({ fileId: row.file_id, mindId: row.mind_id })),

    /** The item, and which of its versions, a check's Note is of; null for a Note of none. */
    ofMind(mindId: string): { file: StoredHandedFile; version: StoredHandedVersion } | null {
      const row = db.get<{ file_id: string }>(
        `SELECT v.file_id FROM agent_file_versions v JOIN agent_files f ON f.id = v.file_id
         WHERE v.mind_id = ? AND v.deleted_at IS NULL AND f.deleted_at IS NULL LIMIT 1`,
        [mindId],
      );
      const file = row ? get(row.file_id) : null;
      const version = file ? versions(file.id).find((each) => each.mindId === mindId) : undefined;
      return file && version ? { file, version } : null;
    },

    create(input: {
      title: string;
      kind: HandedFile["kind"];
      path: string;
      folderId: string | null;
      pairingId: string;
      agent: string;
    }): StoredHandedFile {
      const id = newId();
      const at = now();
      db.run(
        `INSERT INTO agent_files (id, title, kind, path, folder_id, pairing_id, agent, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.title,
          input.kind,
          input.path,
          input.folderId,
          input.pairingId,
          input.agent,
          at,
          at,
        ],
      );
      return requireFile(id);
    },

    /** A new version: its copy, kept already, as the next number. */
    addVersion(
      fileId: string,
      input: { contentHash: string; size: number; file: string; agent: string; title: string },
    ): StoredHandedVersion {
      const at = now();
      const id = newId();
      db.transaction(() => {
        const number = (requireFile(fileId).version ?? 0) + 1;
        db.run(
          `INSERT INTO agent_file_versions (id, file_id, number, content_hash, size, file, agent,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            fileId,
            BigInt(number),
            input.contentHash,
            BigInt(input.size),
            input.file,
            input.agent,
            at,
            at,
          ],
        );
        db.run("UPDATE agent_files SET title = ?, updated_at = ? WHERE id = ?", [
          input.title,
          at,
          fileId,
        ]);
      });
      const made = versions(fileId).find((each) => each.id === id);
      if (!made) throw new NotFoundError({ key: "error.handedFile.notFound" });
      return made;
    },

    setDocument(fileId: string, documentId: string): void {
      db.run("UPDATE agent_files SET document_id = ?, updated_at = ? WHERE id = ?", [
        documentId,
        now(),
        fileId,
      ]);
    },

    /** The Note a version's check is in. */
    setMind(versionId: string, mindId: string): void {
      db.run("UPDATE agent_file_versions SET mind_id = ?, updated_at = ? WHERE id = ?", [
        mindId,
        now(),
        versionId,
      ]);
    },
  };
}

export type AgentFiles = ReturnType<typeof createAgentFiles>;
