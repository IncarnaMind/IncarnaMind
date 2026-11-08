import type {
  DocumentGroupAssignment,
  LibraryGroup,
  OrganizeReview,
  OrganizeReviewItem,
  OrganizeReviewLeftOut,
  OrganizeReviewTarget,
} from "../../core/api";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { buildFolderTree, flattenFolderTree, folderPath, type TreeFolder } from "./folders";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** How many rows a card shows before "Show all {n}"; its tick covers every row, shown or not. */
export const CARD_ROWS = 8;

export interface ReviewCard {
  /** The Folder's id: one of the Library's, or one proposed by name. */
  id: string;
  target: Exclude<OrganizeReviewTarget, { kind: "leftOut" }>;
  name: string;
  /** Its parents' names, "Contracts", shown quieter before its own: "Contracts › Leases". */
  parentPath: string | null;
  /** The Folder it is in, of the Library or proposed; null at the top level. */
  parentId: string | null;
  proposed: boolean;
  items: OrganizeReviewItem[];
}

/**
 * The Suggestions as the Review lays them out: the Library's Folders a Document would go into, in
 * the sidebar's order, then the Folders proposed by name, each subfolder straight after its
 * parent, then what is left out. `scope` is the Folder a Folder's own Organize sorted: every row
 * came from that run and its Documents are all in that Folder.
 */
export interface ReviewLayout {
  scope: LibraryGroup | null;
  yours: ReviewCard[];
  proposed: ReviewCard[];
  leftOut: OrganizeReviewItem[];
  /** The rows Confirm acts on: every one the Review shows. */
  itemIds: string[];
}

export function reviewLayout(
  review: OrganizeReview,
  folders: readonly LibraryGroup[],
  assignments: readonly Pick<DocumentGroupAssignment, "documentId" | "groupId">[],
): ReviewLayout {
  const placed = new Map<string, OrganizeReviewItem[]>();
  const leftOut: OrganizeReviewItem[] = [];
  for (const item of review.items) {
    const { placement } = item;
    const id =
      placement.kind === "folder"
        ? placement.folderId
        : placement.kind === "newFolder"
          ? placement.newFolderId
          : null;
    if (placement.kind === "leftOut") leftOut.push(item);
    if (id === null) continue;
    const list = placed.get(id);
    if (list) list.push(item);
    else placed.set(id, [item]);
  }
  const tree: TreeFolder[] = [
    ...folders.map(({ id, name, parentId }) => ({ id, name, parentId })),
    ...review.folders.map(({ id, name, parentId, parentNewFolderId }) => ({
      id,
      name,
      parentId: parentNewFolderId ?? parentId,
    })),
  ];
  const ordered = flattenFolderTree(buildFolderTree(tree)).map((node) => node.folder.id);
  const live = new Set(folders.map((folder) => folder.id));
  const proposedIds = new Set(review.folders.map((folder) => folder.id));
  const parents = new Map(tree.map((folder) => [folder.id, folder.parentId]));
  const cardOf = (id: string): ReviewCard => {
    const names = folderPath(tree, id);
    const proposed = proposedIds.has(id);
    return {
      id,
      target: proposed ? { kind: "newFolder", newFolderId: id } : { kind: "folder", folderId: id },
      name: names.at(-1) ?? "",
      parentPath: names.length > 1 ? names.slice(0, -1).join(" › ") : null,
      parentId: parents.get(id) ?? null,
      proposed,
      items: placed.get(id) ?? [],
    };
  };
  const yours = ordered.filter((id) => live.has(id) && placed.has(id)).map(cardOf);
  const proposed = ordered.filter((id) => proposedIds.has(id)).map(cardOf);
  return {
    scope: scopeOf(review.items, folders, assignments),
    yours,
    proposed,
    leftOut,
    itemIds: review.items.map((item) => item.id),
  };
}

