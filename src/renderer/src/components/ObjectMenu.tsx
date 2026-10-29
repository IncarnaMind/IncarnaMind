import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import type { CommandId } from "../../../shared/commands";
import { showPlace } from "../commands/here";
import { menuKeysLabel } from "../commands/keymap";
import { buildMenu, buildMixedMenu, type MenuEntry, type MenuItem } from "../commands/menus";
import {
  type CommandContext,
  commands,
  menuLabelOf,
  SURFACES,
  type Surface,
} from "../commands/registry";
import { useT } from "../i18n";
import type { ObjectKind, ObjectRef } from "../objects";
import { useSelection } from "../selection";
import { useAppStore } from "../store";
import { CheckLineIcon, MoreLineIcon } from "./lineIcons";
import { rowActionButtonClass } from "./sidebarRows";
import { menuClass, menuItemClass, menuItemUnavailableClass, menuRuleClass } from "./ui";
import { openMenuFromRightClick, usePopoverMenu } from "./usePopoverMenu";

const TEST_ID_PREFIX: Record<ObjectKind, string> = {
  mind: "mind",
  conversation: "conversation",
  document: "document-file",
  folder: "folder",
  tag: "tag",
  linkedFolder: "linked-folder",
  deleted: "deleted",
  citation: "citation",
  chart: "chart",
  comparisonColumn: "comparison-column",
  comparisonCell: "comparison-cell",
  comparisonTable: "comparison-table",
  comparisonRow: "comparison-row",
  answer: "answer",
  check: "check",
  block: "block",
  tab: "tab",
};

const keyOf = (target: ObjectRef) => `${target.kind}:${target.id}`;

const ROW = "[data-object-row]";

function focusRow(from: HTMLElement | null): void {
  const row = from?.closest<HTMLElement>(ROW);
  if (!row) return;
  const own = row.getAttribute("tabindex") !== null;
  (own
    ? row
    : row.querySelector<HTMLElement>(
        "[data-row-main], [data-tree-row], button:not([data-object-menu]), a[href], [tabindex]",
      )
  )?.focus();
}

/**
 * What a row needs for its menu: `buttonProps` for the ⋯ button (so the row
 * finds it), and `rowProps` for the row, so a right-click, the context-menu
 * key or Shift+F10 on it opens the menu the ⋯ button opens. A row without an
 * object, the examples' (#1944), passes null and the button that finds its own.
 */
export function useObjectMenu(
  target: ObjectRef | null,
  buttonOf?: (row: HTMLElement) => HTMLButtonElement | null,
) {
  const key = target ? keyOf(target) : null;
  const findButton = (row: HTMLElement): HTMLButtonElement | null =>
    key !== null
      ? row.querySelector<HTMLButtonElement>(`[data-object-menu="${CSS.escape(key)}"]`)
      : (buttonOf?.(row) ?? null);
  const open = (
    row: HTMLElement,
    buttons: number,
    at: { x: number; y: number; above?: number },
  ): boolean => {
    const button = findButton(row);
    if (!button) return false;
    openMenuFromRightClick(button, buttons, at);
    return true;
  };
  return {
    buttonProps: key !== null ? { "data-object-menu": key } : {},
    rowProps: {
      "data-object-row": "",
      onContextMenu(event: MouseEvent<HTMLElement>) {
        const row = event.currentTarget;
        // Not from a menu or picker drawn from this row but sitting elsewhere in the page, nor an inner row's.
        if (!(event.target instanceof Node) || !row.contains(event.target)) return;
        if (event.defaultPrevented || (event.target as Element).closest('[role="menu"]')) return;
        if (open(row, event.buttons, { x: event.clientX, y: event.clientY })) {
          event.preventDefault();
          // The row's own menu only: not that of a row that holds this one.
          event.stopPropagation();
        }
      },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        const opensMenu = event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
        if (!opensMenu || event.defaultPrevented) return;
        const field = event.target;
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (open(event.currentTarget, 0, { x: box.left + 24, y: box.bottom, above: box.top })) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
    },
  };
}

/**
 * "Tags…" opens the Tag picker the Document's row or header already has, once the menu has closed;
 * for several Documents selected, the one beside the selection (the Library's bar, the sidebar's line).
 */
function tagsHere(
  target: ObjectRef,
  from: HTMLElement | null,
  selection: readonly ObjectRef[],
): CommandContext["here"] {
  const picker =
    target.kind !== "document"
      ? null
      : selection.length > 1
        ? from?.closest("[data-surface]")?.querySelector<HTMLButtonElement>("[data-selection-tags]")
        : from
            ?.closest(ROW)
            ?.querySelector<HTMLButtonElement>('[data-testid="document-tags-menu"]');
  return picker ? { "document.tags": () => requestAnimationFrame(() => picker.click()) } : {};
}

const surfaceOf = (element: Element | null): Surface => {
  const marked = element?.closest<HTMLElement>("[data-surface]")?.dataset.surface;
  return SURFACES.find((each) => each === marked) ?? "sidebar";
};

function dangerStart(entries: readonly MenuEntry[]): number {
  const last = entries.at(-1);
  if (!last || last === "rule" || last.command.group !== "danger") return entries.length;
  const rule = entries.lastIndexOf("rule");
  return rule === -1 ? 0 : rule;
}

/**
 * The ⋯ button of an object's row, and its menu. The menu acts on `target`, or,
 * when `selection` holds it, on the whole selection (#225). `here` holds what
 * only the row showing the object can do (see `CommandContext.here`).
 */
