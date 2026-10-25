import type { Document } from "../../../../core/api";
import { displayName } from "../../../../shared/documentNames";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { acceptSuggestions } from "../../suggestionReview";
import { CheckLineIcon, ChevronDownLineIcon } from "../lineIcons";
import { ReviewRing } from "../TagColour";
import { documentsToMove, useDocumentMove } from "./DocumentMoveTo";

/**
 * Up to 560px the page gives a To review row two lines: the name whole on the first, and under
 * it the Tags, Folder and Accept. A name is never what gives way. Wider, one line, whose columns
 * give up room with the page's (`useFittingColumns`).
 */
export const REVIEW_ROW =
  "flex min-h-[39px] flex-wrap items-center gap-x-2 gap-y-0 pr-1.5 pl-3 @max-[560px]/page:py-1 @min-[561px]/page:flex-nowrap @min-[561px]/page:gap-x-4 @min-[561px]/page:group-data-[hide~=narrowest]/page:gap-x-2";

export const REVIEW_COLUMNS = {
  name: "@max-[560px]/page:basis-full",
  tags: "min-w-0 flex-1 @max-[560px]/page:ml-5 @min-[561px]/page:w-[200px] @min-[561px]/page:flex-none @min-[561px]/page:group-data-[hide~=narrow]/page:w-[152px] @min-[561px]/page:group-data-[hide~=narrower]/page:w-[112px] @min-[561px]/page:group-data-[hide~=narrowest]/page:w-[88px] @min-[561px]/page:group-data-[hide~=chips]/page:w-auto @min-[561px]/page:group-data-[hide~=chips]/page:[&_[data-testid^=tag-chip]]:hidden",
  folder:
    "flex max-w-40 min-w-0 shrink items-center @min-[561px]/page:w-[168px] @min-[561px]/page:max-w-none @min-[561px]/page:shrink-0 @min-[561px]/page:group-data-[hide~=format]/page:w-[140px] @min-[561px]/page:group-data-[hide~=narrower]/page:w-[116px] @min-[561px]/page:group-data-[hide~=narrowest]/page:w-[96px]",
  accept:
    "flex shrink-0 justify-end @min-[561px]/page:w-[84px] @min-[561px]/page:group-data-[hide~=narrowest]/page:w-7",
} as const;

export function moveFromReview(documentId: string, anchor: HTMLElement): void {
  useDocumentMove
    .getState()
    .show({ anchor, documentIds: documentsToMove(documentId), keepFocus: true });
}

export function ReviewFolder({
  doc,
  folder,
  onChange,
}: {
  doc: Document;
  folder: string;
  onChange(anchor: HTMLElement): void;
}) {
  const t = useT();
  const name = displayName(doc);
  return (
    <button
      type="button"
      data-testid="review-folder"
      aria-label={t("library.review.folder.label", { name, folder })}
      title={t("library.review.folder.title")}
      onClick={(event) => onChange(event.currentTarget)}
      className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] text-ink-secondary hover:bg-hover hover:text-ink focus-visible:outline-offset-0"
    >
      <ReviewRing />
      <span className="min-w-0 truncate">{folder}</span>
      <ChevronDownLineIcon className="size-3 shrink-0 text-ink-meta" />
    </button>
  );
}

export function ReviewAccept({ doc, folder }: { doc: Document; folder: string }) {
  const t = useT();
  const label = t("library.review.accept.label", { folder, name: displayName(doc) });
  return (
    <button
      type="button"
      data-testid="review-accept"
      aria-label={label}
      title={label}
      onClick={() => void acceptSuggestions([doc.id]).catch(reportError)}
      className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[13px] font-semibold text-ink-secondary hover:bg-hover hover:text-ink focus-visible:outline-offset-0"
    >
      <span className="inline-flex items-center gap-1.5 @min-[561px]/page:group-data-[hide~=narrowest]/page:hidden">
        {t("library.review.accept")}
        <kbd className="inline-flex h-[18px] items-center rounded-sm bg-chip px-[5px] font-sans text-[11px] font-semibold text-ink-secondary">
          ↵
        </kbd>
      </span>
      <CheckLineIcon className="hidden size-3.5 @min-[561px]/page:group-data-[hide~=narrowest]/page:block" />
    </button>
  );
}

export function SuggestedAccept({ doc, folder }: { doc: Document; folder: string }) {
  const t = useT();
  const label = t("library.review.accept.label", { folder, name: displayName(doc) });
  return (
    <button
      type="button"
      data-testid="library-accept-suggestion"
      aria-label={label}
      title={label}
      onClick={() => void acceptSuggestions([doc.id]).catch(reportError)}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-secondary opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100"
    >
      <CheckLineIcon className="size-3.5" />
    </button>
  );
}

function reportError(error: unknown): void {
  useAppStore.getState().reportError(error);
}
