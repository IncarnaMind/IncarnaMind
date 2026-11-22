import type { LinkedFolder } from "../../../core/api";
import { boundPlaceOf } from "../boundFolders";
import { useT } from "../i18n";
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
 * Asks before unlinking a folder, and says what it does and doesn't do: the
 * folder and its files stay as they are on disk, what becomes of the
 * Citations that quote its Documents, and that its Folder keeps its Notes.
 */
export function UnlinkFolderDialog({
  target,
  onClose,
}: {
  target: { linked: LinkedFolder; name: string } | null;
  onClose(): void;
}) {
  const t = useT();
  const dialog = useModal(target !== null);
  const removeLinkedFolder = useAppStore((state) => state.removeLinkedFolder);
  // Its Folder keeps the Notes written there, and the dialog says so (ADR-0030, #3613).
  const keepsNotes = useAppStore((state) => {
    const linked = target?.linked;
    if (!linked) return null;
    const folder = state.library?.groups.find(
      (group) =>
        boundPlaceOf(group, state)?.linked.id === linked.id &&
        state.minds.some((mind) => mind.folderId === group.id),
    );
    return folder?.name ?? null;
  });

  const confirm = () => {
    if (target) void removeLinkedFolder(target.linked.id);
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      data-testid="unlink-folder-dialog"
      aria-labelledby="unlink-folder-title"
      aria-describedby="unlink-folder-body"
      className={`${dialogClass} w-[28rem]`}
    >
      <div className={dialogBodyClass}>
        <h2 id="unlink-folder-title" className={`${dialogTitleClass} break-words`}>
          {t("linkedFolders.unlink.title", { name: target?.name ?? "" })}
        </h2>
        <div id="unlink-folder-body" className="flex flex-col gap-2">
          <p className={dialogTextClass}>{t("linkedFolders.unlink.body")}</p>
          <p className={dialogTextClass}>{t("linkedFolders.unlink.citations")}</p>
          {keepsNotes !== null && (
            <p data-testid="unlink-keeps-notes" className={dialogTextClass}>
              {t("linkedFolders.unlink.notes", { folder: keepsNotes })}
            </p>
          )}
        </div>
        <div className={dialogActionsClass}>
          <button type="button" onClick={onClose} className={buttonClass}>
            {t("linkedFolders.unlink.cancel")}
          </button>
          <button
            type="button"
            data-testid="confirm-unlink-folder"
            onClick={confirm}
            className={dangerButtonClass}
          >
            {t("linkedFolders.unlink.confirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
