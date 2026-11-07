import { useEffect, useMemo, useRef, useState } from "react";
import type { Document, LibraryGroup } from "../../../../core/api";
import { keysHere } from "../../commands/keymap";
import { useLanguage, useT } from "../../i18n";
import { formatCount } from "../../linkedFolders";
import {
  closeReview,
  confirmReview,
  discardReview,
  editReview,
  proposedHere,
  type Replan,
  replan,
  useOrganizeReview,
} from "../../organizeReview";
import {
  leftOutText,
  type ReviewCard,
  type ReviewLayout,
  reviewLayout,
  willMoveText,
} from "../../organizeReviewView";
import { sorted } from "../../sort";
import { sortOf, useSort } from "../../sortChoices";
import { folderFields } from "../../sortFields";
import { useAppStore } from "../../store";
import { typesText } from "../../undo";
import { MoreLineIcon } from "../lineIcons";
import { buttonStyle, iconButtonClass, menuClass, menuItemClass, menuRuleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";
import {
  type CardContext,
  LeftOutCard,
  newTagColours,
  OrganizeReviewCard,
  slideRows,
} from "./OrganizeReviewCards";

const NO_GROUPS: readonly LibraryGroup[] = [];
/** Fewer Folders and More Folders stay within these, as the plan does. */
const FEWEST = 3;
const MOST = 7;
const CONFIRM_KEYS = "CmdOrCtrl+Enter";

const report = (error: unknown) => useAppStore.getState().reportError(error);

/**
 * Suggestions (CONTEXT.md) filling the Library's page, as Drive's "Suggest file moves" does
 * (#1569): a bar pinned at the top with what Confirm will do, ⋯, Not Now and Confirm (⌘↩); then
 * the Library's Folders the Documents would go into, the new Folders, and what is left out. Every
 * box starts ticked; each change is one ⌘Z, and nothing moves before Confirm.
 */
export function OrganizeReviewPage() {
  const t = useT();
  const review = useOrganizeReview((state) => state.review);
  const groups = useAppStore((state) => state.library?.groups ?? NO_GROUPS);
  const assignments = useAppStore((state) => state.library?.assignments);
  const documents = useAppStore((state) => state.documents);
  const tags = useAppStore((state) => state.tags);
  const language = useLanguage();
  const sidebarSort = useSort(sortOf("sidebar"));
  const folders = useMemo(
    () => sorted(groups, sidebarSort, folderFields, language),
    [groups, sidebarSort, language],
  );
  const layout = useMemo(
    () => (review ? reviewLayout(review, folders, assignments ?? []) : null),
    [review, folders, assignments],
  );
  const byId = useMemo(
    () => new Map<string, Document>(documents.map((doc) => [doc.id, doc])),
    [documents],
  );
  const context = useMemo<CardContext | null>(
    () =>
      layout && review
        ? {
            documents: byId,
            tags,
            newColours: newTagColours(tags, review.items),
            cards: [...layout.yours, ...layout.proposed],
            folders,
            moveRows: (itemIds, to) =>
              slideRows(itemIds, () => {
                void editReview({ kind: "move", itemIds: [...itemIds], to }).catch(report);
              }),
          }
        : null,
    [layout, review, byId, tags, folders],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.defaultPrevented)
        return;
      if (event.shiftKey || event.altKey || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      const here = target?.closest('[data-testid="organize-review"]');
      if (!here && target !== document.body) return;
      if (target && typesText(target) && !here) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      void confirmReview().catch(report);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!layout || !context) {
    return (
      <p role="status" className="mt-6 text-[13px] text-ink-meta">
        {t("library.loading")}
      </p>
    );
  }
  const sub = layout.scope !== null;
  const folderName = (id: string) => groups.find((folder) => folder.id === id)?.name ?? "";
  const reasonOf = (item: (typeof layout.leftOut)[number]) =>
    item.placement.kind === "leftOut"
      ? leftOutText(
          item.placement.leftOut,
          folderName,
          layout.scope?.name ??
            folderName(
              (assignments ?? []).find((each) => each.documentId === item.documentId)?.groupId ??
                "",
            ),
          t,
        )
      : null;
  return (
    <div data-testid="organize-review" className="flex flex-col">
      <ReviewBar layout={layout} />
      <Section
        testId="organize-review-yours"
        label={t(sub ? "organizeReview.section.intoIts" : "organizeReview.section.intoYours")}
        cards={layout.yours}
        context={context}
      />
      <Section
        testId="organize-review-proposed"
        label={t(sub ? "organizeReview.section.newSubfolders" : "organizeReview.section.newFolders")}
        cards={layout.proposed}
        context={context}
      />
      {layout.leftOut.length > 0 && (
        <>
          <SectionHead
            label={t("organizeReview.section.leftOut")}
            count={layout.leftOut.length}
          />
          <LeftOutCard items={layout.leftOut} documents={byId} reasonOf={reasonOf} />
        </>
      )}
    </div>
  );
}

function SectionHead({ label, count }: { label: string; count: number }) {
  const language = useLanguage();
  return (
    <h2 className="mt-5 mb-2 text-[13px] leading-5 font-semibold text-ink-meta">
      {label}
      <span className="ml-1.5 font-normal tabular-nums">{formatCount(count, language)}</span>
    </h2>
  );
}

function Section({
  testId,
  label,
  cards,
  context,
}: {
  testId: string;
  label: string;
  cards: readonly ReviewCard[];
  context: CardContext;
}) {
  if (cards.length === 0) return null;
  return (
    <section data-testid={testId} aria-label={label}>
      <SectionHead label={label} count={cards.reduce((sum, card) => sum + card.items.length, 0)} />
      <div className="flex flex-col gap-3">
        {cards.map((card) => (
          <OrganizeReviewCard key={card.id} card={card} context={context} />
        ))}
      </div>
    </section>
  );
}

/**
 * The pinned bar: the title and what Confirm will do, following the ticks, then ⋯, Not Now and
 * Confirm. A hairline shows once the cards scroll under it.
 */
function ReviewBar({ layout }: { layout: ReviewLayout }) {
  const t = useT();
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) =>
      setStuck(entry ? !entry.isIntersecting : false),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const willMove = willMoveText(layout, t);
  const nothing = layout.yours.concat(layout.proposed).every((card) =>
    card.items.every((item) => !item.ticked),
  );
  return (
    <>
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      <div
        data-testid="organize-review-bar"
        data-stuck={stuck ? "true" : undefined}
        className={`sticky top-0 z-10 -mx-8 flex flex-wrap items-start gap-x-4 gap-y-2 bg-sheet px-8 pt-6 pb-3 @max-[680px]/page:-mx-4 @max-[680px]/page:px-4 ${
          stuck ? "shadow-[0_1px_0_var(--color-rule)]" : ""
        }`}
      >
        <div className="min-w-[min(100%,240px)] flex-1">
          <h1
            data-testid="organize-review-title"
            className="m-0 text-[20px] leading-7 font-semibold text-ink"
          >
            {layout.scope
              ? t("organizeReview.title.sub", { folder: layout.scope.name })
              : t("organizeReview.title")}
          </h1>
          <p
            id="organize-review-will-move"
            data-testid="organize-review-will-move"
            className="m-0 mt-0.5 text-[13px] leading-5 text-ink-meta"
          >
            {willMove}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ReviewMenu scoped={layout.scope !== null} />
          <button
            type="button"
            data-testid="organize-review-not-now"
            onClick={closeReview}
            className={buttonStyle("ghost")}
          >
            {t("organizeReview.notNow")}
          </button>
          <button
            type="button"
            data-testid="organize-review-confirm"
            aria-describedby="organize-review-will-move"
            disabled={nothing}
            onClick={() => void confirmReview().catch(report)}
            className={buttonStyle("primary")}
          >
            {t("organizeReview.confirm")}
            <kbd className="font-sans text-[12px] font-medium opacity-70">
              {keysHere(CONFIRM_KEYS)}
            </kbd>
          </button>
        </div>
      </div>
    </>
  );
}

