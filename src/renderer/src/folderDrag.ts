import type { Document, LibrarySnapshot, Mind } from "../../core/api";
import { type Dropped, type DropTarget, runDrop, useDragState } from "./dragDrop";
import { type MoveItems, moveLabel } from "./moves";
import type { ObjectRef } from "./objects";
import { useSelection } from "./selection";
import { useAppStore } from "./store";
import { linksIn, useWebPages } from "./webPages";

/**
 * The drop targets that file Minds and Documents: a Folder, Not in a Folder
 * (null) and a Tag, in the sidebar and on the Library page. A Folder lights
 * only while the drop would move something there, as Move to… does; a Tag
 * only while every Document dragged is one and one of them would get it. A
 * link dragged from a browser onto a Folder is saved there as a web page
 * (#261).
 */

export const itemsOfRefs = (refs: readonly ObjectRef[]): MoveItems => ({
  mindIds: refs.flatMap((ref) => (ref.kind === "mind" ? [ref.id] : [])),
  documentIds: refs.flatMap((ref) => (ref.kind === "document" ? [ref.id] : [])),
});

const folderNow = (folderId: string | null) =>
  useAppStore.getState().library?.groups.find((group) => group.id === folderId)?.name ?? "";

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

export function folderTarget(folderId: string | null): DropTarget {
  return {
    accepts(dragged) {
      if (dragged.kind === "links") return { kind: "add" };
      if (dragged.kind !== "objects" || !wouldMove(dragged.refs, folderId)) return null;
      const items = itemsOfRefs(dragged.refs);
      return {
        kind: "move",
        said: (t) => moveLabel(t, items, folderId ? folderNow(folderId) : t("library.unsorted")),
      };
    },
    drop(dropped) {
      if (dropped.kind === "links") {
        void useWebPages.getState().add(linksIn(dropped.data), folderId);
        return null;
      }
      if (dropped.kind !== "objects") return null;
      const moved = useAppStore.getState().moveToFolder(itemsOfRefs(dropped.refs), folderId);
      doneWithSelection(dropped);
      return moved;
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
