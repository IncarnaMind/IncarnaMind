/**
 * Recently deleted (CONTEXT.md), and putting back what was deleted, merged or untagged.
 *
 * Deleting marks rows deleted (ADR-0003), a Mind, conversation, Document, Folder or Tag together
 * with the rows that go with it, all at the same moment: restoring one brings back the rows whose
 * `deleted_at` is its own. A Mind's Meeting goes with it, and its Transcript Document, which isn't
 * listed apart from the Mind and is deleted permanently with it (#1253). Deleting permanently, by
 * the User or `RECENTLY_DELETED_DAYS` after at start-up, drops that content and keeps the row as a
 * tombstone (`purged_at`), which can't be restored. Nothing here reads or writes the User's files. A Document's text that a Citation
 * still quotes stays (ADR-0010), as the text kept of an unlinked Document does.
 */
import type { MessageKey, MessageParams } from "../shared/i18n";
import {
  DELETED_KINDS,
  type DeletedItem,
  type DeletedKind,
  type DeletedRef,
  type DocumentKind,
  RECENTLY_DELETED_DAYS,
  type RestoreRef,
  type RestoreResult,
  type TagLinkState,
} from "./api";
import type { Conversations } from "./conversations";
import type { createDocuments } from "./documents";
import { NOTE_FIGURE_CHECKPOINT_PREFIX } from "./documents/retention";
import { InvalidInputError, isRecord, NotFoundError } from "./errors";
import type { createLibrary } from "./library";
import type { createMindContent } from "./mindContent";
import { forgetMindBlocks } from "./mindIndex";
import type { createMinds } from "./minds";
import type { Database } from "./storage";
import { parseTagLinkStates, sameName, type TagsStore } from "./tags";

const TABLES: Readonly<Record<DeletedKind, string>> = {
  mind: "minds",
  conversation: "conversations",
  document: "documents",
  folder: "library_groups",
  tag: "tags",
};

const KINDS: readonly DeletedKind[] = DELETED_KINDS;

/** A name as `mindName` and `conversationName` give it: the title typed, else the one it gave itself. */
const OWN_NAME = "CASE WHEN title <> '' THEN title ELSE auto_title END";

const earliestRestorable = (now: string) =>
  new Date(Date.parse(now) - RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000).toISOString();

/**
 * The Folder a deleted item was in, from the latest live record of a Folder's deletion that took
 * it out: the item's own row lost that Folder then. The record must not be older than the item's
 * own deletion; the same moment counts, since deleting several things takes the Documents before
 * their Folder (#2238).
 */
function wasIn(kind: DeletedKind, table: string): string {
  return `(SELECT f.folder_id FROM deleted_folder_items f
    WHERE f.item_kind = '${kind}' AND f.item_id = ${table}.id AND f.deleted_at IS NULL
      AND f.created_at >= ${table}.deleted_at
    ORDER BY f.rowid DESC LIMIT 1)`;
}

function parseRefs(input: unknown, what: string): RestoreRef[] {
  if (!Array.isArray(input)) throw new InvalidInputError(`${what} expects a list of { kind, id }.`);
  return input.map((each): RestoreRef => {
    if (!isRecord(each) || typeof each.id !== "string" || each.id === "")
      throw new InvalidInputError(`${what} expects a list of { kind, id }.`);
    const kind = KINDS.find((known) => known === each.kind);
    if (!kind) throw new InvalidInputError(`${what} can't take a ${String(each.kind)}.`);
    if (each.links === undefined) return { kind, id: each.id };
    return { kind, id: each.id, links: parseTagLinkStates(each.links) };
  });
}

/** Drops the text of Documents deleted permanently, keeping the Units Citations point to (ADR-0010). */
export type DocumentText = (documentIds: readonly string[]) => void;

