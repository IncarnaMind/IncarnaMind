import type { OrganizeReview, OrganizeReviewItem } from "../../../../core/api";
import { useT } from "../../i18n";
import { openReview, useOrganizeReview } from "../../organizeReview";
import { useAppStore } from "../../store";

const waiting = new WeakMap<OrganizeReview, ReadonlyMap<string, OrganizeReviewItem>>();

/** Each Document with something to confirm, a Folder or a Tag, by its id: read once a Review. */
function waitingIn(review: OrganizeReview | null): ReadonlyMap<string, OrganizeReviewItem> | null {
  if (!review) return null;
  let byDocument = waiting.get(review);
  if (!byDocument) {
    byDocument = new Map(
      review.items
        .filter(
          (item) =>
            item.ticked &&
            (item.placement.kind === "folder" ||
              item.placement.kind === "newFolder" ||
              item.tags.length > 0),
        )
        .map((item) => [item.documentId, item]),
    );
    waiting.set(review, byDocument);
  }
  return byDocument;
}

/**
 * A Library row's Suggestion, while it waits for the User (#3610): the Folder it would go into, or
 * that Tags wait for it; a press opens the Review. Nothing is filed or tagged before Confirm.
 */
export function SuggestionMark({ documentId }: { documentId: string }) {
  const t = useT();
  const item = useOrganizeReview((state) => waitingIn(state.review)?.get(documentId));
  const folders = useOrganizeReview((state) => state.review?.folders);
  const groups = useAppStore((state) => state.library?.groups);
  if (!item) return null;
  const { placement } = item;
  const folder =
    placement.kind === "folder"
      ? groups?.find((group) => group.id === placement.folderId)?.name
      : placement.kind === "newFolder"
        ? folders?.find((each) => each.id === placement.newFolderId)?.name
        : undefined;
  return (
    <button
      type="button"
      data-testid="library-suggested"
      title={t("library.review.open")}
      onClick={openReview}
      className="inline-flex max-w-60 shrink-0 items-center rounded-sm text-label font-semibold text-ink-meta underline-offset-2 hover:text-ink hover:underline"
    >
      <span className="truncate">
        {folder === undefined
          ? t("organizeReview.title.tags")
          : t("library.row.suggested", { folder })}
      </span>
    </button>
  );
}
