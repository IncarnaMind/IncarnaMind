import type { ExampleGroup } from "../../../core/api";
import { useT } from "../i18n";
import { allExamples, useAppStore } from "../store";
import { MoreLineIcon } from "./lineIcons";
import { rowActionButtonClass } from "./sidebarRows";
import { menuClass, menuItemClass, menuRuleClass } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

const NONE: readonly ExampleGroup[] = [];

export function ExampleChoices({
  more,
  close,
}: {
  more: readonly ExampleGroup[];
  close: () => void;
}) {
  const t = useT();
  const openExample = useAppStore((state) => state.openExample);
  const removeExamples = useAppStore((state) => state.removeExamples);
  const choose = (action: () => Promise<void>) => () => {
    close();
    void action();
  };
  return (
    <>
      {more.map((group) => (
        <button
          key={group}
          type="button"
          role="menuitem"
          data-testid="example-more-link"
          data-group={group}
          onClick={choose(() => openExample(group))}
          className={`${menuItemClass} pl-2`}
        >
          {t(`examples.group.${group}`)}
        </button>
      ))}
      {more.length > 0 && <div className={menuRuleClass} />}
      <button
        type="button"
        role="menuitem"
        data-testid="examples-remove"
        onClick={choose(removeExamples)}
        className={`${menuItemClass} pl-2`}
      >
        {t("examples.banner.remove")}
      </button>
    </>
  );
}

export function ExamplesMenu() {
  const t = useT();
  const menu = usePopoverMenu({ align: "end" });
  const made = useAppStore((state) => allExamples(state).length > 0);
  const more = useAppStore((state) => allExamples(state)[0]?.more ?? NONE);
  const label = t("folder.more", { name: t("sidebar.examples") });
  if (!made) return null;
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="examples-menu"
        aria-label={label}
        title={label}
        className={rowActionButtonClass}
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={label}
        data-testid="examples-actions"
        className={menuClass}
      >
        {menu.open && <ExampleChoices more={more} close={menu.close} />}
      </div>
    </>
  );
}