export function ObjectMenu({
  target,
  label,
  selection,
  here,
  className = rowActionButtonClass,
  tabIndex,
  testId,
  align,
  without,
  more,
  aside,
  foot,
}: {
  target: ObjectRef;
  /** What the button and the menu are called: "More for Board minutes". */
  label: string;
  selection?: readonly ObjectRef[];
  here?: CommandContext["here"];
  className?: string;
  tabIndex?: number;
  /** In place of the kind's own, for a second button on the same object: `${testId}-menu`. */
  testId?: string;
  align?: "start" | "end";
  /** The kind's commands this menu offers its own way, in `more`. */
  without?: readonly CommandId[];
  /** Items after the kind's own and before its Delete, which stays last, a rule before them; `close` closes the menu. */
  more?: (close: () => void) => ReactNode;
  /** Beside the menu while it is open, outside it: the submenus of items in `more`. */
  aside?: (close: () => void) => ReactNode;
  /** Below everything, after a rule, and kept in view while the menu scrolls. */
  foot?: ReactNode | ((close: () => void) => ReactNode);
}) {
  const t = useT();
  const { kind, id } = target;
  // The first item, though a switch at its foot is checked.
  const menu = usePopoverMenu({ focus: "first", ...(align && { align }) });
  const { buttonProps } = useObjectMenu(target);
  const prefix = testId ?? TEST_ID_PREFIX[target.kind];
  const button = menu.buttonProps.ref;
  const hereNow = useRef(here);
  hereNow.current = here;
  useEffect(() => {
    const element = button.current;
    if (!element) return;
    const alone: ObjectRef = { kind, id };
    return showPlace(element, () => ({ ...tagsHere(alone, element, []), ...hereNow.current }));
  }, [button, kind, id]);
  // Selected, the menu is for the whole selection; else for this one alone.
  const held = useSelection((state) => (state.keys.has(keyOf(target)) ? state : null));

  const surface = surfaceOf(button.current);
  const chosen = selection ?? (held && held.surface === surface ? held.items : []);
  const forSelection: CommandContext = {
    selection: chosen.some((each) => each.kind === target.kind && each.id === target.id)
      ? chosen
      : [],
    focus: target,
    surface,
    here: { ...tagsHere(target, button.current, chosen), ...here },
  };
  const mixed = new Set(forSelection.selection.map((each) => each.kind)).size > 1;
  const selectionEntries = !menu.open
    ? []
    : mixed
      ? buildMixedMenu(forSelection)
      : buildMenu(target.kind, forSelection, without);
  // Kinds mixed in the selection that share no command: the menu is this row's own.
  const alone = menu.open && forSelection.selection.length > 0 && selectionEntries.length === 0;
  const ctx: CommandContext = alone
    ? { ...forSelection, selection: [], here: { ...tagsHere(target, button.current, []), ...here } }
    : forSelection;
  const entries = alone ? buildMenu(target.kind, ctx, without) : selectionEntries;

  const run = (item: MenuItem) => {
    if (item.enabled !== true) return;
    menu.close();
    commands.run(item.command.id, ctx).catch(useAppStore.getState().reportError);
  };

  const dangerAt = dangerStart(entries);
  const itemOf = (entry: MenuEntry, index: number) => {
    if (entry === "rule") {
      // biome-ignore lint/suspicious/noArrayIndexKey: rules have no identity but their place.
      return <div key={`rule-${index}`} className={menuRuleClass} />;
    }
    const { command, enabled } = entry;
    const keys = menuKeysLabel(command);
    const reason = enabled === true ? undefined : t(enabled.reason);
    const hint = command.hint ? t(command.hint) : undefined;
    const checked = command.checked?.(ctx);
    return (
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: only a toggle's item takes aria-checked.
      <button
        key={command.id}
        type="button"
        role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={checked}
        data-testid={command.id}
        aria-disabled={enabled === true ? undefined : true}
        aria-description={hint}
        title={reason ?? hint}
        onClick={() => run(entry)}
        className={`${menuItemClass} ${menuItemUnavailableClass} pl-2`}
      >
        <span className="flex-1">{menuLabelOf(command, ctx, t)}</span>
        {checked && <CheckLineIcon className="size-4 shrink-0 text-ink-meta" />}
        {keys && <span className="pl-4 text-[13px] text-ink-meta">{keys}</span>}
      </button>
    );
  };

  return (
    <>
      <button
        {...menu.buttonProps}
        {...buttonProps}
        type="button"
        data-testid={`${prefix}-menu`}
        aria-label={label}
        title={label}
        {...(tabIndex !== undefined && { tabIndex })}
        className={className}
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={label}
        data-testid={`${prefix}-actions`}
        title=""
        className={menuClass}
        onKeyDown={(event) => {
          menu.menuProps.onKeyDown(event);
          // The ⋯ button can be out of sight, so Esc returns to the row.
          if (event.key === "Escape") focusRow(button.current);
        }}
      >
        {entries.slice(0, dangerAt).map((entry, index) => itemOf(entry, index))}
        {menu.open && more && (
          <>
            <div className={menuRuleClass} />
            {more(menu.close)}
          </>
        )}
        {entries.slice(dangerAt).map((entry, index) => itemOf(entry, dangerAt + index))}
        {menu.open && foot && (
          // A long menu scrolls; its foot stays in view, covering the menu's bottom padding.
          <div className="sticky -bottom-1 -mb-1 bg-sheet pb-1">
            <div className={menuRuleClass} />
            {typeof foot === "function" ? foot(menu.close) : foot}
          </div>
        )}
      </div>
      {menu.open && aside?.(menu.close)}
    </>
  );
}
