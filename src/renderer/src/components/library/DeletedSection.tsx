import { useEffect } from "react";
import type { DeletedItem } from "../../../../core/api";
import { daysLeft, whenDeleted } from "../../deletedItems";
import { useLanguage, useT } from "../../i18n";
import { useLibraryFolds, useRevealed } from "../../libraryFolds";
import { RECENTLY_DELETED } from "../../libraryPage";
import { formatCount } from "../../linkedFolders";
import { deletedName, restoreItems, useDeleted, watchDeleted } from "../../recentlyDeleted";
import { useRequests } from "../../requests";
import { useSelectable, useSelectedOn, useSelection, useSelectionOrder } from "../../selection";
import { useAppStore } from "../../store";
import { TREE_ROW } from "../../treeKeys";
import {
  ConversationLineIcon,
  DocumentLineIcon,
  FolderLineIcon,
  MindLineIcon,
  TagLineIcon,
  TrashLineIcon,
} from "../lineIcons";
import { ObjectMenu, useObjectMenu } from "../ObjectMenu";
import { rowActionButtonClass } from "../sidebarRows";
import { buttonStyle } from "../ui";
import { pageRowClass } from "./LibraryRow";
import { quietButtonClass } from "./LibrarySection";
import { SectionHead, sectionNameClass } from "./SectionHead";

const iconClass = "size-4 shrink-0 text-ink-meta";
const boxClass = "size-4 shrink-0 cursor-pointer accent-accent";

function KindIcon({ item }: { item: DeletedItem }) {
  if (item.kind === "document") {
    return <DocumentLineIcon kind={item.documentKind ?? "text"} className={iconClass} />;
  }
  const Icon = {
    mind: MindLineIcon,
    conversation: ConversationLineIcon,
    folder: FolderLineIcon,
    tag: TagLineIcon,
  }[item.kind];
  return <Icon className={iconClass} />;
}

/**
 * Recently deleted (CONTEXT.md), folded at the foot of the Library page: each
 * deleted Mind, conversation, Document, Folder and Tag of the last 30 days,
 * newest first, with where it was, when it was deleted and the days left.
 * Restore and Delete Permanently work on a row, on a selection (its own, as
 * Finder's Trash is a window of its own) and from a row's menu. Shown while
 * something waits in it.
 */
