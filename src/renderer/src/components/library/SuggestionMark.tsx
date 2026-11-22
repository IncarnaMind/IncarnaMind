import type { OrganizeReview, OrganizeReviewItem } from "../../../../core/api";
import { useT } from "../../i18n";
import { openReview, useOrganizeReview } from "../../organizeReview";
import { waitsToConfirm } from "../../organizeReviewView";
import { useAppStore } from "../../store";

const waiting = new WeakMap<OrganizeReview, ReadonlyMap<string, OrganizeReviewItem>>();

/** Each Document with something to confirm, a Folder or a Tag, by its id: read once a Review. */
function waitingIn(review: OrganizeReview | null): ReadonlyMap<string, OrganizeReviewItem> | null {
  if (!review) return null;
  let byDocument = waiting.get(review);
  if (!byDocument) {
    byDocument = new Map(
      review.items.filter(waitsToConfirm).map((item) => [item.documentId, item]),
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
  const intoFolder = placement.kind === "folder" || placement.kind === "newFolder";
  const folder =
    placement.kind === "folder"
      ? groups?.find((group) => group.id === placement.folderId)?.name
      : placement.kind === "newFolder"
        ? folders?.find((each) => each.id === placement.newFolderId)?.name
        : undefined;
  // A Folder deleted since is gone from the Library before the Suggestions are read again.
  if (intoFolder && folder === undefined) return null;
  return (
    <button
      type="button"
      data-testid="library-suggested"
      title={t("library.review.open")}
      onClick={openReview}
      className="inline-flex min-w-0 max-w-60 shrink-[100] items-center rounded-sm text-label font-semibold text-ink-meta underline-offset-2 hover:text-ink hover:underline"
    >
      <span className="truncate">
        {folder === undefined
          ? t("organizeReview.title.tags")
          : t("library.row.suggested", { folder })}
      </span>
    </button>
  );
}
