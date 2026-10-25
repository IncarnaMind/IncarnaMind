import type { DocumentGroupAssignment, TaggingState } from "../../core/api";

type Held = Pick<DocumentGroupAssignment, "status" | "groupId" | "source" | "suggested">;

/**
 * Organize couldn't sort the Document: it ran, placed it in no Folder, and failed. A restored
 * assignment may keep that state with no reason saved; it still says so.
 */
export const isNotSorted = (item: Held | undefined): boolean =>
  item?.status === "failed" && item.groupId === null;

/**
 * Organize is done with the Document and nothing waits: the User filed it or accepted a Folder,
 * or Organize placed it or chose no Folder for it. A Document Organize stopped short of, where
 * tagging with AI is off, was never put to it; one still waiting has not been.
 */
export const isSorted = (item: Held | undefined, tagging: TaggingState): boolean =>
  !!item &&
  !item.suggested &&
  (item.source === "user" || (item.status === "classified" && tagging !== "stopped"));
