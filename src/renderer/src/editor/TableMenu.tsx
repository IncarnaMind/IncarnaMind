import { autoUpdate } from "@floating-ui/dom";
import { type Editor, useEditorState } from "@tiptap/react";
import { Fragment, type KeyboardEvent, useEffect, useLayoutEffect, useState } from "react";
import { shortcutLabel } from "../commands/keymap";
import { CheckLineIcon, MoreLineIcon } from "../components/lineIcons";
import {
  menuClass,
  menuItemClass,
  menuItemUnavailableClass,
  menuRuleClass,
} from "../components/ui";
import { openMenuFromRightClick, usePopoverMenu } from "../components/usePopoverMenu";
import { languageNow, useT } from "../i18n";
import { chartOfTable, insertChart } from "./chartCommands";
import {
  runTableAction,
  sameSpot,
  TABLE_ACTIONS,
  type TableAction,
  type TableActionId,
  type TableSpot,
  tableSpot,
  unavailable,
} from "./tableCommands";

const BUTTON_SIZE = 20;
/** How far the button sits inside the cell's top-right corner. */
const INSET = 4;

const actionOf = (id: TableActionId) =>
  TABLE_ACTIONS.find((action) => action.id === id) as TableAction;

const GROUPS: readonly (readonly (TableActionId | "chart")[])[] = [
  ["rowAbove", "rowBelow", "columnLeft", "columnRight"],
  ["headerRow", "totalRow", "totalColumn"],
  ["chart"],
  ["deleteRow", "deleteColumn", "deleteTable"],
];

/** In `frame`, not fixed, so it scrolls with the text and stays under the composer. */
function placeOnCell(cell: HTMLElement, button: HTMLElement, frame: HTMLElement): () => void {
  const place = () => {
    const box = cell.getBoundingClientRect();
    const shown = cell.closest(".tableWrapper")?.getBoundingClientRect() ?? box;
    const right = Math.min(box.right, shown.right);
    const origin = frame.getBoundingClientRect();
    button.style.left = `${right - INSET - BUTTON_SIZE - origin.left}px`;
    button.style.top = `${box.top + INSET - origin.top}px`;
    button.style.visibility =
      right - BUTTON_SIZE - INSET < Math.max(box.left, shown.left) ? "hidden" : "";
  };
  return autoUpdate(cell, button, place);
}

/**
 * The table menu: a ⋯ button at the top-right corner of the cell the cursor
 * is in, as Confluence has, and the same menu on a right-click in a cell or
 * with ⌘/ (its command, `table.menu`; the right-click is `TableKeys`'s). It adds rows and columns where the cursor is,
 * turns the heading row on and off, and deletes rows, columns or the table,
 * each an Undo step of its own. Drawn inside `.mind-editor-frame`.
 */
export function TableMenu({ editor }: { editor: Editor }) {
  const t = useT();
  const menu = usePopoverMenu({ focus: "first" });
  const spot = useEditorState({
    editor,
    selector: ({ editor: current }): TableSpot | null =>
      current.isEditable ? tableSpot(current.state) : null,
    equalityFn: sameSpot,
  });
  const focused = useEditorState({ editor, selector: ({ editor: current }) => current.isFocused });
  /** The menu was asked for (⌘/ or a right-click) and opens once its button is there. */
  const [asked, setAsked] = useState<{ buttons: number } | null>(null);
  const shown = spot !== null && (focused || menu.open || asked !== null);
  const button = menu.buttonProps.ref;
  const chart = menu.open && spot ? chartOfTable(editor.state, languageNow()) : null;
  const groups = GROUPS.filter((group) => group[0] !== "chart" || chart !== null);

  useEffect(() => {
    editor.storage.tableKeys.openMenu = (buttons) => setAsked({ buttons });
    return () => {
      editor.storage.tableKeys.openMenu = null;
    };
  }, [editor]);

  useEffect(() => {
    if (!asked) return;
    setAsked(null);
    if (button.current) openMenuFromRightClick(button.current, asked.buttons);
  }, [asked, button]);

  const cell = spot?.cell ?? null;
  useLayoutEffect(() => {
    const element = button.current;
    const frame = element?.parentElement;
    const dom = cell === null || editor.isDestroyed ? null : editor.view.nodeDOM(cell);
    if (!shown || !element || !frame || !(dom instanceof HTMLElement)) return;
    return placeOnCell(dom, element, frame);
  }, [editor, cell, shown, button]);

  const choose = (action: TableAction) => {
    menu.close();
    runTableAction(editor, action);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Esc goes back to writing in the cell, not to the button.
    if (event.key === "Escape") {
      event.preventDefault();
      menu.close();
      editor.commands.focus();
      return;
    }
    menu.menuProps.onKeyDown(event);
  };

  const label = t("editor.table.menu");
  const labelOf = (id: TableActionId): string => {
    if (id === "deleteRow" && spot && spot.rows > 1)
      return t("editor.table.deleteRows", { count: spot.rows });
    if (id === "deleteColumn" && spot && spot.columns > 1)
      return t("editor.table.deleteColumns", { count: spot.columns });
    return t(actionOf(id).label);
  };
  const whyNot = (id: TableActionId): string | null => {
    const reason = spot && unavailable(id, spot);
    return reason ? t(reason) : null;
  };

  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="table-menu"
        aria-label={label}
        title={`${label} (${shortcutLabel("table.menu")})`}
        // Keep the cursor in the cell: the menu acts where it is.
        onMouseDown={(event) => event.preventDefault()}
        className="table-menu-button"
        hidden={!shown}
      >
        <MoreLineIcon className="size-3.5" />
      </button>
      <div
        {...menu.menuProps}
        onKeyDown={onKeyDown}
        role="menu"
        aria-label={label}
        data-testid="table-actions"
        className={menuClass}
      >
        {menu.open &&
          spot &&
          groups.map((group, index) => (
            <Fragment key={group.join()}>
              {index > 0 && <div className={menuRuleClass} />}
              {group.map((id) => {
                if (id === "chart") {
                  // Chart from table (#436): a chart of it, inserted after it.
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitem"
                      data-testid="table-chart"
                      onClick={() => {
                        if (!chart) return;
                        menu.close();
                        insertChart(editor, chart);
                      }}
                      className={`${menuItemClass} pl-2`}
                    >
                      <span className="flex-1">{t("chart.fromTable")}</span>
                    </button>
                  );
                }
                const action = actionOf(id);
                const why = whyNot(id);
                if (id === "headerRow" || id === "totalRow" || id === "totalColumn") {
                  const checked =
                    id === "headerRow"
                      ? spot.headerRow
                      : id === "totalRow"
                        ? spot.totalRow
                        : spot.totalColumn;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      data-testid={`table-${id}`}
                      onClick={() => choose(action)}
                      className={`${menuItemClass} pl-2`}
                    >
                      <span className="flex-1">{labelOf(id)}</span>
                      <CheckLineIcon
                        className={`size-3.5 shrink-0 ${checked ? "text-ink" : "invisible"}`}
                      />
                    </button>
                  );
                }
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    data-testid={`table-${id}`}
                    aria-disabled={why !== null || undefined}
                    title={why ?? undefined}
                    onClick={() => {
                      if (why === null) choose(action);
                    }}
                    className={`${menuItemClass} ${menuItemUnavailableClass} pl-2`}
                  >
                    <span className="flex-1">{labelOf(id)}</span>
                    {action.keys && (
                      <span className="pl-4 text-[13px] text-ink-meta">
                        {shortcutLabel(action.command)}
                      </span>
                    )}
                  </button>
                );
              })}
            </Fragment>
          ))}
      </div>
    </>
  );
}
