import { useLayoutEffect } from "react";
import type { MessageKey } from "../../../shared/i18n";
import { useT } from "../i18n";
import { DEFAULT_SORT, SORT_KEYS, type Sort, type SortKey } from "../sort";
import { sortOf, useSort } from "../sortChoices";
import { type SortRequest, useSortMenu } from "../sortMenu";
import { CheckLineIcon } from "./icons";
import { menuClass, menuItemClass, menuRuleClass } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

export const SORT_KEY_LABELS: Record<SortKey, MessageKey> = {
  name: "sort.name",
  added: "sort.added",
  modified: "sort.modified",
  kind: "sort.kind",
};

/** The Sort by menu: its key, its direction, Folders first and, for a Folder, "Use for all Folders". */
export function SortMenu() {
  const t = useT();
  const request = useSortMenu((state) => state.request);
  const menu = usePopoverMenu({ focus: "checked" });

  // Placed by the button it opens from: here, the one that asked.
  useLayoutEffect(() => {
    if (!request) return;
    menu.buttonProps.ref.current = request.anchor;
    if (!menu.menuProps.ref.current?.matches(":popover-open")) {
      menu.menuProps.ref.current?.showPopover();
    }
  }, [request, menu.buttonProps.ref, menu.menuProps.ref]);

  return (
    <div
      {...menu.menuProps}
      role="menu"
      aria-label={t("sort.menu.label")}
      data-testid="sort-menu"
      className={menuClass}
      onToggle={(event) => {
        menu.menuProps.onToggle(event);
        if (event.newState === "closed") {
          const anchor = useSortMenu.getState().request?.anchor;
          useSortMenu.getState().hide();
          if (anchor?.isConnected) anchor.focus();
        }
      }}
    >
      {request && <Items request={request} close={menu.close} />}
    </div>
  );
}

function Items({ request, close }: { request: SortRequest; close(): void }) {
  const t = useT();
  const { scope, withFolders } = request;
  const chosen = useSort(sortOf(scope));
  const current = chosen ?? DEFAULT_SORT;
  const choose = (next: Partial<Sort>) => {
    useSort.getState().choose(scope, { ...current, ...next });
    close();
  };
  const item = (
    label: string,
    checked: boolean,
    onClick: () => void,
    role: "menuitemradio" | "menuitemcheckbox" | "menuitem",
    testId: string,
  ) => (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: only the radio and checkbox items take it.
    <button
      type="button"
      role={role}
      aria-checked={role === "menuitem" ? undefined : checked}
      data-testid={testId}
      onClick={onClick}
      className={`${menuItemClass} pl-2`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {checked && <CheckLineIcon className="size-4" />}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  );
  return (
    <>
      {SORT_KEYS.map((key) =>
        item(
          t(SORT_KEY_LABELS[key]),
          current.key === key,
          () => choose({ key }),
          "menuitemradio",
          `sort-${key}`,
        ),
      )}
      <div className={menuRuleClass} />
      {item(
        t("sort.ascending"),
        current.direction === "asc",
        () => choose({ direction: "asc" }),
        "menuitemradio",
        "sort-asc",
      )}
      {item(
        t("sort.descending"),
        current.direction === "desc",
        () => choose({ direction: "desc" }),
        "menuitemradio",
        "sort-desc",
      )}
      {withFolders && (
        <>
          <div className={menuRuleClass} />
          {item(
            t("sort.foldersFirst"),
            current.foldersFirst,
            () => choose({ foldersFirst: !current.foldersFirst }),
            "menuitemcheckbox",
            "sort-folders-first",
          )}
          <div className={menuRuleClass} />
          {item(
            t("sort.useForAll"),
            false,
            () => {
              useSort.getState().chooseForAll(current);
              close();
            },
            "menuitem",
            "sort-for-all",
          )}
        </>
      )}
    </>
  );
}
