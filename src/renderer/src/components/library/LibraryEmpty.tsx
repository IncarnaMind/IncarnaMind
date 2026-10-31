import { addFilesLabel } from "../../addFilesAction";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { DropLineIcon } from "../lineIcons";
import { buttonStyle } from "../ui";

/**
 * The empty Library: what is missing and the two ways to add it, in place,
 * with the formats that can be added and that files stay where they are.
 * The whole window still takes a drop.
 */
export function LibraryEmpty() {
  const t = useT();
  return (
    <div
      data-testid="library-empty"
      className="mt-6 rounded-[10px] border-[1.5px] border-dashed border-rule-strong px-6 py-12 text-center"
    >
      <DropLineIcon className="mx-auto size-5 text-ink-meta" />
      <p className="mt-3 font-serif text-heading font-semibold text-ink">{t("library.none")}</p>
      <p className="mt-1.5 text-[13px] text-ink-meta">{t("library.none.hint")}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          data-testid="library-empty-add-files"
          onClick={() => void useAppStore.getState().pickDocumentsOrFolder()}
          className={buttonStyle("primary", "sm")}
        >
          {t(addFilesLabel())}
        </button>
        <button
          type="button"
          data-testid="library-empty-link-folder"
          onClick={() => void useAppStore.getState().addLinkedFolder()}
          className={buttonStyle("secondary", "sm")}
        >
          {t("startGuide.documents.linkFolder")}
        </button>
      </div>
      <p className="mt-4 text-[13px] text-ink-meta">{t("library.drop.formats")}</p>
      <p className="text-[13px] text-ink-meta">{t("library.drop.stay")}</p>
    </div>
  );
}
