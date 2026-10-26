import type { Document, DocumentGroupAssignment } from "../../core/api";

type Held = Pick<DocumentGroupAssignment, "status" | "groupId" | "source" | "suggested">;

export type OrganizeState = "suggested" | "notSorted" | "sorted" | "unsettled";

const decidedByUser = (item: Held): boolean => !item.suggested && item.source === "user";

/**
 * The one answer every line reads (#1928, #1955). The User's own choice settles a Document
 * even when a later run failed; a Suggested Folder still waits; anything Organize hasn't
 * finished — or never reached — is neither sorted nor one it couldn't sort.
 */
export const organizeStateOf = (
  doc: Pick<Document, "tagging"> | undefined,
  item: Held | undefined,
): OrganizeState => {
  if (!doc || !item) return "unsettled";
  if (item.suggested && item.groupId !== null) return "suggested";
  if (decidedByUser(item)) return "sorted";
  if (item.status === "failed" && item.groupId === null) return "notSorted";
  if (item.status === "classified" && doc.tagging !== "stopped") return "sorted";
  return "unsettled";
};

/** The live Documents waiting in a Suggested Folder: what To review lists and Accept all takes. */
export const suggestedIds = (
  documents: readonly Pick<Document, "id">[],
  assignments: readonly (Held & Pick<DocumentGroupAssignment, "documentId">)[],
): string[] => {
  const held = new Map(assignments.map((item) => [item.documentId, item]));
  return documents.flatMap((doc) => {
    const item = held.get(doc.id);
    return item?.suggested && item.groupId !== null ? [doc.id] : [];
  });
};

/** The live Documents whose latest run failed and the User hasn't settled them: Try again's list. */
export const organizeFailedIds = (
  documents: readonly Pick<Document, "id">[],
  assignments: readonly (Held & Pick<DocumentGroupAssignment, "documentId">)[],
): ReadonlySet<string> => {
  const held = new Map(assignments.map((item) => [item.documentId, item]));
  return new Set(
    documents.flatMap((doc) => {
      const item = held.get(doc.id);
      return item?.status === "failed" && !decidedByUser(item) ? [doc.id] : [];
    }),
  );
};

/** A Document that is gone has no state left to report: only live Documents are asked. */
export const notSortedIds = (
  documents: readonly Pick<Document, "id" | "tagging">[],
  assignments: readonly (Held & Pick<DocumentGroupAssignment, "documentId">)[],
): ReadonlySet<string> => {
  const held = new Map(assignments.map((item) => [item.documentId, item]));
  return new Set(
    documents.flatMap((doc) =>
      organizeStateOf(doc, held.get(doc.id)) === "notSorted" ? [doc.id] : [],
    ),
  );
};
