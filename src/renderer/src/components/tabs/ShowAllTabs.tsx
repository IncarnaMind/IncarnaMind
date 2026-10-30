import type { LayoutTab } from "../../../../core/api";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { CheckLineIcon, ChevronDownLineIcon } from "../lineIcons";
import { menuFrameClass, menuItemClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";
import { TabIcon, useTabTitle } from "./tabItems";

/**
 * The ⌄ after "+", shown only while a tab of the strip is hidden (#2244): the shared menu, hanging
 * from the button and right-aligned, lists every tab of the strip in its order, so the list never
 * changes as the window is resized, and choosing one activates it and brings it whole into view.
 */
export function ShowAllTabs({
  tabs,
  shownId,
  hidden,
}: {
  tabs: readonly LayoutTab[];
  shownId: string | null;
  hidden: number;
}) {
  const t = useT();
  const menu = usePopoverMenu({ align: "end" });
  const label = t("tabs.all", { n: hidden });
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="show-all-tabs"
        aria-label={label}
        title={label}
        className="tab-strip-button tab-show-all"
      >
        <ChevronDownLineIcon />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={label}
        data-testid="show-all-tabs-menu"
        className={`${menuFrameClass} w-max max-w-80 min-w-48`}
      >
        {menu.open &&
          tabs.map((tab) => (
            <Row key={tab.id} tab={tab} active={tab.id === shownId} close={menu.close} />
          ))}
      </div>
    </>
  );
}

/** One tab in the list: its icon or status dot, its whole name, and a check while it is the one shown. */
function Row({ tab, active, close }: { tab: LayoutTab; active: boolean; close(): void }) {
  const title = useTabTitle(tab.item);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      data-testid="show-all-tabs-row"
      data-tab-id={tab.id}
      title={title}
      className={`${menuItemClass} pl-2`}
      onClick={() => {
        close();
        void useAppStore.getState().changeLayout({ type: "show", tabId: tab.id });
      }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {active && <CheckLineIcon className="size-4" />}
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-meta [&_svg]:size-3.5">
        <TabIcon item={tab.item} />
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </button>
  );
}
