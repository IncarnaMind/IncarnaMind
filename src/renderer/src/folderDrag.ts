import type { Document, LibrarySnapshot, Mind } from "../../core/api";
import { type Dropped, type DropTarget, type ObjectDrag, runDrop, useDragState } from "./dragDrop";
import { isInsideFolder } from "./folders";
import { translateNow } from "./i18n";
import { type MoveItems, moveLabel } from "./moves";
import type { ObjectRef } from "./objects";
import { type SelectSurface, selectedOn, useSelection } from "./selection";
import { useAppStore } from "./store";
import { linksIn, useWebPages } from "./webPages";

/**
 * The drop targets that file Minds and Documents: a Folder, Not in a Folder
 * (null) and a Tag, in the sidebar and on the Library page. A Folder lights
 * only while the drop would move something there, as Move to… does; a Tag
 * only while every Document dragged is one and one of them would get it. A
 * link dragged from a browser onto a Folder is saved there as a web page
 * (#261).
 *
 * A Folder dragged onto another nests it, or places it beside it (#246): over
 * the middle of a row it goes inside ("Put inside", a box), near its top or
 * bottom edge it becomes a sibling ("Move here", a line). A Folder can't go
 * inside itself or one of its own sub-Folders, and such a target says why.
 */

export const itemsOfRefs = (refs: readonly ObjectRef[]): MoveItems => ({
  mindIds: refs.flatMap((ref) => (ref.kind === "mind" ? [ref.id] : [])),
  documentIds: refs.flatMap((ref) => (ref.kind === "document" ? [ref.id] : [])),
});

/** Where a Document waiting in a Suggested Folder is: in none yet, so a move into that Folder accepts it. */
const WAITING = Symbol("waiting");

interface Index {
  minds: readonly Mind[];
  library: LibrarySnapshot | null;
  documents: readonly Document[];
  refs: readonly ObjectRef[];
  folderOfMind: Map<string, string | null>;
  folderOfDocument: Map<string, string | null | typeof WAITING>;
  documentById: Map<string, Document>;
  moves: Map<string | null, boolean>;
  tagged: Map<string, string[]>;
}

let index: Index | null = null;

// Asked on every move of a drag, over a selection that can be the whole Library: worked out once
// per drag and per state of the Library, then looked up.
function indexFor(refs: readonly ObjectRef[]): Index {
  const { minds, library, documents } = useAppStore.getState();
  if (index?.minds !== minds || index.library !== library || index.documents !== documents) {
    index = {
      minds,
      library,
      documents,
      refs,
      folderOfMind: new Map(minds.map((mind) => [mind.id, mind.folderId])),
      folderOfDocument: new Map(
        library?.assignments.map((each) => [
          each.documentId,
          each.suggested ? WAITING : each.groupId,
        ]),
      ),
      documentById: new Map(documents.map((document) => [document.id, document])),
      moves: new Map(),
      tagged: new Map(),
    };
  } else if (index.refs !== refs) {
    index = { ...index, refs, moves: new Map(), tagged: new Map() };
  }
  return index;
}

function wouldMove(refs: readonly ObjectRef[], folderId: string | null): boolean {
  const known = indexFor(refs);
  const answer = known.moves.get(folderId);
  if (answer !== undefined) return answer;
  const moves = refs.some((ref) =>
    ref.kind === "mind"
      ? (known.folderOfMind.get(ref.id) ?? null) !== folderId
      : ref.kind === "document" && (known.folderOfDocument.get(ref.id) ?? null) !== folderId,
  );
  known.moves.set(folderId, moves);
  return moves;
}

function doneWithSelection(dropped: Dropped): void {
  // A selection of one is the row shown, and stays; several chosen to drag together are done with.
  if (dropped.kind !== "objects" || !dropped.from) return;
  if (useSelection.getState().items.length > 1) useSelection.getState().clear(dropped.from);
}

/** Where a Folder dropped on a row goes: inside it, or beside it. */
export type FolderPlace = "into" | "before" | "after";

const groupsNow = () => useAppStore.getState().library?.groups ?? [];

/** The Folders a drag carries: one, or the several selected together; empty for anything else. */
function foldersDragged(refs: readonly ObjectRef[]): string[] {
  return refs.flatMap((ref) => (ref.kind === "folder" ? [ref.id] : []));
}

