import type { Document, TagLinkState } from "../core/api";

/** How each Document carries the Tag now, to put back with `revertDocumentTags`. */
export function tagLinks(
  documents: readonly Pick<Document, "id" | "tags">[],
  documentIds: readonly string[],
  tagId: string,
): TagLinkState[] {
  return documentIds.map((documentId) => {
    const link = documents
      .find((document) => document.id === documentId)
      ?.tags.find((each) => each.tagId === tagId);
    return {
      documentId,
      tagId,
      link: link
        ? { source: link.source, confidence: link.confidence, needsReview: link.needsReview }
        : null,
    };
  });
}
