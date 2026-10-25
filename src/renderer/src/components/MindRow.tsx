import { type KeyboardEvent, useRef } from "react";
import type { Mind } from "../../../core/api";
import { mindName } from "../../../shared/naming";
import { useCitationStylePicker } from "../citationStylePicker";
import { useDragSource } from "../dragDrop";
import { useT } from "../i18n";
import { currentTabOf } from "../layoutSlice";
import { onMiddleClick } from "../middleClick";
import { useMindStatus } from "../mindStatus";
import { useSelectable, useSeveralSelected } from "../selection";
import { moveFromMenu, rowDrag, useSidebarMove } from "../sidebarMoves";
import { useAppStore } from "../store";
import { isMoveToKey, useTreeItem } from "../treeKeys";
import { useRename } from "../useRename";
import { ExampleChip, useIsExample } from "./GettingStarted";
import { InlineName } from "./InlineName";
import { MindLineIcon } from "./lineIcons";
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
 * A Mind in the sidebar's tree, in its Folder (`depth` 1) or Not in a Folder
 * (0): its title, and an amber dot while one of its Answers waits for the
 * User's approval. Clicking or Enter opens it and selects just it; ⌘-click
 * and Shift-click select; a middle click opens it in a new tab. It renames in place: double-click it or press F2;
 * Enter saves, Esc cancels, and a blank title changes nothing.
 * It drags onto a Folder, with the rows selected with it; its menu (⋯, or a
 * right-click) and ⇧⌘M offer the same as "Move to…" (see `SidebarMoveTo`).
 */
export function MindRow({ mind, depth }: { mind: Mind; depth: number }) {
  const t = useT();
  const isOpen = useAppStore((state) => {
    const shown = currentTabOf(state.layout)?.item;
    return shown?.kind === "mind" && shown.mindId === mind.id;
  });
  const openMind = useAppStore((state) => state.openMind);
  const renameMind = useAppStore((state) => state.renameMind);
  const waiting = useMindStatus(mind.id) === "waiting-for-approval";
  const isExample = useIsExample(mind.id);
  const rename = useRename<HTMLButtonElement>(`mind:${mind.id}`);
  const row = useRef<HTMLLIElement>(null);
  const title = mindName(mind) || t("mind.untitled");
  const object = { kind: "mind", id: mind.id } as const;
  const objectMenu = useObjectMenu(object);
  const select = useSelectable(object, "sidebar", () => openMind(mind.id));
  const lit = select.selected;
  const several = useSeveralSelected("sidebar");
  const treeItem = useTreeItem({ depth, selected: select.selected });
  const dragSource = useDragSource(() => rowDrag(object, "sidebar"));

  if (rename.renaming) {
    return (
      <li className={rowClass(lit, "app", several)} data-testid="mind-row" data-mind-id={mind.id}>
        <span
          className="flex h-full w-full min-w-0 items-center gap-2 pr-1"
          style={rowPadding(depth)}
        >
          <MindLineIcon className={rowIconClass(lit)} />
          <InlineName
            value={mind.title}
            label={t("mind.renameLabel", { title })}
            placeholder={title}
            testId="mind-rename"
            clearable
            {...rename.field((name) => renameMind(mind.id, name))}
          />
        </span>
      </li>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isMoveToKey(event)) {
      event.preventDefault();
      useSidebarMove.getState().show(event.currentTarget, object);
    }
  };

  return (
    <li
      data-testid="mind-row"
      data-mind-id={mind.id}
      data-folder-id={mind.folderId ?? ""}
      role="none"
      {...select.refProps}
      {...dragSource}
      {...objectMenu.rowProps}
      ref={row}
      className={rowClass(lit, "app", several)}
    >
      <button
        {...rename.nameProps}
        type="button"
        {...treeItem}
        data-testid="mind-list-item"
        data-mind-id={mind.id}
        aria-current={isOpen ? "page" : undefined}
        title={title}
        // A click opens it; ⌘-click and Shift-click select (`useSelectable`).
        onClick={select.onClick}
        {...onMiddleClick(() => openMind(mind.id, { newTab: true }))}
        onKeyDown={(event) => {
          rename.nameProps.onKeyDown(event);
          onKeyDown(event);
        }}
        className={`${rowButtonClass} ${clearsActions.menu}`}
        style={rowPadding(depth)}
      >
        <MindLineIcon className={rowIconClass(lit)} />
        <span
          data-testid="row-text"
          className={`min-w-0 flex-1 truncate ${mindName(mind) ? "" : "text-ink-meta"}`}
        >
          {title}
        </span>
        {isExample && <ExampleChip />}
        {waiting && (
          <span
            role="img"
            data-testid="mind-approval"
            aria-label={t("approvals.answer.waiting")}
            title={t("approvals.answer.waiting")}
            className="size-1.5 shrink-0 rounded-full bg-attention"
          />
        )}
      </button>
      <div className={rowActionsClass}>
        <ObjectMenu
          target={object}
          label={t("mind.more", { title })}
          tabIndex={-1}
          here={{
            "mind.rename": rename.start,
            "mind.citationStyle": () =>
              requestAnimationFrame(() =>
                useCitationStylePicker
                  .getState()
                  .show(
                    mind.id,
                    row.current?.querySelector<HTMLElement>("[data-object-menu]") ?? null,
                  ),
              ),
            "mind.moveTo": () => moveFromMenu(row.current, object),
          }}
        />
      </div>
    </li>
  );
}
