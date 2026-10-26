import type { Document } from "../../../../core/api";
import { menuKeysLabel } from "../../commands/keymap";
import { commands } from "../../commands/registry";
import { useLanguage, useT } from "../../i18n";
import { useLibraryFolds, useRevealed } from "../../libraryFolds";
import { FIRST_ROWS } from "../../libraryPage";
import { formatCount } from "../../linkedFolders";
import { lastOrganizeStep } from "../../organizeRun";
import { useAppStore } from "../../store";
import { type ToReview as Review, reviewSummary, TO_REVIEW } from "../../toReview";
import { foldKeys, TREE_ROW } from "../../treeKeys";
import { nextToUndo, useUndo } from "../../undo";
import { ReviewRing } from "../TagColour";
import { buttonStyle } from "../ui";
import { LibraryRow } from "./LibraryRow";
import { quietButtonClass } from "./LibrarySection";
import { SectionHead, sectionNameClass } from "./SectionHead";

const UNSORTED_KEY = `${TO_REVIEW}:not-sorted`;

export function ToReview({
  review,
  notSorted,
  suggestedIn,
  notSortedOf,
  sortFailedOf,
}: {
  review: Review;
  /** The Documents Organize couldn't sort, in the page's order. */
  notSorted: readonly Document[];
  suggestedIn(documentId: string): string | null;
  notSortedOf(documentId: string): string | null;
  sortFailedOf(documentId: string): string | null;
}) {
  const t = useT();
  const language = useLanguage();
  const open = useLibraryFolds((state) => state.reviewOpen);
  const showingAll = useLibraryFolds((state) => state.showingAll);
  const element = useRevealed<HTMLDivElement>(TO_REVIEW);
  const canUndoOrganize = useUndo((state) => {
    const step = lastOrganizeStep();
    return step !== null && nextToUndo(state) === step;
  });
  const acceptAll = commands.get("library.acceptSuggestions");
  const keys = acceptAll ? menuKeysLabel(acceptAll) : null;
  const toggle = () => useLibraryFolds.getState().setReviewOpen(!open);
  const summary = [
    review.count > 0 ? reviewSummary(review, t) : null,
    notSorted.length > 0
      ? t("library.notSorted.count", { count: formatCount(notSorted.length, language) })
      : null,
  ]
    .filter(Boolean)
    .join(t("library.review.separator"));
  const label = t("library.review.title");
  const unsorted = notSorted.length > 0;
  const shownAll = showingAll.has(UNSORTED_KEY);
  const unsortedListed = shownAll ? notSorted : notSorted.slice(0, FIRST_ROWS);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of rows in the page's grid, under its head.
    <div
      ref={element}
      role="rowgroup"
      data-testid="library-review"
      data-review=""
      data-count={review.count + notSorted.length}
      className="mt-2 mb-[18px]"
    >
      <SectionHead
        label={label}
        open={open}
        onToggle={toggle}
        icon={<ReviewRing />}
        name={
          <button
            type="button"
            {...TREE_ROW}
            data-testid="library-review-name"
            aria-expanded={open}
            onClick={toggle}
            onKeyDown={foldKeys(open, toggle)}
            className={`${sectionNameClass} shrink-0`}
          >
            {label}
          </button>
        }
        count={review.count + notSorted.length}
        testId="library-review-head"
        after={
          <span
            data-testid="library-review-summary"
            title={summary}
            className="min-w-0 truncate text-[13px] text-ink-secondary"
          >
            {summary}
          </span>
        }
        end={
          <span className="flex shrink-0 items-center gap-3">
            {canUndoOrganize && (
              <button
                type="button"
                data-testid="library-review-undo"
                title={t("menu.undo.named", { action: t("undo.name.organize") })}
                onClick={() => void useUndo.getState().undo()}
                className={quietButtonClass}
              >
                {t("library.review.undoOrganize")}
              </button>
            )}
            {review.count > 0 && (
              <button
                type="button"
                data-testid="library-review-accept-all"
                onClick={() =>
                  void commands
                    .run("library.acceptSuggestions", { surface: "library" })
                    .catch(useAppStore.getState().reportError)
                }
                className={buttonStyle("primary", "sm")}
              >
                {t("library.review.acceptAll")}
                {keys && (
                  <kbd className="rounded-sm bg-white/20 px-1 font-sans text-[11px] leading-4 @max-[680px]/page:hidden">
                    {keys}
                  </kbd>
                )}
              </button>
            )}
          </span>
        }
      />
      {open &&
        review.groups.map(({ folder, documents }) => {
          const all = showingAll.has(`${TO_REVIEW}:${folder.id}`);
          const listed = all ? documents : documents.slice(0, FIRST_ROWS);
          return (
            <div key={folder.id} data-testid="library-review-group" data-folder={folder.id}>
              <p className="flex h-8 items-end border-b border-rule pb-1 pl-14 text-[12px] leading-4 font-semibold text-ink-secondary">
                {t("library.review.group", {
                  folder: folder.name,
                  count: formatCount(documents.length, language),
                })}
              </p>
              {listed.map((doc) => (
                <LibraryRow
                  key={doc.id}
                  doc={doc}
                  review
                  suggestedIn={suggestedIn(doc.id)}
                  notSorted={null}
                  sortFailed={sortFailedOf(doc.id)}
                  match={null}
                  path={null}
                />
              ))}
              {listed.length < documents.length && (
                <div className="flex min-h-8 items-center border-b border-rule pl-14">
                  <button
                    type="button"
                    data-testid="library-review-show-all"
                    onClick={() => useLibraryFolds.getState().showAll(`${TO_REVIEW}:${folder.id}`)}
                    className={quietButtonClass}
                  >
                    {t("library.showAll", { count: formatCount(documents.length, language) })}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      {open && unsorted && (
        <div data-testid="library-review-unsorted" data-count={notSorted.length}>
          <p className="flex h-8 items-end border-b border-rule pb-1 pl-14 text-[12px] leading-4 font-semibold text-ink-secondary">
            {t("library.review.group", {
              folder: t("library.notSorted"),
              count: formatCount(notSorted.length, language),
            })}
          </p>
          {unsortedListed.map((doc) => (
            <LibraryRow
              key={doc.id}
              doc={doc}
              review
              suggestedIn={null}
              notSorted={notSortedOf(doc.id)}
              sortFailed={null}
              match={null}
              path={null}
            />
          ))}
          {unsortedListed.length < notSorted.length && (
            <div className="flex min-h-8 items-center border-b border-rule pl-14">
              <button
                type="button"
                data-testid="library-review-show-all-not-sorted"
                onClick={() => useLibraryFolds.getState().showAll(UNSORTED_KEY)}
                className={quietButtonClass}
              >
                {t("library.showAll", { count: formatCount(notSorted.length, language) })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
