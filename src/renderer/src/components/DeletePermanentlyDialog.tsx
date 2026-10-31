import { useRef } from "react";
import type { DeletedItem } from "../../../core/api";
import { lostSentences } from "../deletedItems";
import { useGap, useLanguage, useT } from "../i18n";
import { formatCount } from "../linkedFolders";
import { deletedName, deleteItemsPermanently } from "../recentlyDeleted";
import { useAppStore } from "../store";
import {
  buttonClass,
  dangerButtonClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
} from "./ui";
import { useModal } from "./useModal";

/**
 * The one question Recently deleted asks: before something can't be undone, it
 * says what is lost, and that the User's files stay where they are. Open while
 * `request` is set; `empty` is "Empty Recently deleted".
 */
export function DeletePermanentlyDialog({
  request,
  onClose,
}: {
  request: { items: readonly DeletedItem[]; empty: boolean } | null;
  onClose(): void;
}) {
  const t = useT();
  const gap = useGap();
  const language = useLanguage();
  const dialog = useModal(request !== null);
  // Kept while the dialog closes, so its text doesn't empty out first.
  const shown = useRef(request);
  if (request) shown.current = request;
  const { items, empty } = shown.current ?? { items: [], empty: false };
  const [only] = items;
  const count = formatCount(items.length, language);
  const title = empty
    ? t("deleted.confirm.title.empty")
    : only && items.length === 1
      ? t("deleted.confirm.title.one", { name: deletedName(only) })
      : items.every((item) => item.kind === "document")
        ? t("deleted.confirm.title.documents", { count })
        : t("deleted.confirm.title.items", { count });
  const lost = lostSentences(items, deletedName).map(({ key, params }) => t(key, params));

  const confirm = () => {
    const doomed = request?.items ?? [];
    onClose();
    deleteItemsPermanently(doomed).catch(useAppStore.getState().reportError);
  };

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      data-testid="delete-permanently-dialog"
      role="alertdialog"
      aria-labelledby="delete-permanently-title"
      aria-describedby="delete-permanently-body"
      className={`${dialogClass} w-[26rem]`}
    >
      <div className={dialogBodyClass}>
        <h2 id="delete-permanently-title" className={`${dialogTitleClass} break-words`}>
          {title}
        </h2>
        <p id="delete-permanently-body" className={`${dialogTextClass} break-words`}>
          {[...lost, t("deleted.confirm.foot")].reduce(
            (said, next) => `${said}${gap(said, next)}${next}`,
          )}
        </p>
        <div className={dialogActionsClass}>
          <button type="button" onClick={onClose} className={buttonClass}>
            {t("deleted.confirm.cancel")}
          </button>
          <button
            type="button"
            data-testid="confirm-delete-permanently"
            onClick={confirm}
            className={dangerButtonClass}
          >
            {t(empty ? "deleted.confirm.empty" : "deleted.confirm.delete")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
