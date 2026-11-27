import type { ReactNode } from "react";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { FolderPlusLineIcon, PlusLineIcon } from "./icons";
import { menuClass, menuItemClass } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

/**
 * "Add your Documents" as a menu of the two ways in, Add files… and Link a
 * folder… (#766), in place: never a new Mind or the model setup. Get
 * started's step and the example Mind's banner each spread `buttonProps` on
 * their own button and render `menu`. Its items' test ids start with `testId`.
 */
export function useAddYourDocuments(testId: string): {
  buttonProps: ReturnType<typeof usePopoverMenu>["buttonProps"];
  menu: ReactNode;
} {
  const t = useT();
  const picking = useAppStore((state) => state.pickingDocuments);
  const addMenu = usePopoverMenu({ focus: "first" });
  /** Closes the menu, then does it. */
  const choose = (action: () => void) => () => {
    addMenu.close();
    action();
  };
  const menu = (
    <div
      {...addMenu.menuProps}
      role="menu"
      aria-label={t("gettingStarted.step.documents")}
      data-testid={`${testId}-items`}
      className={menuClass}
    >
      <button
        type="button"
        role="menuitem"
        data-testid={`${testId}-files`}
        disabled={picking}
        onClick={choose(() => void useAppStore.getState().pickDocuments())}
        className={`${menuItemClass} pl-2`}
      >
        <PlusLineIcon className="shrink-0" />
        <span className="flex-1">{t("startGuide.documents.addFiles")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid={`${testId}-link-folder`}
        onClick={choose(() => void useAppStore.getState().addLinkedFolder())}
        className={`${menuItemClass} pl-2`}
      >
        <FolderPlusLineIcon className="shrink-0" />
        <span className="flex-1">{t("startGuide.documents.linkFolder")}</span>
      </button>
    </div>
  );
  return { buttonProps: addMenu.buttonProps, menu };
}
