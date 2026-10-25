import { mindName } from "../../../shared/naming";
import { useT } from "../i18n";
import { currentTabOf } from "../layoutSlice";
import { useAppStore } from "../store";
import { useTreeItem } from "../treeKeys";
import { ExamplesMenu } from "./ExamplesMenu";
import { MindLineIcon } from "./lineIcons";
import { useObjectMenu } from "./ObjectMenu";
import {
  clearsActions,
  rowActionsClass,
  rowButtonClass,
  rowClass,
  rowIconClass,
} from "./sidebarRows";

/**
 * The examples, folded to one row once the User has a Document of their own
 * (#1944): it opens the first-run example, and its ⋯, a right-click or
 * Shift+F10 offers the others and removes them.
 */
export function ExampleRow({ mindId }: { mindId: string }) {
  const t = useT();
  const mind = useAppStore((state) => state.minds.find((each) => each.id === mindId));
  const shown = useAppStore((state) => {
    const item = currentTabOf(state.layout)?.item;
    return item?.kind === "mind" && item.mindId === mindId;
  });
  const treeItem = useTreeItem({ depth: 0 });
  const examplesMenu = useObjectMenu(null, (row) =>
    row.querySelector<HTMLButtonElement>('[data-testid="examples-menu"]'),
  );
  if (!mind) return null;
  return (
    <div data-testid="example-row" className={rowClass(shown)} {...examplesMenu.rowProps}>
      <button
        type="button"
        {...treeItem}
        data-testid="example-open"
        aria-current={shown ? "page" : undefined}
        title={mindName(mind) || t("examples.row")}
        onClick={() => {
          const state = useAppStore.getState();
          if (state.minds.some((each) => each.id === mindId)) state.openMind(mindId);
        }}
        className={`${rowButtonClass} ${clearsActions.menu}`}
      >
        <MindLineIcon className={rowIconClass(shown)} />
        <span data-testid="row-text" className="min-w-0 flex-1 truncate">
          {t("examples.row")}
        </span>
      </button>
      <div className={rowActionsClass}>
        <ExamplesMenu />
      </div>
    </div>
  );
}
