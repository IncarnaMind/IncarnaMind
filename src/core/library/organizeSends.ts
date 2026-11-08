/**
 * What Organize sends to its model's service, kind by kind, under the classification flow's
 * consent (#1569, ADR-0022). The card that asks before a service first reads the Documents, the
 * footer's Allow and the assistant's card name every kind listed here, never fewer. Each request
 * Organize builds is checked field by field against `ORGANIZE_FIELDS` in
 * tests/core/organizeSends.test.ts, so a request that starts carrying something new fails there
 * until it is listed here and the card's words name it.
 */
export const ORGANIZE_SENDS = [
  "document-name",
  /** Its kind and page count: "PDF, 12 pages". */
  "document-kind",
  "document-start",
  /** A deck's slide titles, a workbook's sheet names. */
  "document-outline",
  /** With the names of the Folders it is in, and the Folder a run organizes. */
  "folder-name",
  "folder-description",
  "tag-name",
  "tag-description",
  /** The language the User has IncarnaMind in, which new Folders are named in. */
  "language",
] as const;

export type OrganizeSend = (typeof ORGANIZE_SENDS)[number];

/**
 * What else a field can hold: the app's own (a reference such as "d1" or a Folder's id, fixed
 * words, the model's name), which says nothing of the User's, or which of a scan's pages come as
 * images, which go only under their own flow ("scan-images"), so the card doesn't name them.
 */
export type OrganizeFieldKind = OrganizeSend | "app" | "page-images";

/**
 * Every field each request carries, by request and path ("[]" for each item of a list, "*" for
 * each key of a record), with the kinds of data it holds. The fixed instructions aren't fields.
 */
export const ORGANIZE_FIELDS: Readonly<Record<string, readonly OrganizeFieldKind[]>> = {
  // The plan's sample, which proposes the Folders (./planModel, `sort`).
  "sort.language": ["language"],
  "sort.within": ["folder-name"],
  "sort.folders[].id": ["app"],
  "sort.folders[].name": ["folder-name"],
  "sort.folders[].description": ["folder-description"],
  "sort.documents[].ref": ["app"],
  "sort.documents[].name": ["document-name"],
  "sort.documents[].type": ["document-kind"],
  "sort.documents[].text": ["document-start", "document-outline"],
  // The rest of the Documents, placed in batches (`place`).
  "place.folders[].id": ["app"],
  "place.folders[].name": ["folder-name"],
  "place.folders[].description": ["folder-description"],
  "place.documents[].ref": ["app"],
  "place.documents[].name": ["document-name"],
  "place.documents[].type": ["document-kind"],
  "place.documents[].text": ["document-start", "document-outline"],
  // Subfolders of a big new Folder, named (`nameSubfolders`).
  "subfolders.language": ["language"],
  "subfolders.groups[].ref": ["app"],
  "subfolders.groups[].folder": ["folder-name"],
  "subfolders.groups[].documents[].name": ["document-name"],
  "subfolders.groups[].documents[].type": ["document-kind"],
  "subfolders.groups[].documents[].text": ["document-start", "document-outline"],
  // One Document at a time, with a chat model (./classifier, `chatGroupClassifier`).
  "document.groups[].id": ["app"],
  "document.groups[].name": ["folder-name"],
  "document.groups[].description": ["folder-description"],
  "document.tags[].id": ["app"],
  "document.tags[].name": ["tag-name"],
  "document.tags[].description": ["tag-description"],
  "document.document.name": ["document-name"],
  "document.document.type": ["document-kind"],
  "document.document.outline": ["document-outline"],
  "document.document.text": ["document-start"],
  "document.document.pages[]": ["page-images"],
  // One Document at a time, with a decision model on another host or Jev's
  // (`decisionGroupClassifier`): a question for each Tag, and one for the Folder.
  "decision.model": ["app"],
  "decision.state.name": ["document-name"],
  "decision.state.kind": ["document-kind"],
  "decision.state.pageCount": ["document-kind"],
  "decision.state.outline": ["document-outline"],
  "decision.state.text": ["document-start"],
  "decision.questions.*.type": ["app"],
  "decision.questions.*.instructions": ["tag-name"],
  "decision.questions.*.criteria.true": ["tag-name", "tag-description"],
  "decision.questions.group.type": ["app"],
  "decision.questions.group.instructions": ["app"],
  "decision.questions.group.criteria.*": ["folder-name", "folder-description"],
};