/** The Review's ⋯: Fewer Folders, More Folders and Try Again, then Discard (with Undo). */
function ReviewMenu({ scoped }: { scoped: boolean }) {
  const t = useT();
  const menu = usePopoverMenu({ align: "end", focus: "first" });
  const review = useOrganizeReview((state) => state.review);
  const count = review && menu.open ? proposedHere(review) : 0;
  const choose = (kind: Replan) => {
    menu.close();
    void replan(kind).catch(report);
  };
  const item = (
    kind: Replan,
    label: string,
    unavailable: string | null,
    testId: string,
  ) => (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      aria-disabled={unavailable !== null || undefined}
      title={unavailable ?? undefined}
      onClick={() => {
        if (unavailable === null) choose(kind);
      }}
      className={`${menuItemClass} pl-2 aria-disabled:cursor-default aria-disabled:text-ink-placeholder aria-disabled:hover:bg-transparent`}
    >
      {label}
    </button>
  );
  return (
    <>
      <button
        type="button"
        {...menu.buttonProps}
        data-testid="organize-review-menu"
        aria-label={t("organizeReview.menu")}
        title={t("organizeReview.menu")}
        className={iconButtonClass}
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("organizeReview.menu")}
        data-testid="organize-review-menu-items"
        className={menuClass}
      >
        {menu.open && (
          <>
            {!scoped &&
              item(
                "fewer",
                t("organizeReview.fewer"),
                count <= FEWEST ? t("organizeReview.fewer.fewest", { count: FEWEST }) : null,
                "organize-review-fewer",
              )}
            {!scoped &&
              item(
                "more",
                t("organizeReview.more"),
                count >= MOST ? t("organizeReview.more.most", { count: MOST }) : null,
                "organize-review-more",
              )}
            {item("again", t("organizeReview.again"), null, "organize-review-again")}
            <div className={menuRuleClass} />
            <button
              type="button"
              role="menuitem"
              data-testid="organize-review-discard"
              onClick={() => {
                menu.close();
                void discardReview().catch(report);
              }}
              className={`${menuItemClass} pl-2`}
            >
              {t("organizeReview.discard")}
            </button>
          </>
        )}
      </div>
    </>
  );
}
