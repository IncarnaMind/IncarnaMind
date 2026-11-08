/**
 * Suggestions (CONTEXT.md): what Organize and tagging propose, held until the User confirms it
 * (#1569, #2339). Nothing here is kept in the Library before Confirm.
 */

/** What started the run that proposed a row. Only "background" and "migrated" weren't the User's. */
export type OrganizeReviewOrigin =
  | "library"
  | "folder"
  | "retag"
  | "assistant"
  | "background"
  | "migrated";

/**
 * Why a Document is left out, as a code: the interface says it in its own words, and the model
 * writes none of them.
 */
export type OrganizeReviewLeftOut =
  | { reason: "doesntFit" }
  /** Organize This Folder found no subfolder for it: it stays at the Folder's top level. */
  | { reason: "staysInFolder" }
  | { reason: "noText" }
  /** `service` is its name as the User sees it (`ExternalService.name`). */
  | { reason: "unreachable"; service: string }
  /** A Folder that keeps its work inside it holds the Document. */
  | { reason: "walled"; folderId: string };

export type OrganizeReviewPlacement =
  | { kind: "folder"; folderId: string }
  | { kind: "newFolder"; newFolderId: string }
  /** `leftOut` is null when the User moved it there. */
  | { kind: "leftOut"; leftOut: OrganizeReviewLeftOut | null }
  /** Only Tags were asked for: it stays where it is. */
  | { kind: "unchanged" };

export interface OrganizeReviewTag {
  id: string;
  /** The Library's Tag; null for a new one, which Confirm makes. */
  tagId: string | null;
  name: string;
  description: string;
  addedByUser: boolean;
}

export interface OrganizeReviewItem {
  id: string;
  documentId: string;
  placement: OrganizeReviewPlacement;
  ticked: boolean;
  origin: OrganizeReviewOrigin;
  /** The User changed it: no run replaces it. */
  edited: boolean;
  tags: OrganizeReviewTag[];
}

/** A Folder proposed by name, made at Confirm. */
export interface OrganizeReviewFolder {
  id: string;
  name: string;
  description: string;
  /** The Library's Folder it would be made in; null at the top level or in a proposed Folder. */
  parentId: string | null;
  /** The proposed Folder it would be made in, shown first: "Contracts › Leases". */
  parentNewFolderId: string | null;
}

export interface OrganizeReview {
  /** Every row waiting, each Document once, in the order the runs added them. */
  items: OrganizeReviewItem[];
  /** The proposed Folders that a row waits in. */
  folders: OrganizeReviewFolder[];
  /** How many Documents wait with something to confirm: a Folder or a Tag. */
  count: number;
}

export type OrganizeReviewTarget =
  | { kind: "folder"; folderId: string }
  | { kind: "newFolder"; newFolderId: string }
  | { kind: "leftOut" };

/**
 * One change the User makes before Confirm. Unticking a row, or taking a proposed Tag off, means
 * it isn't proposed again for that Document for 30 days.
 */
export type OrganizeReviewEdit =
  | { kind: "tick"; itemIds: string[]; ticked: boolean }
  | { kind: "move"; itemIds: string[]; to: OrganizeReviewTarget }
  | {
      kind: "addTag";
      itemId: string;
      tag: { tagId: string } | { name: string; description?: string };
    }
  | { kind: "removeTag"; itemId: string; tagRowId: string }
  | { kind: "renameFolder"; newFolderId: string; name: string }
  | {
      kind: "mergeFolder";
      newFolderId: string;
      into: Exclude<OrganizeReviewTarget, { kind: "leftOut" }>;
    };

/** A stored row as a change found or left it, for `restoreOrganizeReview`. */
export interface OrganizeReviewRow {
  table: "items" | "folders" | "tags" | "declines";
  id: string;
  /** Its columns, `updated_at` aside. A row the change made is, before it, deleted when made. */
  values: Record<string, string | number | null>;
}

/** The rows one change touched, before and after it, in the same order. */
export interface OrganizeReviewChange {
  before: OrganizeReviewRow[];
  after: OrganizeReviewRow[];
}

export interface OrganizeReviewConfirmation {
  /** For `undoOrganizeReviewConfirmation` and `redoOrganizeReviewConfirmation`. */
  id: string;
  /** The Documents it filed or tagged: "Organized 33 Documents". */
  documentIds: string[];
  folderIds: string[];
  tagIds: string[];
}
