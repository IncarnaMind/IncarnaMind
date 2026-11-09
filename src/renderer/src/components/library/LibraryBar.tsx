import { useState } from "react";
import { useLanguage, useT } from "../../i18n";
import type { FacetOption, FilterSelection, LibraryFacet } from "../../libraryFilters";
import { formatCount } from "../../linkedFolders";
import type { Sort } from "../../sort";
import type { SortScope } from "../../sortChoices";
import { useSortMenu } from "../../sortMenu";
import { CheckLineIcon, ChevronRightLineIcon, CloseLineIcon, PlusLineIcon } from "../lineIcons";
import { SORT_KEY_LABELS } from "../SortMenu";
import { TagDot } from "../TagColour";
import { menuClass, menuItemClass, menuTitleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

/** A quiet text button in the bar, its words on the page's edge: its padding hangs into the margin. */
const barButtonClass =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[13px] text-ink-secondary hover:bg-hover hover:text-ink aria-expanded:bg-hover aria-expanded:text-ink";

/**
 * The quiet bar under the search: "+ Filter" and the filters chosen, as chips
 * that read as a sentence (Notion, Linear), then Sort and Collapse all.
 */
export function LibraryBar<T>({
  facets,
  options,
  selection,
  onToggle,
  onRemove,
  sort,
  sortScope,
  allFolded,
  onFoldAll,
}: {
  facets: readonly LibraryFacet<T>[];
  options: ReadonlyMap<string, FacetOption[]>;
  selection: FilterSelection;
  onToggle(facetId: string, value: string): void;
  onRemove(facetId: string): void;
  sort: Sort;
  sortScope: SortScope;
  allFolded: boolean;
  onFoldAll(): void;
}) {
  const t = useT();
  const chosen = facets.filter((facet) => (selection[facet.id]?.length ?? 0) > 0);
  const free = facets.filter((facet) => !chosen.includes(facet));
  const by = t(SORT_KEY_LABELS[sort.key]);
  const arrow = sort.direction === "asc" ? "↑" : "↓";
  return (
    <fieldset
      aria-label={t("library.filter.label")}
      data-testid="library-bar"
      className="mt-2 flex min-h-9 min-w-0 flex-wrap items-center gap-x-1 gap-y-1"
    >
      {chosen.map((facet) => (
        <FilterChip
          key={facet.id}
          facet={facet}
          options={options.get(facet.id) ?? []}
          onToggle={(value) => onToggle(facet.id, value)}
          onRemove={() => onRemove(facet.id)}
        />
      ))}
      {free.length > 0 && (
        <AddFilter
          facets={free}
          all={facets}
          options={options}
          onToggle={onToggle}
          className={chosen.length === 0 ? "-ml-2" : ""}
        />
      )}
      <span className="flex-1" />
      <button
        type="button"
        data-testid="library-sort"
        aria-label={t("sort.bar.label", {
          by,
          direction: t(sort.direction === "asc" ? "sort.ascending" : "sort.descending"),
        })}
        onClick={(event) =>
          useSortMenu
            .getState()
            .show({ scope: sortScope, withFolders: false, anchor: event.currentTarget })
        }
        className={barButtonClass}
      >
        {t("sort.bar", { by: `${by} ${arrow}` })}
      </button>
      <button
        type="button"
        data-testid="library-fold-all"
        onClick={onFoldAll}
        className={`${barButtonClass} -mr-2`}
      >
        {t(allFolded ? "library.expandAll" : "library.collapseAll")}
      </button>
    </fieldset>
  );
}

/** "+ Filter": the filters not chosen yet; picking one shows its options in the same menu. */
function AddFilter<T>({
  facets,
  all,
  options,
  onToggle,
  className,
}: {
  facets: readonly LibraryFacet<T>[];
  /** Every filter: one picked here stays in the menu once chosen, for more of its options. */
  all: readonly LibraryFacet<T>[];
  options: ReadonlyMap<string, FacetOption[]>;
  onToggle(facetId: string, value: string): void;
  className: string;
}) {
  const t = useT();
  const menu = usePopoverMenu({ focus: "first" });
  const [picking, setPicking] = useState<string | null>(null);
  const facet = menu.open ? all.find((each) => each.id === picking) : undefined;
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="library-add-filter"
        aria-label={t("library.filter.addLabel")}
        className={`${barButtonClass} ${className}`}
      >
        <PlusLineIcon className="size-3.5" />
        {t("library.filter.add")}
      </button>
      <div
        {...menu.menuProps}
        onBeforeToggle={(event) => {
          menu.menuProps.onBeforeToggle(event);
          if (event.newState === "open") setPicking(null);
        }}
        role="menu"
        aria-label={facet ? t(facet.title) : t("library.filter.addLabel")}
        data-testid="library-add-filter-menu"
        className={menuClass}
      >
        {menu.open &&
          (facet ? (
            <FacetOptions
              facet={facet}
              options={options.get(facet.id) ?? []}
              onToggle={(value) => onToggle(facet.id, value)}
            />
          ) : (
            facets.map((each) => (
              <button
                key={each.id}
                type="button"
                role="menuitem"
                data-testid="library-filter-kind"
                data-facet={each.id}
                onClick={() => {
                  setPicking(each.id);
                  // The item clicked goes with the list it was in: the focus moves to the first option.
                  requestAnimationFrame(() =>
                    menu.menuProps.ref.current
                      ?.querySelector<HTMLElement>('[role^="menuitem"]')
                      ?.focus(),
                  );
                }}
                className={`${menuItemClass} pl-2`}
              >
                <span className="min-w-0 flex-1 truncate">{t(each.title)}</span>
                <ChevronRightLineIcon className="size-3.5 shrink-0 text-ink-meta" />
              </button>
            ))
          ))}
      </div>
    </>
  );
}

