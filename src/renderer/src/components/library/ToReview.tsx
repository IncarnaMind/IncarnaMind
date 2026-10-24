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

export function ToReview({
  review,
  suggestedIn,
}: {
  review: Review;
  suggestedIn(documentId: string): string | null;
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
  const summary = reviewSummary(review, t);
  const label = t("library.review.title");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of rows in the page's grid, under its head.
    <div
      ref={element}
      role="rowgroup"
      data-testid="library-review"
      data-review=""
      data-count={review.count}
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
        count={review.count}
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
    </div>
  );
}