export function DeletedSection() {
  const t = useT();
  const language = useLanguage();
  const items = useDeleted((state) => state.items);
  const groups = useAppStore((state) => state.library?.groups);
  const held = useSelectedOn("deleted");
  const open = useLibraryFolds((state) => !state.folded.has(RECENTLY_DELETED));
  const element = useRevealed<HTMLElement>(RECENTLY_DELETED, (items?.length ?? 0) > 0);

  useEffect(() => {
    const report = useAppStore.getState().reportError;
    const reload = () => void useDeleted.getState().refresh().catch(report);
    reload();
    return watchDeleted(reload);
  }, []);
  // Asked for before the list was read, and nothing is there: nothing to bring into view.
  useEffect(() => {
    const folds = useLibraryFolds.getState();
    if (items?.length === 0 && folds.revealing === RECENTLY_DELETED) folds.revealed();
  }, [items]);
  // The selection keeps only what is still listed.
  useEffect(() => {
    if (!items) return;
    const listed = new Set(items.map((item) => item.id));
    useSelection.getState().keepOnly((ref) => ref.kind !== "deleted" || listed.has(ref.id));
  }, [items]);

  const rows = items ?? [];
  useSelectionOrder("deleted", () =>
    open ? rows.map((item) => ({ kind: "deleted", id: item.id })) : [],
  );
  if (rows.length === 0) return null;
  const heldIds = new Set(held.map((ref) => ref.id));
  const chosen = rows.filter((item) => heldIds.has(item.id));
  const chosenCount = formatCount(chosen.length, language);
  const now = new Date();
  const label = t("deleted.title");
  const toggle = () => useLibraryFolds.getState().toggle(RECENTLY_DELETED);

  const wasIn = (item: DeletedItem): string => {
    if (item.kind === "folder") return t("deleted.wasIn.library");
    if (item.kind === "tag") return t("deleted.wasIn.tags");
    // A Folder deleted too is still where it was, until it is deleted permanently.
    const folder =
      groups?.find((group) => group.id === item.groupId) ??
      rows.find((each) => each.kind === "folder" && each.id === item.groupId);
    if (folder) return folder.name;
    return t(item.kind === "conversation" ? "deleted.wasIn.chats" : "deleted.wasIn.none");
  };

  const deletePermanently = (these: readonly DeletedItem[]) =>
    useRequests.getState().ask({ deletePermanently: { items: these, empty: false } });
  const report = useAppStore.getState().reportError;
  const restore = (these: readonly DeletedItem[]) => void restoreItems(these).catch(report);

  return (
    <section
      ref={element}
      data-testid="recently-deleted"
      data-surface="deleted"
      aria-label={label}
      className="mt-8"
    >
      <SectionHead
        label={label}
        open={open}
        onToggle={toggle}
        icon={<TrashLineIcon className="size-4" />}
        name={
          <button
            type="button"
            {...TREE_ROW}
            data-testid="deleted-heading"
            aria-expanded={open}
            onClick={toggle}
            onKeyDown={(event) => {
              if ((event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open)) {
                event.preventDefault();
                toggle();
              }
            }}
            className={`${sectionNameClass} text-ink-secondary`}
          >
            {label}
          </button>
        }
        count={rows.length}
        tip={t("deleted.intro")}
        testId="deleted-section-head"
        end={
          open && (
            <button
              type="button"
              data-testid="deleted-empty"
              onClick={() =>
                useRequests.getState().ask({ deletePermanently: { items: rows, empty: true } })
              }
              className={quietButtonClass}
            >
              {t("deleted.emptyAction")}
            </button>
          )
        }
      />
      {open && (
        <>
          {chosen.length > 0 && (
            <div
              role="toolbar"
              aria-label={t("deleted.selected", { count: chosenCount })}
              data-testid="deleted-selection"
              onKeyDown={(event) => {
                if (event.key === "Escape") useSelection.getState().clear("deleted");
              }}
              className="sticky top-0 z-10 mb-1 flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-frame px-2 py-1 text-[13px]"
            >
              <input
                type="checkbox"
                data-testid="deleted-select-all"
                aria-label={t("deleted.selectAll", { count: formatCount(rows.length, language) })}
                checked={chosen.length === rows.length}
                ref={(box) => {
                  if (box) box.indeterminate = chosen.length < rows.length;
                }}
                onChange={() =>
                  chosen.length === rows.length
                    ? useSelection.getState().clear("deleted")
                    : useSelection.getState().all("deleted")
                }
                className={boxClass}
              />
              <span role="status" className="font-semibold text-ink">
                {t("deleted.selected", { count: chosenCount })}
              </span>
              <button
                type="button"
                data-testid="deleted-restore-selected"
                className={buttonStyle("secondary", "sm")}
                onClick={() => restore(chosen)}
              >
                {t(chosen.length > 1 ? "deleted.restore.count" : "deleted.restore", {
                  count: chosenCount,
                })}
              </button>
              <button
                type="button"
                data-testid="deleted-delete-selected"
                className={buttonStyle("secondary", "sm")}
                onClick={() => deletePermanently(chosen)}
              >
                {t(
                  chosen.length > 1
                    ? "deleted.deletePermanently.count"
                    : "deleted.deletePermanently",
                  { count: chosenCount },
                )}
              </button>
              <button
                type="button"
                data-testid="deleted-clear"
                className={`${buttonStyle("ghost", "sm")} ml-auto`}
                onClick={() => useSelection.getState().clear("deleted")}
              >
                {t("deleted.clear")}
              </button>
            </div>
          )}
          {/* biome-ignore lint/a11y/useSemanticElements: rows of columns that select, not a table. */}
          <div role="grid" aria-multiselectable="true" aria-label={t("deleted.list")}>
            {rows.map((item) => (
              <DeletedRow
                key={item.id}
                item={item}
                wasIn={wasIn(item)}
                when={whenDeleted(item, now, language, t)}
                left={daysLeft(item, now)}
                selecting={chosen.length > 0}
                onRestore={restore}
                onDelete={deletePermanently}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function DeletedRow({
  item,
  wasIn,
  when,
  left,
  selecting,
  onRestore,
  onDelete,
}: {
  item: DeletedItem;
  wasIn: string;
  when: string;
  left: number;
  selecting: boolean;
  onRestore(items: readonly DeletedItem[]): void;
  onDelete(items: readonly DeletedItem[]): void;
}) {
  const t = useT();
  const name = deletedName(item);
  const target = { kind: "deleted", id: item.id } as const;
  const objectMenu = useObjectMenu(target);
  // A click on the row selects just it; there is nothing to open.
  const select = useSelectable(target, "deleted", () => undefined);
  const selected = select.selected;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the checkbox is the keyboard's way to select the row.
    // biome-ignore lint/a11y/useSemanticElements: the row is laid out as columns, not as a table row.
    // biome-ignore lint/a11y/useFocusableInteractive: the row's buttons and checkbox take the focus.
    <div
      role="row"
      {...select.rowProps}
      data-testid="deleted-item"
      data-kind={item.kind}
      data-deleted-id={item.id}
      data-selected={selected ? "" : undefined}
      {...objectMenu.rowProps}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button, input, [role=menu]"))
          return;
        select.onClick(event);
      }}
      className={pageRowClass(selected)}
    >
      <input
        type="checkbox"
        data-testid="deleted-select"
        aria-label={t("deleted.select", { name })}
        checked={selected}
        onChange={(event) => {
          const { toggle, extendTo } = useSelection.getState();
          if ((event.nativeEvent as MouseEvent).shiftKey) extendTo("deleted", target);
          else toggle("deleted", target);
        }}
        className={`${boxClass} absolute top-3 -left-7 ${
          selected || selecting
            ? ""
            : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
        }`}
      />
      <div className="flex min-h-[39px] flex-wrap items-center gap-x-3 gap-y-1 py-1 pr-1.5 pl-3">
        <span className="flex min-w-0 flex-[1_1_216px] items-center gap-2">
          <span aria-hidden="true" className="w-3 shrink-0" />
          <KindIcon item={item} />
          <span
            data-testid="deleted-name"
            title={name}
            className="min-w-0 truncate text-ui text-ink"
          >
            {name}
          </span>
          <span className="sr-only">{t(`deleted.kind.${item.kind}`)}</span>
        </span>
        <span
          data-testid="deleted-was-in"
          className="w-[150px] shrink-0 truncate text-[13px] text-ink-secondary @max-[624px]/page:hidden"
        >
          {wasIn}
        </span>
        <span className="flex w-[170px] shrink-0 items-baseline gap-1 text-[13px] whitespace-nowrap text-ink-secondary @max-[512px]/page:hidden">
          <span data-testid="deleted-when" className="truncate">
            {when}
          </span>
          <span aria-hidden="true">·</span>
          <span data-testid="deleted-left" className="tabular-nums">
            {t(left === 1 ? "deleted.days.one" : "deleted.days", { count: left })}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center justify-end gap-1">
          {!selected && (
            <span className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
              <button
                type="button"
                data-testid="deleted-restore"
                className={buttonStyle("ghost", "sm")}
                onClick={() => onRestore([item])}
              >
                {t("deleted.restore")}
              </button>
              <button
                type="button"
                data-testid="deleted-delete"
                className={buttonStyle("ghost", "sm")}
                onClick={() => onDelete([item])}
              >
                {t("deleted.deletePermanently")}
              </button>
            </span>
          )}
          <ObjectMenu
            target={target}
            label={t("deleted.more", { name })}
            className={`${rowActionButtonClass} opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 aria-expanded:opacity-100`}
          />
        </span>
      </div>
    </div>
  );
}