/** Whether a drag carries Folders alone: a selection with Documents or Notes in it is no Folder move. */
const onlyFolders = (refs: readonly ObjectRef[], folders: readonly string[]): boolean =>
  folders.length > 0 && folders.length === refs.length;

/** The zone of a row's box the pointer is in: its middle nests, its top and bottom edges place beside. */
export function folderZoneOf(rect: DOMRect | null, at: { y: number }): FolderPlace {
  if (!rect) return "into";
  if (at.y < rect.top + rect.height * 0.28) return "before";
  if (at.y > rect.bottom - rect.height * 0.28) return "after";
  return "into";
}

function folderInsideItself(folderId: string, targetId: string): boolean {
  return targetId === folderId || isInsideFolder(groupsNow(), targetId, folderId);
}

/** Whether a Folder dropped beside `referenceId` would change where it is. */
function besideChanges(folderId: string, referenceId: string): boolean {
  const groups = groupsNow();
  const folder = groups.find((each) => each.id === folderId);
  const reference = groups.find((each) => each.id === referenceId);
  if (!folder || !reference) return false;
  const parent = reference.parentId;
  if (parent === null) return folder.parentId !== null;
  return folder.parentId !== parent && !isInsideFolder(groups, parent, folderId);
}

/** Whether placing `folderId` beside `referenceId` would put it inside itself. */
function besideInsideItself(folderId: string, referenceId: string): boolean {
  const groups = groupsNow();
  const parent = groups.find((each) => each.id === referenceId)?.parentId ?? null;
  return parent !== null && isInsideFolder(groups, parent, folderId);
}

/**
 * The drop target of a Folder's row (or head), which also nests Folders.
 * `rect` is the row's box, so a Folder dropped near its top or bottom edge
 * goes beside it and one dropped on its middle goes inside.
 */
export function folderTarget(
  folderId: string | null,
  rect?: () => DOMRect | null,
): DropTarget<FolderPlace> {
  const folderNameNow = (id: string) =>
    useAppStore.getState().library?.groups.find((group) => group.id === id)?.name ?? "";
  return {
    accepts(dragged, at) {
      if (dragged.kind === "links") return { kind: "add" };
      if (dragged.kind !== "objects") return null;
      const folders = foldersDragged(dragged.refs);
      if (onlyFolders(dragged.refs, folders)) {
        if (folderId === null) return null;
        const place = folderZoneOf(rect?.() ?? null, at);
        const parents = new Map(groupsNow().map((group) => [group.id, group.parentId] as const));
        if (place === "into") {
          if (folders.some((folder) => folderInsideItself(folder, folderId))) return null;
          if (folders.every((folder) => (parents.get(folder) ?? null) === folderId)) return null;
          return { kind: "move", place, said: (t) => t("drop.into") };
        }
        if (folders.some((folder) => besideInsideItself(folder, folderId))) return null;
        if (!folders.some((folder) => besideChanges(folder, folderId))) return null;
        return { kind: "move", place, said: (t) => t("drop.beside") };
      }
      if (folders.length > 0) return null;
      if (!wouldMove(dragged.refs, folderId)) return null;
      const items = itemsOfRefs(dragged.refs);
      return {
        kind: "move",
        said: (t) =>
          moveLabel(t, items, folderId ? folderNameNow(folderId) : t("library.unsorted")),
      };
    },
    refuses(dragged, at) {
      if (dragged.kind !== "objects" || folderId === null) return null;
      const folders = foldersDragged(dragged.refs);
      if (!onlyFolders(dragged.refs, folders)) return null;
      const place = folderZoneOf(rect?.() ?? null, at);
      if (place === "into") {
        return folders.some((folder) => folderInsideItself(folder, folderId))
          ? (t) => t("folder.refuse.inside")
          : null;
      }
      // An edge says why only where the drop would put a Folder inside itself; an edge
      // that would change nothing shows nothing, as every target does (#246).
      return folders.some((folder) => besideInsideItself(folder, folderId))
        ? (t) => t("folder.refuse.inside")
        : null;
    },
    drop(dropped, effect) {
      if (dropped.kind === "links") {
        void useWebPages.getState().add(linksIn(dropped.data), folderId);
        return null;
      }
      if (dropped.kind !== "objects") return null;
      const folders = foldersDragged(dropped.refs);
      if (onlyFolders(dropped.refs, folders)) {
        if (folderId === null) return null;
        const place = effect.place ?? "into";
        const parent =
          place === "into"
            ? folderId
            : ((groupsNow().find((group) => group.id === folderId)?.parentId ?? null) as
                | string
                | null);
        void useAppStore.getState().moveFolders(folders, parent);
        return null;
      }
      if (folders.length > 0) return null;
      const moved = useAppStore.getState().moveToFolder(itemsOfRefs(dropped.refs), folderId);
      doneWithSelection(dropped);
      return moved;
    },
  };
}

