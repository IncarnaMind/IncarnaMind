import { sameName } from "../../shared/names";
import type { AssignmentChange, MovedDocument, RestoreRef, TagLinkState } from "../api";
import type { LibraryGroup, LibraryGroupInput } from "../library/types";
import type { Database } from "../storage";
import { type TagsStore, tagsOfDocument } from "../tags";
import { tagKey } from "../tags/suggest";
import {
  createOrganizeReviewStore,
  type FolderRow,
  type ItemRow,
  type OrganizeReviewProposal,
  type OrganizeReviewRun,
  parseId,
  parseIds,
  type TagsProposal,
} from "./store";
import type {
  OrganizeReview,
  OrganizeReviewChange,
  OrganizeReviewConfirmation,
  OrganizeReviewFolder,
} from "./types";

export type { OrganizeReviewProposal, OrganizeReviewRun, TagsProposal } from "./store";

export { createOrganizeReviewStore, organizeReviewCount } from "./store";

/** What a Confirm or its Undo changed in the Library, for the events each change sends once saved. */
export interface OrganizeReviewSaved {
  /** Documents Confirm filed, for "library.assignments". */
  filed: string[];
  folderIds: string[];
  tagged: string[];
  /** Confirm made Tags or brought them back: the list of Tags is read again. */
  tagsMade: boolean;
}

/**
 * Suggestions (CONTEXT.md): runs propose, the User edits, and Confirm makes it the User's in
 * one step through the Library's own paths, with an Undo that reverts only what is still as it
 * left it (#1569, #2339). Nothing here sends anything anywhere.
 */
