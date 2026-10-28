import type { Document, DocumentGroupAssignment } from "../../core/api";

type Held = Pick<DocumentGroupAssignment, "status" | "groupId" | "source" | "suggested">;

export interface OrganizeState {
  /** The latest run, as Try again, the pending count and Get info read it. */
  readonly run: "none" | "working" | "waiting" | "failed" | "done" | "stopped";
  /** Where the Document stands, as its row mark and the title line read it. */
  readonly place: "neither" | "notSorted" | "sorted";
  /** A Suggested Folder waits: its mark, its reason, To review, Accept all and Home. */
  readonly suggested: boolean;
  /** The User put it where it is: their place stands over a later run. */
  readonly manual: boolean;
}

const NEVER: OrganizeState = { run: "none", place: "neither", suggested: false, manual: false };

/**
 * The one answer every line reads (#1928, #1955). The User's own choice settles a Document even
 * when a later run failed; a Suggested Folder still waits; anything Organize hasn't finished —
 * or never reached — is neither sorted nor one it couldn't sort.
 */
export const organizeStateOf = (
  doc: Pick<Document, "tagging"> | undefined,
  item: Held | undefined,
): OrganizeState => {
  if (!doc || !item) return NEVER;
  const suggested = item.suggested && item.groupId !== null;
  const manual = !item.suggested && item.source === "user";
  const run: OrganizeState["run"] =
    item.status === "pending" || item.status === "classifying"
      ? "working"
      : item.status === "waiting"
        ? "waiting"
        : item.status === "failed"
          ? "failed"
          : item.status === "classified"
            ? !manual && doc.tagging === "stopped"
              ? "stopped"
              : "done"
            : "none";
  const place: OrganizeState["place"] =
    manual || (!suggested && run === "done")
      ? "sorted"
      : !suggested && run === "failed" && item.groupId === null
        ? "notSorted"
        : "neither";
  return { run, place, suggested, manual };
};

function heldOf(
  assignments: readonly (Held & Pick<DocumentGroupAssignment, "documentId">)[],
): ReadonlyMap<string, Held> {
  return new Map(assignments.map((item) => [item.documentId, item]));
}

/** The live Documents waiting in a Suggested Folder: what To review lists and Accept all takes. */
export const suggestedIds = (
  documents: readonly Pick<Document, "id" | "tagging">[],
  assignments: readonly (Held & Pick<DocumentGroupAssignment, "documentId">)[],
): string[] => {
  const held = heldOf(assignments);
  return documents.flatMap((doc) =>
    organizeStateOf(doc, held.get(doc.id)).suggested ? [doc.id] : [],
  );
};

/** The live Documents whose latest run failed and the User hasn't settled them: Try again's list. */
export const organizeFailedIds = (
  documents: readonly Pick<Document, "id" | "tagging">[],
  assignments: readonly (Held & Pick<DocumentGroupAssignment, "documentId">)[],
): ReadonlySet<string> => {
  const held = heldOf(assignments);
  return new Set(
    documents.flatMap((doc) => {
      const state = organizeStateOf(doc, held.get(doc.id));
      return state.run === "failed" && !state.manual ? [doc.id] : [];
    }),
  );
};

/** A Document that is gone has no state left to report: only live Documents are asked. */
export const notSortedIds = (
  documents: readonly Pick<Document, "id" | "tagging">[],
  assignments: readonly (Held & Pick<DocumentGroupAssignment, "documentId">)[],
): ReadonlySet<string> => {
  const held = heldOf(assignments);
  return new Set(
    documents.flatMap((doc) =>
      organizeStateOf(doc, held.get(doc.id)).place === "notSorted" ? [doc.id] : [],
    ),
  );
};