/** A Folder being dragged: onto another to nest it, or onto the tree's top level to take it out. */
export function folderDrag(folder: { id: string; name: string }, from: SelectSurface): ObjectDrag {
  return { refs: [{ kind: "folder", id: folder.id }], name: folder.name, from };
}

/**
 * A Folder dragged from a row of a list with a selection: the Folders selected with
 * it, when it is one of them, so dragging one of several moves them all; else the row.
 */
export function folderRowDrag(
  folder: { id: string; name: string },
  surface: SelectSurface,
): ObjectDrag {
  const chosen = selectedOn(surface);
  const held = chosen.some((each) => each.kind === "folder" && each.id === folder.id);
  const folders = held ? chosen.filter((each) => each.kind === "folder") : [];
  if (folders.length <= 1) return folderDrag(folder, surface);
  return {
    refs: folders,
    name: translateNow("folder.count", { count: folders.length }),
    from: surface,
  };
}

/** The tree's top level: a Folder dropped there comes out of the Folder it is in. */
export function folderTopTarget(): DropTarget<FolderPlace> {
  return {
    accepts(dragged) {
      if (dragged.kind !== "objects") return null;
      const folders = foldersDragged(dragged.refs);
      if (!onlyFolders(dragged.refs, folders)) return null;
      const parentOf = new Map(groupsNow().map((group) => [group.id, group.parentId] as const));
      if (!folders.some((folder) => (parentOf.get(folder) ?? null) !== null)) return null;
      return { kind: "move", place: "into", said: (t) => t("drop.topLevel") };
    },
    drop(dropped) {
      const folders = dropped.kind === "objects" ? foldersDragged(dropped.refs) : [];
      if (folders.length > 0) void useAppStore.getState().moveFolders(folders, null);
      return null;
    },
  };
}

/** Move to…: the same as a drop on the Folder (null: out of every Folder). */
export const moveIntoFolder = (items: MoveItems, folderId: string | null): Promise<void> =>
  runDrop(folderTarget(folderId), [
    ...(items.mindIds ?? []).map((id) => ({ kind: "mind" as const, id })),
    ...(items.documentIds ?? []).map((id) => ({ kind: "document" as const, id })),
  ]);

/** Whether something in a Folder is being dragged: Not in a Folder then shows, empty or not, to take it. */
export const useDraggedOutOfFolder = (): boolean =>
  useDragState((state) => state.source !== null && wouldMove(state.source.refs, null));

function taggable(refs: readonly ObjectRef[], tagId: string): string[] {
  const known = indexFor(refs);
  const answer = known.tagged.get(tagId);
  if (answer) return answer;
  const ids = refs.some((ref) => ref.kind !== "document")
    ? []
    : refs.flatMap((ref) => {
        const link = known.documentById.get(ref.id)?.tags.find((each) => each.tagId === tagId);
        // An automatic Tag, or one awaiting review, becomes the User's own.
        return link?.source !== "user" || link.needsReview ? [ref.id] : [];
      });
  known.tagged.set(tagId, ids);
  return ids;
}

export function tagTarget(tagId: string): DropTarget {
  const tagName = () => useAppStore.getState().tags.find((tag) => tag.id === tagId)?.name ?? "";
  return {
    accepts(dragged) {
      if (dragged.kind !== "objects") return null;
      const count = taggable(dragged.refs, tagId).length;
      if (count === 0) return null;
      return {
        kind: "add",
        said: (t) =>
          count === 1
            ? t("drop.addTag", { tag: tagName() })
            : t("drop.addTag.documents", { tag: tagName(), count }),
      };
    },
    drop(dropped) {
      if (dropped.kind !== "objects") return null;
      const ids = taggable(dropped.refs, tagId);
      if (ids.length === 0) return null;
      const tagged = useAppStore.getState().addTagToDocuments(ids, tagId);
      doneWithSelection(dropped);
      return tagged;
    },
  };
}
