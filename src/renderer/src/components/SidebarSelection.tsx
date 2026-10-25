import { useShallow } from "zustand/react/shallow";
import { useLanguage, useT } from "../i18n";
import { formatCount } from "../linkedFolders";
import { useSelectedOn } from "../selection";
import { useAppStore } from "../store";
import { SelectionTags } from "./SelectionTags";

/**
 * The sidebar's foot says how many rows are selected, "3 selected · Esc
 * clears", once there are two or more; a screen reader hears it as the
 * selection changes. With only Documents selected, it offers their Tags; every
 * other command is in the right-click menu (the same one the Library's bar shows).
 */
export function SidebarSelection() {
  const t = useT();
  const language = useLanguage();
  const items = useSelectedOn("sidebar");
  const documents = useAppStore(
    useShallow((state) => {
      const ids = new Set(items.flatMap((item) => (item.kind === "document" ? [item.id] : [])));
      return ids.size > 0 ? state.documents.filter((each) => ids.has(each.id)) : [];
    }),
  );
  const several = items.length > 1;
  return (
    <div className={several ? "flex h-7 items-center gap-2 px-2 text-[12px] text-ink-meta" : ""}>
      <span role="status" data-testid="sidebar-selection" className="min-w-0 flex-1 truncate">
        {several && t("sidebar.selected", { count: formatCount(items.length, language) })}
      </span>
      {several && documents.length === items.length && (
        <SelectionTags documents={documents} testId="sidebar-selection-tags" />
      )}
    </div>
  );
}