/** The Folder whose own Organize every row came from, when all its Documents sit in it. */
function scopeOf(
  items: readonly OrganizeReviewItem[],
  folders: readonly LibraryGroup[],
  assignments: readonly Pick<DocumentGroupAssignment, "documentId" | "groupId">[],
): LibraryGroup | null {
  if (items.length === 0 || items.some((item) => item.origin !== "folder")) return null;
  const places = new Map(assignments.map((each) => [each.documentId, each.groupId]));
  const within = new Set(items.map((item) => places.get(item.documentId) ?? null));
  const [only] = within;
  return within.size === 1 && only ? (folders.find((folder) => folder.id === only) ?? null) : null;
}

/** What Confirm would do, from the ticks: how many Documents move, into how many Folders. */
export function confirmCounts(layout: ReviewLayout): {
  documents: number;
  yours: number;
  proposed: number;
} {
  const ticked = (card: ReviewCard) => card.items.filter((item) => item.ticked).length;
  const yours = layout.yours.filter((card) => ticked(card) > 0);
  const proposed = layout.proposed.filter((card) => ticked(card) > 0);
  // A proposed parent is made with its subfolders, though no Document goes into it alone.
  const byId = new Map(layout.proposed.map((card) => [card.id, card]));
  const made = new Set<string>();
  for (const card of proposed) {
    for (let at: ReviewCard | undefined = card; at && !made.has(at.id); ) {
      made.add(at.id);
      at = at.parentId === null ? undefined : byId.get(at.parentId);
    }
  }
  return {
    documents: [...yours, ...proposed].reduce((sum, card) => sum + ticked(card), 0),
    yours: yours.length,
    proposed: made.size,
  };
}

/** "Contracts › Leases". */
export const cardPath = (card: Pick<ReviewCard, "name" | "parentPath">) =>
  card.parentPath === null ? card.name : `${card.parentPath} › ${card.name}`;

/** The Review's line under its title: "33 Documents will move into 5 new Folders. Nothing has moved yet." */
export function willMoveText(layout: ReviewLayout, t: Translate): string {
  const { documents, yours, proposed } = confirmCounts(layout);
  if (documents === 0) return t("organizeReview.willMove.none");
  const sub = layout.scope !== null;
  const yoursText = t(
    sub
      ? yours === 1
        ? "organizeReview.into.subfolders.one"
        : "organizeReview.into.subfolders"
      : yours === 1
        ? "organizeReview.into.yours.one"
        : "organizeReview.into.yours",
    { count: yours },
  );
  const freshText = (alone: boolean) =>
    t(
      alone
        ? sub
          ? proposed === 1
            ? "organizeReview.into.newSubfolders.one"
            : "organizeReview.into.newSubfolders"
          : proposed === 1
            ? "organizeReview.into.new.one"
            : "organizeReview.into.new"
        : proposed === 1
          ? sub
            ? "organizeReview.into.newOnes.sub.one"
            : "organizeReview.into.newOnes.one"
          : sub
            ? "organizeReview.into.newOnes.sub"
            : "organizeReview.into.newOnes",
      { count: proposed },
    );
  const into =
    yours > 0 && proposed > 0
      ? t("organizeReview.into.both", { yours: yoursText, fresh: freshText(false) })
      : yours > 0
        ? yoursText
        : freshText(true);
  return t("organizeReview.willMove", {
    documents: t(documents === 1 ? "organizeReview.documents.one" : "organizeReview.documents", {
      count: documents,
    }),
    into,
  });
}

/** Why a Document is left out, in the app's own words: the model writes none of them. */
export function leftOutText(
  leftOut: OrganizeReviewLeftOut | null,
  folderName: (id: string) => string,
  stays: string | null,
  t: Translate,
): string | null {
  if (leftOut === null) return null;
  switch (leftOut.reason) {
    case "doesntFit":
      return t("organizeReview.leftOut.doesntFit");
    case "staysInFolder":
      return stays === null ? null : t("organizeReview.leftOut.stays", { folder: stays });
    case "noText":
      return t("organizeReview.leftOut.noText");
    case "unreachable":
      return t("organizeReview.leftOut.unreachable", { service: leftOut.service });
    case "walled":
      return t("organizeReview.leftOut.walled", { folder: folderName(leftOut.folderId) });
  }
}