/** A chosen filter as a chip: "Format: PDF +1", which opens its options, and × to drop it. */
function FilterChip<T>({
  facet,
  options,
  onToggle,
  onRemove,
}: {
  facet: LibraryFacet<T>;
  options: readonly FacetOption[];
  onToggle(value: string): void;
  onRemove(): void;
}) {
  const t = useT();
  const menu = usePopoverMenu();
  const chosen = options.filter((option) => option.selected);
  const title = t(facet.title);
  const [head] = chosen;
  const value = head ? facet.label(head.value, t) : "";
  // "Format: PDF +1", in the interface's words, its first value in bold.
  const sentence =
    chosen.length > 1
      ? t("library.filter.chosenMore", { filter: title, value, more: chosen.length - 1 })
      : t("library.filter.chosen", { filter: title, value });
  const at = sentence.lastIndexOf(value);
  return (
    <span
      data-testid="library-filter"
      data-facet={facet.id}
      className="inline-flex h-6 max-w-72 min-w-0 items-center rounded-sm bg-chip text-[12px] text-ink-secondary"
    >
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="library-filter-chip"
        className="flex h-full min-w-0 items-center gap-1 rounded-l-sm pr-1 pl-2 hover:bg-hover"
      >
        <span className="min-w-0 truncate">
          {sentence.slice(0, at)}
          <span className="font-semibold text-ink">{value}</span>
          {sentence.slice(at + value.length)}
        </span>
      </button>
      <button
        type="button"
        data-testid="library-filter-remove"
        aria-label={t("library.filter.remove", { filter: title })}
        title={t("library.filter.remove", { filter: title })}
        onClick={onRemove}
        className="mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-ink-meta hover:bg-hover hover:text-ink"
      >
        <CloseLineIcon className="size-3" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={title}
        data-testid="library-filter-menu"
        data-facet={facet.id}
        className={menuClass}
      >
        {menu.open && <FacetOptions facet={facet} options={options} onToggle={onToggle} />}
      </div>
    </span>
  );
}

/** A filter's options, each with how many Documents it holds; a choice keeps the menu open for more. */
function FacetOptions<T>({
  facet,
  options,
  onToggle,
}: {
  facet: LibraryFacet<T>;
  options: readonly FacetOption[];
  onToggle(value: string): void;
}) {
  const t = useT();
  const language = useLanguage();
  return (
    <>
      <p className={menuTitleClass}>{t(facet.title)}</p>
      {options.map(({ value, count, selected }) => {
        const name = facet.label(value, t);
        return (
          <button
            key={value}
            type="button"
            role="menuitemcheckbox"
            aria-checked={selected}
            aria-label={t(count === 1 ? "library.filter.option.one" : "library.filter.option", {
              value: name,
              count: formatCount(count, language),
            })}
            data-testid="library-filter-option"
            data-value={value}
            data-count={count}
            onClick={() => onToggle(value)}
            className={`${menuItemClass} pl-2 ${count === 0 && !selected ? "text-ink-meta" : ""}`}
          >
            <CheckLineIcon className={`size-3.5 shrink-0 ${selected ? "text-ink" : "invisible"}`} />
            {facet.colour?.(value) && <TagDot colour={facet.colour(value) ?? undefined} />}
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span aria-hidden="true" className="shrink-0 text-[12px] tabular-nums text-ink-meta">
              {formatCount(count, language)}
            </span>
          </button>
        );
      })}
    </>
  );
}
