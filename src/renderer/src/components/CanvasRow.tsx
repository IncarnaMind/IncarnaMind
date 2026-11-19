import type { Canvas } from "../../../core/api";
import type { CommandId } from "../../../shared/commands";
import { commands } from "../commands/registry";
import { useT } from "../i18n";
import { currentTabOf } from "../layoutSlice";
import { onMiddleClick } from "../middleClick";
import { useSelectable, useSeveralSelected } from "../selection";
import { useAppStore } from "../store";
import { useTreeItem } from "../treeKeys";
import { DocumentLineIcon } from "./lineIcons";
import { ObjectMenu, useObjectMenu } from "./ObjectMenu";
import {
  clearsActions,
  rowActionsClass,
  rowButtonClass,
  rowClass,
  rowIconClass,
  rowPadding,
} from "./sidebarRows";

/**
 * A Canvas in the sidebar's tree (#3406), in its Folder or Not in a Folder, after the Notes: a
 * click or Enter opens it, ⌘-click and Shift-click select, a middle click opens it in a new tab,
 * and its menu (⋯, or a right-click) holds what the User can do with it. The User doesn't edit a
 * Canvas, so it has no Rename; it doesn't drag, and Move to… isn't offered.
 */
export function CanvasRow({ canvas, depth }: { canvas: Canvas; depth: number }) {
  const t = useT();
  const isOpen = useAppStore((state) => {
    const shown = currentTabOf(state.layout)?.item;
    return shown?.kind === "canvas" && shown.canvasId === canvas.id;
  });
  const title = canvas.title || t("canvas.untitled");
  const object = { kind: "canvas", id: canvas.id } as const;
  const run = (id: CommandId) =>
    void commands
      .run(id, { selection: [], focus: object, surface: "sidebar" })
      .catch(useAppStore.getState().reportError);
  const objectMenu = useObjectMenu(object);
  const select = useSelectable(object, "sidebar", () => run("canvas.open"));
  const several = useSeveralSelected("sidebar");
  const treeItem = useTreeItem({ depth, selected: select.selected });

  return (
    <li
      data-testid="canvas-row"
      data-canvas-id={canvas.id}
      data-folder-id={canvas.folderId ?? ""}
      role="none"
      {...select.refProps}
      {...objectMenu.rowProps}
      className={rowClass(select.selected, "app", several)}
    >
      <button
        type="button"
        {...treeItem}
        data-testid="canvas-list-item"
        aria-current={isOpen ? "page" : undefined}
        title={t("canvas.frame", { title, agent: canvas.agent })}
        onClick={select.onClick}
        {...onMiddleClick(() => run("canvas.openTab"))}
        className={`${rowButtonClass} ${clearsActions.menu}`}
        style={rowPadding(depth)}
      >
        <DocumentLineIcon kind="html" className={rowIconClass(select.selected)} />
        <span data-testid="row-text" className="min-w-0 flex-1 truncate">
          {title}
        </span>
      </button>
      <div className={rowActionsClass}>
        <ObjectMenu target={object} label={t("canvas.more", { title })} tabIndex={-1} />
      </div>
    </li>
  );
}
