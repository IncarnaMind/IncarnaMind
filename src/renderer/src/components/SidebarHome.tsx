import { useT } from "../i18n";
import { currentTabOf } from "../layoutSlice";
import { useAppStore } from "../store";
import { TREE_ROW } from "../treeKeys";
import { HomeLineIcon } from "./lineIcons";
import { rowButtonClass, rowClass, rowIconClass } from "./sidebarRows";

export function SidebarHome() {
  const t = useT();
  const shown = useAppStore((state) => currentTabOf(state.layout)?.item.kind === "home");
  return (
    <div className={rowClass(shown)}>
      <button
        type="button"
        {...TREE_ROW}
        data-testid="sidebar-home"
        aria-current={shown ? "page" : undefined}
        onClick={(event) =>
          void useAppStore.getState().openHome({ side: event.metaKey || event.ctrlKey })
        }
        className={rowButtonClass}
      >
        <HomeLineIcon className={rowIconClass(shown)} />
        <span className="min-w-0 flex-1 truncate">{t("home.title")}</span>
      </button>
    </div>
  );
}
