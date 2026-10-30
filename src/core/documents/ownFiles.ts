/**
 * The files IncarnaMind writes (#80): exports and source packs. Each one's
 * content fingerprint is recorded before it is written (migration 50), so
 * when the file, or a copy of it, becomes a Document (saved into a Linked
 * folder, or added by the User), that Document is known as one IncarnaMind
 * wrote (`Document.ownFile`) and checks leave it out of their evidence
 * (./evidence). The schema marks the Document, whichever comes first.
 *
 * Only the fingerprint is kept: no name or path, which belong to one
 * computer. A file the User edits keeps its mark once it has one, since its
 * text still came from a Mind; one that was never seen unedited isn't marked.
 */
import { randomUUID } from "node:crypto";
import type { OwnFileKind } from "../api";
import type { Database } from "../storage";
import { hashBytes } from "./files";

export interface OwnFiles {
  /**
   * Records that IncarnaMind is writing a file with these bytes, and returns
   * the live Documents that this marks: those already indexed with them,
   * whose change the caller announces. Nothing is recorded for an empty
   * file: every empty file has its fingerprint.
   */
  record(data: Uint8Array, kind: OwnFileKind, folderId: string | null): string[];
  /**
   * The live Documents IncarnaMind wrote from a Note in one of these Folders: what a Folder
   * wall keeps behind it wherever the file was indexed (#1934).
   */
  writtenFrom(folderIds: readonly string[]): string[];
}

export function createOwnFiles(db: Database, now: () => string): OwnFiles {
  return {
    record(data, kind, folderId) {
      if (data.byteLength === 0) return [];
      const contentHash = hashBytes(data);
      return db.transaction(() => {
        // The same bytes written again are the same file: one row is enough, from its latest Note.
        const known = db.get<{ id: string; folder_id: string | null }>(
          "SELECT id, folder_id FROM own_files WHERE content_hash = ? AND kind = ? AND deleted_at IS NULL",
          [contentHash, kind],
        );
        if (known) {
          if (folderId !== null && known.folder_id !== folderId) {
            db.run("UPDATE own_files SET folder_id = ?, updated_at = ? WHERE id = ?", [
              folderId,
              now(),
              known.id,
            ]);
          }
          return [];
        }
        const marked = db
          .all<{ id: string }>(
            `SELECT id FROM documents
             WHERE content_hash = ? AND own_file IS NULL AND deleted_at IS NULL`,
            [contentHash],
          )
          .map((row) => row.id);
        const at = now();
        db.run(
          `INSERT INTO own_files (id, content_hash, kind, folder_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [randomUUID(), contentHash, kind, folderId, at, at],
        );
        return marked;
      });
    },
    writtenFrom(folderIds) {
      if (folderIds.length === 0) return [];
      return db
        .all<{ id: string }>(
          `SELECT id FROM documents WHERE deleted_at IS NULL
           AND own_file_folder_id IN (${folderIds.map(() => "?").join(",")})`,
          [...folderIds],
        )
        .map((row) => row.id);
    },
  };
}