/** Drops deleted rows' content and marks them deleted permanently. Run in a transaction. */
function purge(
  db: Database,
  kind: DeletedKind,
  ids: readonly string[],
  at: string,
  documentText: DocumentText,
): void {
  if (ids.length === 0) return;
  const list = JSON.stringify(ids);
  const IN = "IN (SELECT value FROM json_each(?))";
  if (kind === "mind") {
    db.run(`DELETE FROM mind_updates WHERE mind_id ${IN}`, [list]);
    // Its Checkpoints hold its content too, and no longer keep the Document versions they quote.
    db.run(
      `UPDATE retained_versions SET deleted_at = ?, updated_at = ?
       WHERE kind = 'checkpoint' AND deleted_at IS NULL
         AND owner_id IN (SELECT id FROM mind_checkpoints WHERE mind_id ${IN})`,
      [at, at, list],
    );
    db.run(`DELETE FROM mind_checkpoints WHERE mind_id ${IN}`, [list]);
    // The Word package it was imported from goes once no other Mind keeps it (`sweepWordPackages`).
    db.run(
      `UPDATE word_packages SET deleted_at = ?, updated_at = ? WHERE mind_id ${IN} AND deleted_at IS NULL`,
      [at, at, list],
    );
    forgetMindBlocks(db, ids, at);
    // Its checks' evidence and figure inputs are retained under the Mind (ADR-0021).
    db.run(
      `UPDATE retained_versions SET deleted_at = ?, updated_at = ?
       WHERE deleted_at IS NULL AND
         ((kind IN ('check-result', 'note-figure') AND owner_id ${IN})
          OR (kind = 'checkpoint' AND owner_id IN
            (SELECT ? || value FROM json_each(?))))`,
      [at, at, list, NOTE_FIGURE_CHECKPOINT_PREFIX, list],
    );
  }
  if (kind === "conversation") {
    // Its messages, their index and its titles: everything the User asked or was answered.
    const purged = `(SELECT id FROM conversations WHERE id ${IN} AND deleted_at IS NOT NULL)`;
    db.run(
      `DELETE FROM conversation_messages_fts WHERE rowid IN (
         SELECT seq FROM conversation_messages WHERE conversation_id IN ${purged})`,
      [list],
    );
    db.run(`DELETE FROM conversation_messages WHERE conversation_id IN ${purged}`, [list]);
    db.run(
      `DELETE FROM conversations_fts WHERE rowid IN (
         SELECT seq FROM conversations WHERE id ${IN} AND deleted_at IS NOT NULL)`,
      [list],
    );
    db.run(
      `UPDATE conversations SET title = '', auto_title = ''
       WHERE id ${IN} AND deleted_at IS NOT NULL AND purged_at IS NULL`,
      [list],
    );
  }
  if (kind === "document") {
    db.run(`DELETE FROM passages WHERE document_id ${IN} AND deleted_at IS NOT NULL`, [list]);
    documentText(ids);
    db.run(`DELETE FROM document_tags WHERE document_id ${IN}`, [list]);
    db.run(`DELETE FROM web_pages WHERE document_id ${IN} AND deleted_at IS NOT NULL`, [list]);
    db.run(`DELETE FROM web_page_pictures WHERE document_id ${IN} AND deleted_at IS NOT NULL`, [
      list,
    ]);
  }
  if (kind === "tag") db.run(`DELETE FROM document_tags WHERE tag_id ${IN}`, [list]);
  if (kind === "folder") db.run(`DELETE FROM deleted_folder_items WHERE folder_id ${IN}`, [list]);
  db.run(
    `UPDATE ${TABLES[kind]} SET purged_at = ?, updated_at = ?
     WHERE id ${IN} AND deleted_at IS NOT NULL AND purged_at IS NULL`,
    [at, at, list],
  );
}

export function purgeExpired(db: Database, now: string, documentText: DocumentText): void {
  const before = earliestRestorable(now);
  db.transaction(() => {
    for (const kind of KINDS) {
      const ids = db.all<{ id: string }>(
        `SELECT id FROM ${TABLES[kind]} WHERE deleted_at < ? AND purged_at IS NULL`,
        [before],
      );
      purge(
        db,
        kind,
        ids.map((row) => row.id),
        now,
        documentText,
      );
    }
  });
}

interface DeletedRow {
  name: string;
  deleted_at: string | null;
  purged_at: string | null;
}

