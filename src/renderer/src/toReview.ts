import type { Document, DocumentGroupAssignment, LibraryGroup } from "../../core/api";
import type { MessageKey, MessageParams } from "../../shared/i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

export const TO_REVIEW = "to-review";

export interface ReviewGroup {
  folder: LibraryGroup;
  documents: Document[];
}

export interface ToReview {
  count: number;
  /** Most Documents first; Folders with as many keep the order they were given in. */
  groups: ReviewGroup[];
}

export function toReviewOf(
  documents: readonly Document[],
  folders: readonly LibraryGroup[],
  assignments: readonly Pick<DocumentGroupAssignment, "documentId" | "groupId" | "suggested">[],
): ToReview {
  const waiting = new Map(
    assignments.flatMap((each) =>
      each.suggested && each.groupId !== null ? [[each.documentId, each.groupId] as const] : [],
    ),
  );
  const byFolder = new Map<string, Document[]>(folders.map((folder) => [folder.id, []]));
  for (const document of documents) byFolder.get(waiting.get(document.id) ?? "")?.push(document);
  const groups = folders
    .map((folder) => ({ folder, documents: byFolder.get(folder.id) ?? [] }))
    .filter((group) => group.documents.length > 0)
    .sort((a, b) => b.documents.length - a.documents.length);
  return { count: groups.reduce((sum, group) => sum + group.documents.length, 0), groups };
}

export const reviewIds = (review: ToReview): string[] =>
  review.groups.flatMap((group) => group.documents.map((document) => document.id));

export function reviewSummary(review: ToReview, t: Translate): string {
  const parts = review.groups
    .map((group) =>
      t("library.review.part", { count: group.documents.length, folder: group.folder.name }),
    )
    .join(t("library.review.separator"));
  return t(review.count === 1 ? "library.review.summary.one" : "library.review.summary", {
    count: review.count,
    parts,
  });
}
