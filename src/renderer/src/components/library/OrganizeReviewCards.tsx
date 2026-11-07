import { useEffect, useId, useRef, useState } from "react";
import type {
  Document,
  LibraryGroup,
  OrganizeReviewItem,
  OrganizeReviewTag,
  OrganizeReviewTarget,
  Tag,
} from "../../../../core/api";
import { nextTagColour, type TagColour } from "../../../../shared/tagColours";
import { useDragSource, useDropTarget } from "../../dragDrop";
import { useLanguage, useT } from "../../i18n";
import { formatCount } from "../../linkedFolders";
import { move } from "../../motion";
import { nameKeyAction } from "../../nameKeys";
import { editReview, showAllRows, useOrganizeReview } from "../../organizeReview";
import { CARD_ROWS, cardPath, type ReviewCard } from "../../organizeReviewView";
import { peekRowProps, togglePeek } from "../../peek";
import { useAppStore } from "../../store";
import { useRename } from "../../useRename";
import { InlineName } from "../InlineName";
import {
  CloseLineIcon,
  DocumentLineIcon,
  FolderLineIcon,
  MoreLineIcon,
  PlusLineIcon,
} from "../lineIcons";
import { rowInputClass } from "../sidebarRows";
import { tagChipColour } from "../TagColour";
import { chipClass } from "../TagPicker";
import { iconButtonClass, menuClass, menuItemClass, menuRuleClass, menuTitleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";
import { quietButtonClass } from "./LibrarySection";

/** A new Tag reads as new: outlined in the colour it will get, with its text and no fill. */
const OUTLINE: Record<TagColour, string> = {
  red: "text-tag-red-ink ring-tag-red-edge",
  orange: "text-tag-orange-ink ring-tag-orange-edge",
  yellow: "text-tag-yellow-ink ring-tag-yellow-edge",
  green: "text-tag-green-ink ring-tag-green-edge",
  teal: "text-tag-teal-ink ring-tag-teal-edge",
  blue: "text-tag-blue-ink ring-tag-blue-edge",
  purple: "text-tag-purple-ink ring-tag-purple-edge",
  gray: "text-tag-gray-ink ring-tag-gray-edge",
};

/** A row's controls show on hover and keyboard focus, as Finder's and Mail's do. */
const onHover =
  "invisible group-hover/review-row:visible group-focus-within/review-row:visible aria-expanded:visible";

/** The colour each new Tag will get, in the order the Review shows them: the one fewest Tags have. */
export function newTagColours(
  tags: readonly Pick<Tag, "colour">[],
  items: readonly OrganizeReviewItem[],
): Map<string, TagColour> {
  const used: string[] = tags.map((tag) => tag.colour);
  const colours = new Map<string, TagColour>();
  for (const item of items) {
    for (const tag of item.tags) {
      const key = tag.name.toLocaleLowerCase();
      if (tag.tagId !== null || colours.has(key)) continue;
      const colour = nextTagColour(used);
      colours.set(key, colour);
      used.push(colour);
    }
  }
  return colours;
}

export interface CardContext {
  documents: ReadonlyMap<string, Document>;
  tags: readonly Tag[];
  newColours: ReadonlyMap<string, TagColour>;
  /** Every card in the Review, to Move to or Merge into. */
  cards: readonly ReviewCard[];
  /** The Library's Folders, in the sidebar's order, for Move to. */
  folders: readonly LibraryGroup[];
  /** Moves rows to another card, sliding them there. */
  moveRows(itemIds: readonly string[], to: Exclude<OrganizeReviewTarget, { kind: "leftOut" }>): void;
}

const report = (error: unknown) => useAppStore.getState().reportError(error);

/**
 * One Folder of the Review: its tick for every row, shown or not, the Folder's name (a new one's
 * renamed in place, a subfolder's headed by its path) and count, then its Documents, the first
 * eight and "Show all {n}".
 */
export function OrganizeReviewCard({ card, context }: { card: ReviewCard; context: CardContext }) {
  const t = useT();
  const language = useLanguage();
  const shownAll = useOrganizeReview((state) => state.shownAll.has(card.id));
  const box = useRef<HTMLInputElement>(null);
  const all = card.items.length > 0 && card.items.every((item) => item.ticked);
  const some = card.items.some((item) => item.ticked);
  useEffect(() => {
    if (box.current) box.current.indeterminate = some && !all;
  }, [some, all]);
  const path = cardPath(card);
  const rename = useRename<HTMLButtonElement>(`organize-review-folder:${card.id}`);
  const ids = new Set(card.items.map((item) => item.documentId));
  const drop = useDropTarget(`organize-review:${card.id}`, {
    accepts: (dragged) => {
      if (dragged.kind !== "objects") return null;
      const { review } = useOrganizeReview.getState();
      const waiting = new Set(review?.items.map((item) => item.documentId));
      const ok =
        dragged.refs.length > 0 &&
        dragged.refs.every(
          (ref) => ref.kind === "document" && waiting.has(ref.id) && !ids.has(ref.id),
        );
      return ok ? { kind: "move", said: (t) => t("organizeReview.dropInto", { folder: path }) } : null;
    },
    drop: (dropped) => {
      if (dropped.kind !== "objects") return null;
      const { review } = useOrganizeReview.getState();
      const moving = new Set(dropped.refs.map((ref) => ref.id));
      context.moveRows(
        (review?.items ?? []).filter((item) => moving.has(item.documentId)).map((item) => item.id),
        card.target,
      );
      return null;
    },
  });
  const rows = shownAll ? card.items : card.items.slice(0, CARD_ROWS);
  return (
    <section
      aria-label={path}
      data-testid="organize-review-card"
      data-card-id={card.id}
      data-proposed={card.proposed ? "" : undefined}
      {...drop.props}
      className={`overflow-hidden rounded-xl border bg-sheet ${
        drop.over ? "border-accent ring-1 ring-accent" : "border-rule"
      }`}
    >
      <div className="group/review-row flex min-h-12 items-center gap-2.5 py-2 pr-2.5 pl-3.5">
        {card.items.length > 0 && (
          <input
            ref={box}
            type="checkbox"
            data-testid="organize-review-card-tick"
            aria-label={path}
            checked={all}
            onChange={() =>
              void editReview({
                kind: "tick",
                itemIds: card.items.map((item) => item.id),
                ticked: !all,
              }).catch(report)
            }
            className="m-0 size-4 shrink-0 accent-accent"
          />
        )}
        <FolderLineIcon aria-hidden="true" className="size-[18px] shrink-0 text-ink-secondary" />
        {rename.renaming ? (
          <InlineName
            value={card.name}
            label={t("organizeReview.renameLabel", { name: card.name })}
            testId="organize-review-rename"
            className={`${rowInputClass} h-7 max-w-80 text-[15px] font-semibold`}
            {...rename.field((name) =>
              editReview({ kind: "renameFolder", newFolderId: card.id, name }),
            )}
          />
        ) : (
          <h3 className="m-0 min-w-0 truncate text-[15px] leading-5 font-semibold text-ink">
            {card.proposed ? (
              <button
                type="button"
                {...rename.nameProps}
                data-testid="organize-review-card-name"
                title={t("organizeReview.rename")}
                onClick={rename.start}
                className="-ml-1.5 max-w-full truncate rounded-md px-1.5 py-0.5 text-left hover:bg-hover"
              >
                <CardName card={card} />
              </button>
            ) : (
              <span data-testid="organize-review-card-name" title={path}>
                <CardName card={card} />
              </span>
            )}
          </h3>
        )}
        <span className="shrink-0 text-[13px] tabular-nums text-ink-meta">
          {formatCount(card.items.length, language)}
        </span>
        <span className="min-w-0 flex-1" />
        {card.proposed && !rename.renaming && (
          <CardMenu card={card} context={context} onRename={rename.start} />
        )}
      </div>
      {rows.map((item) => (
        <OrganizeReviewRow key={item.id} item={item} context={context} card={card} />
      ))}
      {rows.length < card.items.length && (
        <div className="flex min-h-11 items-center border-t border-rule pl-[42px]">
          <button
            type="button"
            data-testid="organize-review-show-all"
            onClick={() => showAllRows(card.id)}
            className={quietButtonClass}
          >
            {t("library.showAll", { count: formatCount(card.items.length, language) })}
          </button>
        </div>
      )}
    </section>
  );
}

function CardName({ card }: { card: ReviewCard }) {
  return (
    <>
      {card.parentPath !== null && <span className="text-ink-meta">{card.parentPath} › </span>}
      {card.name}
    </>
  );
}

/** A new Folder's ⋯: Rename, then Merge into one of the Review's other Folders. */
function CardMenu({
  card,
  context,
  onRename,
}: {
  card: ReviewCard;
  context: CardContext;
  onRename(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const menu = usePopoverMenu({ align: "end", focus: "first" });
  const others = context.cards.filter((each) => each.id !== card.id && each.items.length > 0);
  return (
    <>
      <button
        type="button"
        {...menu.buttonProps}
        data-testid="organize-review-card-menu"
        aria-label={t("organizeReview.folderActions", { name: card.name })}
        title={t("organizeReview.folderActions", { name: card.name })}
        className={`${iconButtonClass} ${onHover}`}
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("organizeReview.folderActions", { name: card.name })}
        data-testid="organize-review-card-menu-items"
        className={menuClass}
      >
        {menu.open && (
          <>
            <button
              type="button"
              role="menuitem"
              data-testid="organize-review-card-rename"
              onClick={() => {
                menu.close();
                onRename();
              }}
              className={`${menuItemClass} pl-2`}
            >
              {t("organizeReview.rename")}
            </button>
            {others.length > 0 && (
              <>
                <div className={menuRuleClass} />
                <p className={menuTitleClass}>{t("organizeReview.mergeInto")}</p>
                {others.map((other) => (
                  <button
                    key={other.id}
                    type="button"
                    role="menuitem"
                    data-testid="organize-review-merge-into"
                    onClick={() => {
                      menu.close();
                      void editReview({
                        kind: "mergeFolder",
                        newFolderId: card.id,
                        into: other.target,
                      }).catch(report);
                    }}
                    className={`${menuItemClass} pl-2`}
                  >
                    <span className="min-w-0 flex-1 truncate">{cardPath(other)}</span>
                    <span className="shrink-0 tabular-nums text-ink-meta">
                      {formatCount(other.items.length, language)}
                    </span>
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * A Document waiting in a card: its tick, icon and name, and the Tags it would get. Its + and ⋯
 * (Move to…) and a chip's × show on hover and focus. Space on its name, or a click, peeks at it.
 */
function OrganizeReviewRow({
  item,
  card,
  context,
}: {
  item: OrganizeReviewItem;
  card: ReviewCard;
  context: CardContext;
}) {
  const doc = context.documents.get(item.documentId);
  const name = doc?.name ?? "";
  const drag = useDragSource(() =>
    doc ? { refs: [{ kind: "document", id: doc.id }], name: doc.name } : null,
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Space on the row's name peeks, as in the Library.
    <div
      data-testid="organize-review-row"
      data-review-item={item.id}
      data-select-ref={`document:${item.documentId}`}
      data-ticked={item.ticked ? "true" : "false"}
      {...drag}
      {...peekRowProps(item.documentId, "library")}
      className="group/review-row flex min-h-11 items-center gap-2.5 border-t border-rule pr-2.5 pl-3.5"
    >
      <input
        type="checkbox"
        data-testid="organize-review-tick"
        aria-label={name}
        checked={item.ticked}
        onChange={() =>
          void editReview({ kind: "tick", itemIds: [item.id], ticked: !item.ticked }).catch(report)
        }
        className="m-0 size-4 shrink-0 accent-accent"
      />
      {doc && <DocumentLineIcon kind={doc.kind} className="size-4 shrink-0 text-ink-meta" />}
      <button
        type="button"
        data-row-main
        data-testid="organize-review-name"
        title={name}
        onClick={(event) =>
          togglePeek({
            documentId: item.documentId,
            surface: "library",
            row: event.currentTarget.closest<HTMLElement>("[data-review-item]") ?? event.currentTarget,
          })
        }
        className={`min-w-0 flex-1 truncate rounded-sm py-1.5 text-left text-ui ${
          item.ticked ? "text-ink" : "text-ink-meta"
        }`}
      >
        {name}
      </button>
      <RowChips item={item} context={context} name={name} />
      <RowMenu item={item} card={card} context={context} name={name} />
    </div>
  );
}

/** The Tags a row would get, each in its own colour, a new one outlined; + adds one. */
function RowChips({
  item,
  context,
  name,
}: {
  item: OrganizeReviewItem;
  context: CardContext;
  name: string;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const list = useId();
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 @max-[680px]/page:[&>[data-tag-chip]:not(:first-child)]:hidden ${
        item.ticked ? "" : "opacity-45"
      }`}
    >
      {item.tags.map((tag) => (
        <ReviewChip key={tag.id} item={item} tag={tag} context={context} />
      ))}
      {adding ? (
        <>
          <input
            // biome-ignore lint/a11y/noAutofocus: the field opens where + was pressed, to type into.
            autoFocus
            list={list}
            data-testid="organize-review-add-tag-field"
            aria-label={t("organizeReview.addTagTo", { name })}
            placeholder={t("organizeReview.addTag")}
            onKeyDown={(event) => {
              const action = nameKeyAction({
                key: event.key,
                keyCode: event.keyCode,
                isComposing: event.nativeEvent.isComposing,
              });
              if (!action) return;
              event.preventDefault();
              event.stopPropagation();
              if (action === "save") addTag(item, event.currentTarget.value, context.tags);
              setAdding(false);
            }}
            onBlur={(event) => {
              addTag(item, event.currentTarget.value, context.tags);
              setAdding(false);
            }}
            className={`${rowInputClass} w-32 text-[12px]`}
          />
          <datalist id={list}>
            {context.tags.map((tag) => (
              <option key={tag.id} value={tag.name} />
            ))}
          </datalist>
        </>
      ) : (
        <button
          type="button"
          data-testid="organize-review-add-tag"
          aria-label={t("organizeReview.addTagTo", { name })}
          title={t("organizeReview.addTag")}
          onClick={() => setAdding(true)}
          className={`inline-flex size-6 items-center justify-center rounded-md text-ink-meta hover:bg-hover hover:text-ink ${onHover}`}
        >
          <PlusLineIcon className="size-3" />
        </button>
      )}
    </span>
  );
}

function addTag(item: OrganizeReviewItem, typed: string, tags: readonly Tag[]): void {
  const name = typed.trim();
  if (name === "") return;
  const known = tags.find((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  void editReview({
    kind: "addTag",
    itemId: item.id,
    tag: known ? { tagId: known.id } : { name },
  }).catch(report);
}

function ReviewChip({
  item,
  tag,
  context,
}: {
  item: OrganizeReviewItem;
  tag: OrganizeReviewTag;
  context: CardContext;
}) {
  const t = useT();
  const live = tag.tagId === null ? undefined : context.tags.find((each) => each.id === tag.tagId);
  const colour = live
    ? tagChipColour(live.colour)
    : `bg-transparent ring-1 ring-inset ${OUTLINE[context.newColours.get(tag.name.toLocaleLowerCase()) ?? "gray"]}`;
  return (
    <span
      data-tag-chip=""
      data-testid="organize-review-chip"
      data-new={live ? undefined : "true"}
      title={live ? tag.name : t("organizeReview.newTag", { tag: tag.name })}
      className={`${chipClass} ${colour} pr-1.5 group-hover/review-row:pr-0.5 group-focus-within/review-row:pr-0.5`}
    >
      <span className="min-w-0 truncate">{tag.name}</span>
      <button
        type="button"
        data-testid="organize-review-remove-tag"
        aria-label={t("organizeReview.removeTag", { tag: tag.name })}
        onClick={() =>
          void editReview({ kind: "removeTag", itemId: item.id, tagRowId: tag.id }).catch(report)
        }
        className="hidden size-4 items-center justify-center rounded-sm opacity-70 group-hover/review-row:inline-flex group-focus-within/review-row:inline-flex hover:bg-sheet/60 hover:opacity-100"
      >
        <CloseLineIcon className="size-2.5" />
      </button>
    </span>
  );
}

/** A row's ⋯: Move to… another Folder in the Review, or any of the Library's. */
function RowMenu({
  item,
  card,
  context,
  name,
}: {
  item: OrganizeReviewItem;
  card: ReviewCard;
  context: CardContext;
  name: string;
}) {
  const t = useT();
  const language = useLanguage();
  const menu = usePopoverMenu({ align: "end", focus: "first" });
  const inReview = context.cards.filter((each) => each.id !== card.id);
  const carded = new Set(context.cards.map((each) => each.id));
  const yours = context.folders.filter((folder) => !carded.has(folder.id));
  const moveTo = (to: Exclude<OrganizeReviewTarget, { kind: "leftOut" }>) => {
    menu.close();
    context.moveRows([item.id], to);
  };
  return (
    <>
      <button
        type="button"
        {...menu.buttonProps}
        data-testid="organize-review-row-menu"
        aria-label={t("organizeReview.rowActions", { name })}
        title={t("organizeReview.rowActions", { name })}
        className={`${iconButtonClass} ${onHover}`}
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("organizeReview.moveTo")}
        data-testid="organize-review-move-to"
        className={menuClass}
      >
        {menu.open && (
          <>
            <p className={menuTitleClass}>{t("organizeReview.moveTo")}</p>
            {inReview.length > 0 && (
              <p className={`${menuTitleClass} font-normal`}>{t("organizeReview.moveTo.inReview")}</p>
            )}
            {inReview.map((each) => (
              <button
                key={each.id}
                type="button"
                role="menuitem"
                data-testid="organize-review-move-to-card"
                onClick={() => moveTo(each.target)}
                className={`${menuItemClass} pl-2`}
              >
                <span className="min-w-0 flex-1 truncate">{cardPath(each)}</span>
                <span className="shrink-0 tabular-nums text-ink-meta">
                  {formatCount(each.items.length, language)}
                </span>
              </button>
            ))}
            {yours.length > 0 && (
              <p className={`${menuTitleClass} font-normal`}>{t("organizeReview.moveTo.yours")}</p>
            )}
            {yours.map((folder) => (
              <button
                key={folder.id}
                type="button"
                role="menuitem"
                data-testid="organize-review-move-to-folder"
                onClick={() => moveTo({ kind: "folder", folderId: folder.id })}
                className={`${menuItemClass} pl-2`}
              >
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </>
  );
}

/** What is left out: no tick, each Document with its reason; it stays where it is. */
export function LeftOutCard({
  items,
  documents,
  reasonOf,
}: {
  items: readonly OrganizeReviewItem[];
  documents: ReadonlyMap<string, Document>;
  reasonOf(item: OrganizeReviewItem): string | null;
}) {
  const t = useT();
  return (
    <section
      aria-label={t("organizeReview.section.leftOut")}
      data-testid="organize-review-left-out"
      className="overflow-hidden rounded-xl border border-rule bg-sheet"
    >
      {items.map((item, at) => {
        const doc = documents.get(item.documentId);
        const reason = reasonOf(item);
        return (
          <div
            key={item.id}
            data-testid="organize-review-left-out-row"
            data-select-ref={`document:${item.documentId}`}
            {...peekRowProps(item.documentId, "library")}
            className={`flex min-h-11 items-center gap-2.5 pr-2.5 pl-[42px] ${
              at === 0 ? "" : "border-t border-rule"
            }`}
          >
            {doc && <DocumentLineIcon kind={doc.kind} className="size-4 shrink-0 text-ink-meta" />}
            <button
              type="button"
              data-row-main
              title={doc?.name}
              onClick={(event) =>
                togglePeek({
                  documentId: item.documentId,
                  surface: "library",
                  row:
                    event.currentTarget.closest<HTMLElement>("[data-select-ref]") ??
                    event.currentTarget,
                })
              }
              className="flex min-w-0 flex-1 flex-col py-1.5 text-left"
            >
              <span className="truncate text-ui text-ink">{doc?.name}</span>
              {reason && (
                <span data-testid="organize-review-reason" className="text-[13px] leading-5 text-ink-meta">
                  {reason}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </section>
  );
}

/** Measures the rows before they move, and slides each from there once it is drawn in its new card. */
export function slideRows(itemIds: readonly string[], change: () => void): void {
  const before = new Map<string, DOMRect>();
  for (const id of itemIds) {
    const row = document.querySelector<HTMLElement>(`[data-review-item="${CSS.escape(id)}"]`);
    if (row) before.set(id, row.getBoundingClientRect());
  }
  change();
  requestAnimationFrame(() => {
    for (const [id, from] of before) {
      const row = document.querySelector<HTMLElement>(`[data-review-item="${CSS.escape(id)}"]`);
      if (row) move(row, from, row.getBoundingClientRect());
    }
  });
}