export function createRecentlyDeleted(options: {
  db: Database;
  now(): string;
  documentText: DocumentText;
  /** A message in the interface language. */
  say(key: MessageKey, params?: MessageParams): string;
  minds: ReturnType<typeof createMinds>;
  content: ReturnType<typeof createMindContent>;
  conversations: Conversations;
  documents: ReturnType<typeof createDocuments>;
  tags: TagsStore;
  library: ReturnType<typeof createLibrary>;
  mindsChanged(): void;
  /** A Mind's Meetings, deleted and restored with it (#1253): see `Meetings`. */
  meetings: {
    transcriptsDeletedWith(mindId: string, deletedAt: string): string[];
    recordingDeletedWith(mindId: string, deletedAt: string): boolean;
    restoreWith(mindId: string, deletedAt: string): string[];
    /** After the restore and its events: returns the Minds whose Meeting came back without its audio. */
    restored(meetingIds: readonly string[]): string[];
  };
  /** The Minds a restore brought back, and whether their tabs come back with them (Undo). */
  mindsRestored(mindIds: readonly string[], reopen: boolean): void;
  /** Minds gone for good: what the layout kept for their tabs goes. */
  mindsForgotten(mindIds: readonly string[]): void;
  conversationsChanged(): void;
  tagsChanged(): void;
  tagged(documentIds: string[]): void;
}) {
  const { db, now, say, minds, content, conversations, documents, tags, library, documentText } =
    options;

  const rowOf = (kind: DeletedKind, id: string) =>
    db.get<DeletedRow>(
      `SELECT ${kind === "mind" || kind === "conversation" ? OWN_NAME : "name"} AS name,
         deleted_at, purged_at
       FROM ${TABLES[kind]} WHERE id = ?`,
      [id],
    );

  const nameOf = (kind: DeletedKind, row: DeletedRow) =>
    row.name !== ""
      ? row.name
      : kind === "mind"
        ? say("mind.untitled")
        : kind === "conversation"
          ? say("conversation.untitled")
          : "";

  /** The Transcript Documents deleted with a Mind, at its time. */
  function documentsWith(mindId: string, deletedAt: string): string[] {
    const ids = options.meetings.transcriptsDeletedWith(mindId, deletedAt);
    if (ids.length === 0) return [];
    return db
      .all<{ id: string }>(
        `SELECT id FROM documents
         WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at = ? AND purged_at IS NULL`,
        [JSON.stringify(ids), deletedAt],
      )
      .map((row) => row.id);
  }

  function checkDocument(id: string, name: string, coming: Set<string>): void {
    const row = db.get<{ path: string; linked_folder_id: string | null }>(
      "SELECT path, linked_folder_id FROM documents WHERE id = ?",
      [id],
    );
    if (!row) return;
    if (
      row.linked_folder_id !== null &&
      !db.get("SELECT 1 FROM linked_folders WHERE id = ? AND deleted_at IS NULL", [
        row.linked_folder_id,
      ])
    )
      throw new NotFoundError({ key: "error.restore.unlinked", values: { name } });
    if (
      coming.has(row.path) ||
      db.get("SELECT 1 FROM documents WHERE path = ? AND deleted_at IS NULL", [row.path])
    )
      throw new InvalidInputError({ key: "error.restore.documentBack", values: { name } });
    coming.add(row.path);
  }

  function checkLinks(links: readonly TagLinkState[]): void {
    for (const { documentId, tagId } of links) {
      if (!db.get("SELECT 1 FROM documents WHERE id = ? AND deleted_at IS NULL", [documentId]))
        throw new NotFoundError({ key: "error.restore.documentGone" });
      const tag = rowOf("tag", tagId);
      if (!tag || tag.deleted_at !== null)
        throw new NotFoundError({
          key: "error.restore.tagGone",
          values: { name: tag?.name ?? "" },
        });
    }
  }

  return {
    list(): DeletedItem[] {
      const since = earliestRestorable(now());
      const item = (
        kind: DeletedKind,
        row: { id: string; name: string; deleted_at: string; group_id?: string | null },
        document?: { kind: DocumentKind; linkedFolderId: string | null },
      ): DeletedItem => ({
        kind,
        id: row.id,
        name: row.name,
        deletedAt: row.deleted_at,
        documentKind: document?.kind ?? null,
        groupId: row.group_id ?? null,
        linkedFolderId: document?.linkedFolderId ?? null,
      });
      const items = [
        ...(["mind", "conversation"] as const).flatMap((kind) =>
          db
            .all<{ id: string; name: string; deleted_at: string; group_id: string | null }>(
              `SELECT id, ${OWN_NAME} AS name, deleted_at,
                 COALESCE(folder_id, ${wasIn(kind, TABLES[kind])}) AS group_id
               FROM ${TABLES[kind]}
               WHERE deleted_at >= ? AND purged_at IS NULL`,
              [since],
            )
            .map((row) => item(kind, row)),
        ),
        ...db
          .all<{
            id: string;
            name: string;
            kind: DocumentKind;
            deleted_at: string;
            group_id: string | null;
            linked_folder_id: string | null;
          }>(
            // Not those unlinked with their Linked folder, nor those whose file is in the Library again.
            `SELECT d.id, d.name, d.kind, d.deleted_at,
               COALESCE(g.group_id, ${wasIn("document", "d")}) AS group_id, d.linked_folder_id
             FROM documents d
             LEFT JOIN document_groups g ON g.document_id = d.id AND g.deleted_at IS NULL
             WHERE d.deleted_at >= ? AND d.purged_at IS NULL
               AND (d.linked_folder_id IS NULL OR EXISTS (
                 SELECT 1 FROM linked_folders l WHERE l.id = d.linked_folder_id AND l.deleted_at IS NULL))
               AND NOT EXISTS (SELECT 1 FROM documents o WHERE o.path = d.path AND o.deleted_at IS NULL)`,
            [since],
          )
          .map((row) =>
            item("document", row, { kind: row.kind, linkedFolderId: row.linked_folder_id }),
          ),
        ...db
          .all<{ id: string; name: string; deleted_at: string }>(
            "SELECT id, name, deleted_at FROM library_groups WHERE deleted_at >= ? AND purged_at IS NULL",
            [since],
          )
          .map((row) => item("folder", row)),
        ...db
          .all<{ id: string; name: string; deleted_at: string }>(
            "SELECT id, name, deleted_at FROM tags WHERE deleted_at >= ? AND purged_at IS NULL",
            [since],
          )
          .map((row) => item("tag", row)),
      ];
      // A Transcript waits with its Meeting's Mind, not beside it.
      const withMinds = new Set<string>();
      for (const each of items) {
        if (each.kind !== "mind") continue;
        const transcripts = documentsWith(each.id, each.deletedAt);
        const recording = options.meetings.recordingDeletedWith(each.id, each.deletedAt);
        for (const id of transcripts) withMinds.add(id);
        if (recording || transcripts.length > 0) {
          each.meeting = { recording, transcript: transcripts.length > 0 };
        }
      }
      return items
        .filter((each) => !(each.kind === "document" && withMinds.has(each.id)))
        .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    },

    /** See `CoreApi.restore`. */
    restore(input: unknown, restoreOptions?: unknown): RestoreResult {
      // Over the bridge the call isn't type-checked: anything but a true `reopen` restores quietly.
      const reopen = isRecord(restoreOptions) && restoreOptions.reopen === true;
      const refs = parseRefs(input, "restore");
      const since = earliestRestorable(now());
      const done = db.transaction(() => {
        const restored = {
          minds: false,
          mindIds: [] as string[],
          mindsDeletedAt: [] as { id: string; deletedAt: string }[],
          meetings: [] as string[],
          conversations: false,
          documents: [] as string[],
          folders: false,
          tags: false,
          tagged: new Set<string>(),
        };
        const coming = new Set<string>();
        // Documents go back together, in one statement a table (#1349), before whatever comes
        // after them in `refs`, so the order stays the order asked.
        let waiting: string[] = [];
        const bringBack = () => {
          documents.restore(waiting);
          waiting = [];
        };
        for (const ref of refs) {
          const { kind } = ref;
          if (kind !== "document") bringBack();
          const row = rowOf(kind, ref.id);
          if (!row) throw new NotFoundError({ key: "error.restore.unknown" });
          const name = nameOf(kind, row);
          if (row.deleted_at !== null) {
            if (row.purged_at !== null)
              throw new NotFoundError({
                key: "error.restore.deletedPermanently",
                values: { name },
              });
            if (row.deleted_at < since)
              throw new NotFoundError({
                key: "error.restore.expired",
                values: { name, days: RECENTLY_DELETED_DAYS },
              });
            if (kind === "mind") {
              minds.restore(ref.id);
              content.restore(ref.id, row.deleted_at);
              restored.minds = true;
              restored.mindIds.push(ref.id);
              restored.mindsDeletedAt.push({ id: ref.id, deletedAt: row.deleted_at });
              // Its Transcripts are found from its Meetings while those are still deleted with it.
              for (const documentId of documentsWith(ref.id, row.deleted_at)) {
                checkDocument(documentId, rowOf("document", documentId)?.name ?? name, coming);
                waiting.push(documentId);
                restored.documents.push(documentId);
              }
              restored.meetings.push(...options.meetings.restoreWith(ref.id, row.deleted_at));
            } else if (kind === "conversation") {
              conversations.restore(ref.id);
              restored.conversations = true;
            } else if (kind === "document") {
              // Asked for with its Mind, which brings it back already.
              if (restored.documents.includes(ref.id)) continue;
              checkDocument(ref.id, name, coming);
              waiting.push(ref.id);
              restored.documents.push(ref.id);
            } else if (kind === "folder") {
              const taken = library.restore(ref.id);
              if (minds.returnToFolder(taken.minds, ref.id)) restored.minds = true;
              if (conversations.returnToFolder(taken.conversations, ref.id)) {
                restored.conversations = true;
              }
              restored.folders = true;
            } else {
              if (tags.list().some((tag) => sameName(tag.name, row.name)))
                throw new InvalidInputError({
                  key: "error.restore.tagNameTaken",
                  values: { name },
                });
              for (const id of tags.restore(ref.id, row.deleted_at)) restored.tagged.add(id);
              restored.tags = true;
            }
          }
        }
        bringBack();
        // Once every ref is back, so a Document restored in the same call counts.
        const links = refs.flatMap((ref) => ref.links ?? []);
        checkLinks(links);
        for (const id of tags.revert(links)) restored.tagged.add(id);
        return restored;
      });
      for (const { id, deletedAt } of done.mindsDeletedAt) content.restored(id, deletedAt);
      if (done.minds) options.mindsChanged();
      if (done.mindIds.length > 0) options.mindsRestored(done.mindIds, reopen);
      if (done.conversations) options.conversationsChanged();
      if (done.documents.length > 0) {
        documents.restored(done.documents);
        // Their assignments are as they were: said again for a client that read the Library while
        // they waited, and Organize goes on with one it was already working on. Never claimed anew (#1433).
        library.announce(done.documents);
        library.resume();
      }
      if (done.folders) library.restored();
      if (done.tags) options.tagsChanged();
      if (done.tagged.size > 0) options.tagged([...done.tagged]);
      return { audioLost: options.meetings.restored(done.meetings) };
    },

    /**
     * Deletes permanently what has waited `RECENTLY_DELETED_DAYS`; run once at start-up. What the
     * layout kept for their tabs needs no dropping: it is this session's, and none is kept yet.
     */
    expire(): void {
      purgeExpired(db, now(), documentText);
    },

    /** See `CoreApi.revertDocumentTags`. Returns the Documents whose Tags changed. */
    revertTags(input: unknown): string[] {
      const links = parseTagLinkStates(input);
      return db.transaction(() => {
        checkLinks(links);
        return tags.revert(links);
      });
    },

    /** See `CoreApi.deletePermanently`. */
    deletePermanently(input: unknown): void {
      const refs: DeletedRef[] = parseRefs(input, "deletePermanently");
      const at = now();
      db.transaction(() => {
        for (const { kind, id } of refs) {
          const row = rowOf(kind, id);
          if (!row) throw new NotFoundError({ key: "error.restore.unknown" });
          if (row.deleted_at === null)
            throw new InvalidInputError({
              key: "error.restore.notDeleted",
              values: { name: nameOf(kind, row) },
            });
          purge(db, kind, [id], at, documentText);
          // After the Mind, so its Citations no longer keep its Transcript's text.
          if (kind === "mind" && row.deleted_at !== null) {
            purge(db, "document", documentsWith(id, row.deleted_at), at, documentText);
          }
        }
      });
      // Only once purged for good: a rollback keeps the Minds, and what still waits in them.
      const minds = refs.flatMap(({ kind, id }) => (kind === "mind" ? [id] : []));
      for (const mindId of minds) content.forget(mindId);
      if (minds.length > 0) options.mindsForgotten(minds);
    },
  };
}