export function createOrganizeReview(options: {
  db: Database;
  now(): string;
  library: {
    folders(): LibraryGroup[];
    create(input: LibraryGroupInput): LibraryGroup;
    move(ids: readonly string[], groupId: string | null): MovedDocument[];
    restoreAssignment(id: unknown, before: unknown, after: unknown): AssignmentChange | null;
  };
  tags: Pick<TagsStore, "create" | "addToDocument" | "revert" | "owned">;
  /** Sends a Folder to Recently deleted, as deleting it does. */
  removeFolder(id: string, at: string): void;
  /** Sends a Tag to Recently deleted, as deleting it does. */
  removeTag(id: string, at: string): void;
  /** Brings these back from Recently deleted, as Restore does. */
  restoreDeleted(refs: RestoreRef[]): void;
  /** Whether a Folder holds nothing: no Document, Note, conversation or Folder. */
  folderIsEmpty(id: string): boolean;
  saved(change: OrganizeReviewSaved): void;
  /** The Suggestions changed: how many Documents wait now. */
  changed(count: number): void;
}) {
  const { db, now, library, tags } = options;
  const store = createOrganizeReviewStore(db, now);
  const changed = () => options.changed(store.count());

  const liveFolder = (id: string | null) =>
    id !== null && library.folders().some((folder) => folder.id === id);
  const deletedFolder = (id: string) =>
    !!db.get("SELECT 1 FROM library_groups WHERE id = ? AND deleted_at IS NOT NULL", [id]);
  const deletedTag = (id: string) =>
    !!db.get("SELECT 1 FROM tags WHERE id = ? AND deleted_at IS NOT NULL", [id]);
  type Link = TagLinkState["link"];
  const linkOf = (documentId: string, tagId: string): Link => {
    const link = tagsOfDocument(db, documentId).find((each) => each.tagId === tagId);
    return link
      ? { source: link.source, confidence: link.confidence, needsReview: link.needsReview }
      : null;
  };

  /** Files, makes and tags what these rows say, and closes them under `id`. Run in a transaction. */
  const apply = (id: string, items: readonly ItemRow[], redo = false) => {
    const folders = new Map<string, string>();
    const madeFolders: string[] = [];
    const madeTags = new Map<string, string>();
    const madeTagIds: string[] = [];
    const filed: string[] = [];
    const into = new Set<string>();
    const tagged = new Set<string>();
    let tagsMade = false;

    /** The Folder a proposed one is made in: the Library's, or its proposed parent, made first. */
    const parentFor = (row: FolderRow): string | null => {
      if (row.parent_id === null) return null;
      if (liveFolder(row.parent_id)) return row.parent_id;
      return store.folderRow(row.parent_id) ? folderFor(row.parent_id) : null;
    };

    const folderFor = (folderId: string): string | null => {
      const known = folders.get(folderId);
      if (known) return known;
      const row = store.folderRow(folderId);
      if (!row) return null;
      let groupId: string;
      let made = row.made;
      const named = library.folders().find((folder) => sameName(folder.name, row.name));
      if (row.group_id !== null && liveFolder(row.group_id)) {
        groupId = row.group_id;
      } else if (named) {
        groupId = named.id;
        made = 0;
      } else if (row.group_id !== null && row.made === 1 && deletedFolder(row.group_id)) {
        parentFor(row);
        // Confirm made it and its Undo sent it to Recently deleted: it comes back, not a copy.
        options.restoreDeleted([{ kind: "folder", id: row.group_id }]);
        groupId = row.group_id;
      } else {
        groupId = library.create({
          name: row.name,
          description: row.description,
          parentId: parentFor(row),
        }).id;
        made = 1;
      }
      store.update("folders", row.id, { group_id: groupId, made });
      if (made === 1) madeFolders.push(groupId);
      folders.set(folderId, groupId);
      return groupId;
    };

    const tagFor = (row: {
      tag_id: string | null;
      name: string;
      description: string;
      made: number;
    }) => {
      if (row.tag_id !== null && !deletedTag(row.tag_id))
        return { tagId: row.tag_id, made: row.made };
      if (row.tag_id !== null && row.made === 0) return null;
      const key = tagKey(row.name);
      const named = store.liveTags().find((tag) => tagKey(tag.name) === key);
      if (named) return { tagId: named.id, made: 0 };
      const earlier = madeTags.get(key);
      if (earlier) return { tagId: earlier, made: 1 };
      let tagId: string;
      if (row.tag_id !== null) {
        options.restoreDeleted([{ kind: "tag", id: row.tag_id }]);
        tagId = row.tag_id;
      } else {
        tagId = tags.create({ name: row.name, description: row.description }).id;
      }
      madeTags.set(key, tagId);
      madeTagIds.push(tagId);
      tagsMade = true;
      return { tagId, made: 1 };
    };

    for (const item of items) {
      let change: string | null = null;
      if (item.ticked !== 0) {
        const groupId =
          item.placement === "folder"
            ? item.group_id
            : item.placement === "newFolder" && item.folder_id
              ? folderFor(item.folder_id)
              : null;
        const now = db.get<{ group_id: string | null; source: string }>(
          "SELECT group_id, source FROM document_groups WHERE document_id = ? AND deleted_at IS NULL",
          [item.document_id],
        );
        // Done again, a Document the User has put somewhere else since its Undo stays there.
        const movedSince =
          redo &&
          item.filed !== null &&
          (now?.group_id ?? null) !==
            ((JSON.parse(item.filed) as AssignmentChange).before.assignment?.groupId ?? null);
        if (
          groupId !== null &&
          !movedSince &&
          (now?.group_id !== groupId || now.source !== "user")
        ) {
          const [moved] = library.move([item.document_id], groupId);
          if (moved) change = JSON.stringify(moved.change);
          filed.push(item.document_id);
          into.add(groupId);
        }
        const decided = new Set(tags.owned(item.document_id));
        // Left out has no tick to say no with: its Tags wait until the User files it (#1569).
        const tagRows = item.placement === "leftOut" ? [] : store.tagRowsOf(item.id);
        for (const row of tagRows) {
          const tag = tagFor(row);
          if (!tag) continue;
          if (row.added_by_user === 0 && decided.has(tag.tagId)) continue;
          const link = linkOf(item.document_id, tag.tagId);
          const adds = link?.source !== "user";
          if (adds) {
            tags.addToDocument(item.document_id, tag.tagId);
            tagged.add(item.document_id);
          }
          store.update("tags", row.id, {
            tag_id: tag.tagId,
            made: tag.made,
            link_before: adds ? JSON.stringify(link) : null,
          });
        }
      }
      store.update("items", item.id, { state: "confirmed", confirmation_id: id, filed: change });
    }
    return {
      confirmation: {
        id,
        documentIds: [...new Set([...filed, ...tagged])],
        folderIds: madeFolders,
        tagIds: madeTagIds,
      } satisfies OrganizeReviewConfirmation,
      saved: { filed, folderIds: [...into], tagged: [...tagged], tagsMade },
    };
  };

  const confirmationItems = (id: string, state: "open" | "confirmed") =>
    db.all<ItemRow>(
      `SELECT * FROM organize_review_items WHERE confirmation_id = ? AND state = ? AND deleted_at IS NULL
       ORDER BY created_at, rowid`,
      [id, state],
    );

  const finish = (result: ReturnType<typeof apply> | null) => {
    if (!result) return null;
    options.saved(result.saved);
    changed();
    return result.confirmation;
  };

  return {
    store,

    /** Internal: a run's proposals (see `OrganizeReviewStore.propose`). */
    propose(run: OrganizeReviewRun, proposals: readonly OrganizeReviewProposal[]): number {
      const written = store.propose(run, proposals);
      if (written > 0) changed();
      return written;
    },

    /** Internal: a tagging run's proposals (see `OrganizeReviewStore.proposeTags`). */
    proposeTags(run: OrganizeReviewRun, proposals: readonly TagsProposal[]): number {
      const written = store.proposeTags(run, proposals);
      if (written > 0) changed();
      return written;
    },

    count: () => store.count(),

    /** Internal: the proposed Folders a run may choose (see `OrganizeReviewStore.offeredFolders`). */
    offeredFolders: (): OrganizeReviewFolder[] => store.offeredFolders(),

    /** Internal: Folders proposed by name, none made (see `OrganizeReviewStore.proposeFolders`). */
    proposeFolders(
      folders: readonly { name: string; description: string; parentId?: string | null }[],
    ): OrganizeReviewFolder[] {
      const proposed = store.proposeFolders(folders);
      changed();
      return proposed;
    },

    /** Internal: the assistant's Undo of its run (see `OrganizeReviewStore.withdraw`). */
    withdraw(runId: string | null, folderIds: readonly string[]): OrganizeReviewChange {
      const change = store.withdraw(runId, folderIds);
      if (change.after.length > 0) changed();
      return change;
    },

    get(): OrganizeReview {
      return store.view();
    },

    edit(input: unknown): OrganizeReviewChange {
      const change = store.edit(input);
      if (change.after.length > 0) changed();
      return change;
    },

    restore(before: unknown, after: unknown): OrganizeReviewChange | null {
      const change = store.restore(before, after);
      if (change) changed();
      return change;
    },

    /**
     * Confirms the rows the User saw, in one transaction: a row added since waits. Returns null
     * when none of them waits any more.
     */
    confirm(itemIdsInput: unknown): OrganizeReviewConfirmation | null {
      const ids = parseIds(itemIdsInput);
      return finish(
        db.transaction(() => {
          const items = store.visibleOpen(ids);
          if (items.length === 0) return null;
          const id = crypto.randomUUID();
          const at = now();
          db.run(
            `INSERT INTO organize_review_confirmations (id, confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            [id, at, at, at],
          );
          return apply(id, items);
        }),
      );
    },

    /**
     * Takes a Confirm back: each filing and Tag still as it left them goes back, the Folders and
     * Tags it made that hold nothing else go to Recently deleted, and its rows wait again.
     */
    undoConfirmation(idInput: unknown): void {
      const id = parseId(idInput);
      const saved: OrganizeReviewSaved = { filed: [], folderIds: [], tagged: [], tagsMade: false };
      const undone = db.transaction(() => {
        const at = now();
        const open = db.get(
          "SELECT 1 FROM organize_review_confirmations WHERE id = ? AND undone_at IS NULL AND deleted_at IS NULL",
          [id],
        );
        if (!open) return false;
        const items = confirmationItems(id, "confirmed");
        for (const item of items) {
          if (item.filed === null) continue;
          const change = JSON.parse(item.filed) as AssignmentChange;
          const back = change.before.assignment?.groupId ?? null;
          if (back !== null && !liveFolder(back)) continue;
          library.restoreAssignment(item.document_id, change.before, change.after);
        }
        const madeTags = new Set<string>();
        for (const item of items) {
          for (const row of store.tagRowsOf(item.id)) {
            if (row.tag_id === null) continue;
            if (row.made === 1) madeTags.add(row.tag_id);
            if (row.link_before === null) continue;
            const link = linkOf(item.document_id, row.tag_id);
            const asLeft = link?.source === "user" && link.confidence === null && !link.needsReview;
            if (!asLeft) continue;
            const before = JSON.parse(row.link_before) as Link;
            tags.revert([{ documentId: item.document_id, tagId: row.tag_id, link: before }]);
            saved.tagged.push(item.document_id);
          }
        }
        for (const item of items) {
          if (store.openItem(item.document_id)) continue;
          store.update("items", item.id, { state: "open" });
        }
        // Subfolders first, so a proposed parent they emptied goes too.
        const proposedParent = (id: string) => {
          const parent = store.folderRow(id)?.parent_id;
          return parent && store.folderRow(parent) ? parent : null;
        };
        const depth = (id: string) => {
          let levels = 0;
          for (let at = proposedParent(id); at; at = proposedParent(at)) levels++;
          return levels;
        };
        const folderIds = new Set<string>();
        for (const item of items)
          for (let at = item.folder_id; at && !folderIds.has(at); at = proposedParent(at))
            folderIds.add(at);
        for (const folderId of [...folderIds].sort((a, b) => depth(b) - depth(a))) {
          const row = store.folderRow(folderId);
          if (!row?.group_id || !liveFolder(row.group_id)) continue;
          if (row.made === 1 && options.folderIsEmpty(row.group_id)) {
            options.removeFolder(row.group_id, at);
            continue;
          }
          // Kept, so it is one of the User's Folders now: its rows wait to go into it.
          for (const item of confirmationItems(id, "open")) {
            if (item.placement === "newFolder" && item.folder_id === folderId)
              store.update("items", item.id, {
                placement: "folder",
                group_id: row.group_id,
                folder_id: null,
              });
          }
        }
        for (const tagId of madeTags) {
          if (deletedTag(tagId)) continue;
          const holds = db.get(
            "SELECT 1 FROM document_tags WHERE tag_id = ? AND deleted_at IS NULL LIMIT 1",
            [tagId],
          );
          if (!holds) options.removeTag(tagId, at);
        }
        db.run(
          "UPDATE organize_review_confirmations SET undone_at = ?, updated_at = ? WHERE id = ?",
          [at, at, id],
        );
        return true;
      });
      if (!undone) return;
      options.saved(saved);
      changed();
    },

    /** Confirms again what an Undo of `id` put back, bringing back the Folders and Tags it took away. */
    redoConfirmation(idInput: unknown): OrganizeReviewConfirmation | null {
      const id = parseId(idInput);
      return finish(
        db.transaction(() => {
          const undone = db.get(
            "SELECT 1 FROM organize_review_confirmations WHERE id = ? AND undone_at IS NOT NULL AND deleted_at IS NULL",
            [id],
          );
          if (!undone) return null;
          const items = store.visibleOpen(confirmationItems(id, "open").map((item) => item.id));
          if (items.length === 0) return null;
          db.run(
            "UPDATE organize_review_confirmations SET undone_at = NULL, updated_at = ? WHERE id = ?",
            [now(), id],
          );
          return apply(id, items, true);
        }),
      );
    },

    discard(itemIds: unknown): string | null {
      const id = store.discard(itemIds);
      if (id) changed();
      return id;
    },

    restoreDiscarded(id: unknown): void {
      store.restoreDiscarded(id);
      changed();
    },
  };
}

export type OrganizeReviewModule = ReturnType<typeof createOrganizeReview>;
