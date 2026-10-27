import { shortcutLabel } from "../commands/keymap";
import { commands } from "../commands/registry";
import { useFindSources } from "../findSources";
import { useT } from "../i18n";
import { importReferences, useReferenceImport } from "../referenceImport";
import { useAppStore } from "../store";
import { PlugIcon } from "./icons";
import {
  ChevronDownLineIcon,
  DocumentLineIcon,
  FindSourcesLineIcon,
  FolderPlusLineIcon,
  PlusLineIcon,
} from "./lineIcons";
import { buttonStyle, menuClass, menuItemClass, menuRuleClass } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

/**
 * The Library's one primary button, "Add Documents ▾": files from this
 * computer, a folder read where it is, a web page, Find sources (#296), an
 * app to connect, and references from a reference manager (#287). A menu
 * button, its items reached with the arrow keys, as the sidebar's "+" is.
 */
export function AddDocumentsMenu() {
  const t = useT();
  const menu = usePopoverMenu();
  const picking = useAppStore((state) => state.pickingDocuments);
  const importing = useReferenceImport((state) => state.phase === "running");

  /** Closes the menu, then does it. */
  const choose = (action: () => void) => () => {
    menu.close();
    action();
  };
  const report = (error: unknown) => useAppStore.getState().reportError(error);

  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="library-add-documents"
        className={`${buttonStyle("primary")} pr-2.5 pl-2.5`}
      >
        <PlusLineIcon className="size-4" />
        {t("documents.add")}
        <ChevronDownLineIcon className="size-3.5 opacity-80" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("documents.add")}
        data-testid="library-add-documents-items"
        className={menuClass}
      >
        <button
          type="button"
          role="menuitem"
          data-testid="library-add-files"
          disabled={picking}
          onClick={choose(() => void useAppStore.getState().pickDocuments())}
          className={`${menuItemClass} pl-2`}
        >
          <PlusLineIcon className="size-4 shrink-0 text-ink-meta" />
          <span className="flex-1">{t("documents.add.files")}</span>
          <span className="pl-4 text-[13px] text-ink-meta">{shortcutLabel("documents.add")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="library-link-folder"
          onClick={choose(() => void useAppStore.getState().addLinkedFolder())}
          className={`${menuItemClass} pl-2`}
        >
          <FolderPlusLineIcon className="size-4 shrink-0 text-ink-meta" />
          <span className="flex-1">{t("documents.add.linkFolder")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="library-add-web-page"
          onClick={choose(() => void commands.run("webPage.add").catch(report))}
          className={`${menuItemClass} pl-2`}
        >
          <DocumentLineIcon kind="web" className="size-4 shrink-0 text-ink-meta" />
          <span className="flex-1">{t("documents.add.webPage")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="library-find-sources"
          onClick={choose(() => useFindSources.getState().show())}
          className={`${menuItemClass} pl-2`}
        >
          <FindSourcesLineIcon className="size-4 shrink-0 text-ink-meta" />
          <span className="flex-1">{t("documents.add.findSources")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="library-connect-app"
          onClick={choose(() => useAppStore.getState().openSettings("connectors"))}
          className={`${menuItemClass} pl-2`}
        >
          <PlugIcon className="size-4 shrink-0 text-ink-meta" />
          <span className="flex-1">{t("documents.add.connect")}</span>
        </button>
        <div className={menuRuleClass} />
        <button
          type="button"
          role="menuitem"
          data-testid="import-references"
          disabled={importing}
          onClick={choose(() => void importReferences())}
          className={`${menuItemClass} pl-2`}
        >
          <span aria-hidden="true" className="size-4 shrink-0" />
          <span className="flex-1">{t("references.import.menu")}</span>
        </button>
      </div>
    </>
  );
}
