import { shortcutLabel } from "../commands/keymap";
import { useT } from "../i18n";
import { usePalette } from "../palette";
import { TREE_ROW } from "../treeKeys";
import { SearchLineIcon } from "./icons";
import { rowButtonClass, rowClass, rowIconClass } from "./sidebarRows";

/** "Search ⌘K" at the top of the sidebar's tree, as in Notion: it opens ⌘K. */
export function SidebarSearch() {
  const t = useT();
  return (
    <div className={rowClass(false)}>
      <button
        type="button"
        {...TREE_ROW}
        data-testid="sidebar-search"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => usePalette.getState().show()}
        className={rowButtonClass}
      >
        <SearchLineIcon className={rowIconClass} />
        <span className="min-w-0 flex-1 truncate">{t("sidebar.search")}</span>
        <kbd className="shrink-0 rounded-sm bg-chip px-1 font-sans text-small leading-4 text-ink-meta">
          {shortcutLabel("palette.open")}
        </kbd>
      </button>
    </div>
  );
}
